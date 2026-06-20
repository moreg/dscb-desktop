import type { SecretStore } from './secret-store'
import type { ProviderConfig } from '../../shared/types'
import type { UsageRepository } from './usage-repository'

export interface GenerateOptions {
  onToken?: (token: string) => void
  signal?: AbortSignal
  /** 调用方上下文，用于用量归属 */
  meta?: { feature: string; projectId?: string }
}

interface UsageInfo {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

function protocolOf(p: ProviderConfig): 'openai' | 'anthropic' {
  return p.protocol ?? 'openai'
}

function endpointOf(p: ProviderConfig): string {
  const base = p.baseUrl.replace(/\/+$/, '')
  if (protocolOf(p) === 'anthropic') {
    // Anthropic Messages API：baseUrl 结尾应为不带 /v1 的根，统一补 /v1/messages
    const hasV1 = base.endsWith('/v1')
    const v1Root = hasV1 ? base : `${base}/v1`
    return `${v1Root}/messages`
  }
  return `${base}/chat/completions`
}

export class LlmService {
  constructor(
    private readonly secret: SecretStore,
    private readonly usage?: UsageRepository
  ) {}

  private async activeProvider(): Promise<ProviderConfig | null> {
    const cfg = await this.secret.read()
    const p = cfg.providers.find((x) => x.id === cfg.activeId)
    if (!p) return null
    return p
  }

  /** 轻量连通测试：发送 1 token 的请求，成功即返回模型名 */
  async ping(): Promise<{ ok: boolean; error?: string; model?: string; providerLabel?: string }> {
    const p = await this.activeProvider()
    if (!p) return { ok: false, error: 'NO_KEY' }
    if (!p.apiKey) return { ok: false, error: 'NO_KEY' }
    try {
      const { url, init } = buildPingRequest(p)
      const res = await fetch(url, init)
      if (res.status === 401 || res.status === 403)
        return { ok: false, error: 'LLM_AUTH_FAILED' }
      if (res.status === 429) return { ok: false, error: 'LLM_RATE_LIMIT' }
      if (!res.ok) return { ok: false, error: 'LLM_REQUEST_FAILED' }
      return { ok: true, model: p.model, providerLabel: p.label }
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'NETWORK_ERROR' }
    }
  }

  async generateStream(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const p = await this.activeProvider()
    if (!p || !p.apiKey) throw new Error('LLM_NOT_CONFIGURED')

    const { url, init } = buildStreamRequest(p, prompt, opts.signal)
    const res = await fetch(url, init)

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('LLM_AUTH_FAILED')
      if (res.status === 429) throw new Error('LLM_RATE_LIMIT')
      throw new Error('LLM_REQUEST_FAILED')
    }

    const proto = protocolOf(p)
    const { full, usage } =
      proto === 'anthropic'
        ? await parseAnthropicSse(res.body as ReadableStream<Uint8Array>, opts.onToken)
        : await parseOpenAiSse(res.body as ReadableStream<Uint8Array>, opts.onToken)

    if (this.usage && usage) {
      try {
        await this.usage.add({
          at: new Date().toISOString(),
          feature: opts.meta?.feature ?? 'other',
          projectId: opts.meta?.projectId,
          model: p.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens
        })
      } catch {
        // 用量记录失败不影响主流程
      }
    }
    return full
  }
}

/* =========================================================
   请求构造：按协议分流
   ========================================================= */

function buildPingRequest(p: ProviderConfig): { url: string; init: RequestInit } {
  const url = endpointOf(p)
  if (protocolOf(p) === 'anthropic') {
    return {
      url,
      init: {
        method: 'POST',
        headers: anthropicHeaders(p.apiKey),
        body: JSON.stringify({
          model: p.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      }
    }
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      })
    }
  }
}

function buildStreamRequest(
  p: ProviderConfig,
  prompt: string,
  signal?: AbortSignal
): { url: string; init: RequestInit } {
  const url = endpointOf(p)
  const init: RequestInit = { method: 'POST', signal }
  if (protocolOf(p) === 'anthropic') {
    init.headers = anthropicHeaders(p.apiKey)
    init.body = JSON.stringify({
      model: p.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  } else {
    init.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`
    }
    init.body = JSON.stringify({
      model: p.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  }
  return { url, init }
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-15',
    'anthropic-dangerous-direct-browser-access': 'true'
  }
}

/* =========================================================
   SSE 解析：OpenAI / Anthropic 两种格式
   ========================================================= */

async function parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<{ full: string; usage: UsageInfo | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let usage: UsageInfo | null = null
  const MAX = 200_000
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        const token = json.choices?.[0]?.delta?.content
        if (token) {
          full += token
          if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
          onToken?.(token)
        }
        const u = json.usage
        if (u && typeof u === 'object') {
          usage = {
            inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
            outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
            totalTokens: Number(u.total_tokens ?? 0) || 0
          }
        }
      } catch {
        // skip malformed chunk
      }
    }
  }
  if (!usage) {
    const out = Math.ceil(full.length / 1.5)
    usage = { inputTokens: 0, outputTokens: out, totalTokens: out }
  }
  return { full, usage }
}

/**
 * Anthropic Messages API 流式事件格式：
 *   event: message_start     data: { message: { usage: { input_tokens, output_tokens } } }
 *   event: content_block_start
 *   event: content_block_delta data: { delta: { type: 'text_delta', text: '...' } }
 *   event: content_block_stop
 *   event: message_delta     data: { usage: { output_tokens } }
 *   event: message_stop
 */
async function parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<{ full: string; usage: UsageInfo | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let inputTokens = 0
  let outputTokens = 0
  const MAX = 200_000

  const flushEvent = (eventLines: string[]): void => {
    if (eventLines.length === 0) return
    let eventName = ''
    const dataLines: string[] = []
    for (const line of eventLines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    const dataStr = dataLines.join('\n')
    if (!dataStr) return
    let json: Record<string, unknown>
    try {
      json = JSON.parse(dataStr)
    } catch {
      return
    }
    // token 文本：content_block_delta.delta.text
    if (eventName === 'content_block_delta') {
      const delta = json.delta as { text?: string } | undefined
      const token = delta?.text
      if (token) {
        full += token
        if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
        onToken?.(token)
      }
    }
    // 用量：message_start 拿 input_tokens；message_delta 累加 output_tokens
    if (eventName === 'message_start') {
      const msg = json.message as { usage?: { input_tokens?: number } } | undefined
      inputTokens = Number(msg?.usage?.input_tokens ?? 0) || 0
    }
    if (eventName === 'message_delta') {
      const u = json.usage as { output_tokens?: number } | undefined
      outputTokens = Number(u?.output_tokens ?? 0) || outputTokens
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Anthropic 用 \r\n\r\n 分隔 event
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const ev of events) {
      const lines = ev.split(/\r?\n/).filter(Boolean)
      flushEvent(lines)
    }
  }
  // 残留 buffer 也尝试 flush
  if (buffer.trim()) flushEvent(buffer.split(/\r?\n/).filter(Boolean))

  const usage: UsageInfo | null =
    inputTokens > 0 || outputTokens > 0
      ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
      : {
          inputTokens: 0,
          outputTokens: Math.ceil(full.length / 1.5),
          totalTokens: Math.ceil(full.length / 1.5)
        }
  return { full, usage }
}