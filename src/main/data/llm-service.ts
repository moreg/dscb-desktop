import type { SecretStore } from './secret-store'
import type { ProviderConfig } from '../../shared/types'
import type { UsageRepository } from './usage-repository'

export interface GenerateOptions {
  onToken?: (token: string) => void
  signal?: AbortSignal
  /** 调用方上下文，用于用量归属 */
  meta?: { feature: string; projectId?: string; chapterNumber?: number }
  /**
   * 可选 system prompt。
   * - OpenAI 协议：作为 messages 数组首项 { role: 'system', content }
   * - Anthropic 协议：作为请求体顶层 system 字段
   * 未提供时退化为旧行为（仅 user 单条消息）。
   */
  systemPrompt?: string
  /** 临时续写上下文指导语 */
  tempContext?: string
  /** 本章已写正文前部（续写用） */
  existingText?: string

  /**
   * 生成上限 token 数。
   * - 不传时使用 DEFAULT_MAX_TOKENS
   * - 中文约 1 字 ≈ 1.5~2 token，章节目标字数需换算后留足空间，否则会被物理截断
   */
  maxTokens?: number
}

interface UsageInfo {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

function protocolOf(p: ProviderConfig): 'openai' | 'anthropic' {
  return p.protocol ?? 'openai'
}

/**
 * 默认单次生成上限（token）。
 * 中文约 1 字 ≈ 1.5~2 token；典型章节 2500~4000 字需约 8192 token 才不会被截断。
 * 旧值 4096 只够 ~2000 字，导致"提示词要 2500 字但写不够/突然断尾"。
 * 调用方可用 GenerateOptions.maxTokens 按目标字数动态覆盖（见 write-service）。
 */
const DEFAULT_MAX_TOKENS = 8192

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

const LLM_STREAM_TIMEOUT_MS = 120_000

function isRetryableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('terminated') ||
    msg.includes('aborted') ||
    msg.includes('socket') ||
    msg.includes('connection') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    (err instanceof TypeError && msg.includes('fetch'))
  )
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
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
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
      if (res.status === 401 || res.status === 403)
        return { ok: false, error: 'LLM_AUTH_FAILED' }
      if (res.status === 429) return { ok: false, error: 'LLM_RATE_LIMIT' }
      if (!res.ok) return { ok: false, error: 'LLM_REQUEST_FAILED' }
      return { ok: true, model: p.model, providerLabel: p.label }
    } catch (err) {
      if (isAbortError(err)) return { ok: false, error: 'LLM_TIMEOUT' }
      return { ok: false, error: (err as Error).message || 'NETWORK_ERROR' }
    }
  }

  async generateStream(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const p = await this.activeProvider()
    if (!p || !p.apiKey) throw new Error('LLM_NOT_CONFIGURED')

    const MAX_RETRIES = 2
    const RETRY_DELAYS_MS = [1000, 2000]
    let hasReceivedTokens = false
    const wrappedOnToken = opts.onToken
      ? (token: string) => {
          hasReceivedTokens = true
          opts.onToken!(token)
        }
      : undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timeoutSignal = AbortSignal.timeout(LLM_STREAM_TIMEOUT_MS)
        const combinedSignal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal

        const { url, init } = buildStreamRequest(
          p,
          prompt,
          combinedSignal,
          opts.systemPrompt,
          opts.maxTokens
        )
        const res = await fetch(url, init)

        if (!res.ok) {
          if (res.status === 401 || res.status === 403) throw new Error('LLM_AUTH_FAILED')
          if (res.status === 429) throw new Error('LLM_RATE_LIMIT')
          if (res.status >= 500 && attempt < MAX_RETRIES && !hasReceivedTokens) {
            console.warn(`[llm-service] Server error ${res.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`)
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
            continue
          }
          throw new Error(`LLM_REQUEST_FAILED_${res.status}`)
        }

        const proto = protocolOf(p)
        const { full, usage } =
          proto === 'anthropic'
            ? await parseAnthropicSse(res.body as ReadableStream<Uint8Array>, wrappedOnToken)
            : await parseOpenAiSse(res.body as ReadableStream<Uint8Array>, wrappedOnToken)

        if (this.usage && usage) {
          try {
            await this.usage.add({
              at: new Date().toISOString(),
              feature: opts.meta?.feature ?? 'other',
              projectId: opts.meta?.projectId,
              chapterNumber: opts.meta?.chapterNumber,
              model: p.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens
            })
          } catch (err) {
            console.error('[llm-service] Failed to record usage:', err)
          }
        }
        return full
      } catch (err) {
        if (isAbortError(err)) {
          if (opts.signal?.aborted) throw err
          throw new Error(hasReceivedTokens ? 'LLM_OUTPUT_TRUNCATED' : 'LLM_TIMEOUT')
        }
        if (!hasReceivedTokens && isRetryableStreamError(err) && attempt < MAX_RETRIES) {
          console.warn(`[llm-service] Stream error (${(err as Error).message}), retrying in ${RETRY_DELAYS_MS[attempt]}ms...`)
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
          continue
        }
        if (hasReceivedTokens && isRetryableStreamError(err)) {
          throw new Error('LLM_OUTPUT_TRUNCATED')
        }
        throw err
      }
    }
    throw new Error('LLM_REQUEST_FAILED')
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
  signal?: AbortSignal,
  systemPrompt?: string,
  maxTokens?: number
): { url: string; init: RequestInit } {
  const url = endpointOf(p)
  const init: RequestInit = { method: 'POST', signal }
  const hasSystem = !!systemPrompt && systemPrompt.trim().length > 0
  // 单次生成上限。中文 1 字 ≈ 1.5~2 token；章节正文约 2500~4000 字，需 8192 才不致截断。
  const cap = maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS
  // 采样温度：仅在 provider 显式配置时透传，否则走模型默认
  const hasTemp = typeof p.temperature === 'number' && Number.isFinite(p.temperature)
  if (protocolOf(p) === 'anthropic') {
    init.headers = anthropicHeaders(p.apiKey)
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: cap,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    }
    if (hasSystem) body.system = systemPrompt
    if (hasTemp) body.temperature = p.temperature
    init.body = JSON.stringify(body)
  } else {
    init.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`
    }
    const messages: Array<{ role: string; content: string }> = []
    if (hasSystem) messages.push({ role: 'system', content: systemPrompt as string })
    messages.push({ role: 'user', content: prompt })
    const body: Record<string, unknown> = {
      model: p.model,
      messages,
      max_tokens: cap,
      stream: true
    }
    if (hasTemp) body.temperature = p.temperature
    init.body = JSON.stringify(body)
  }
  return { url, init }
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'api-key': apiKey,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-15'
  }
}

/* =========================================================
   SSE 解析：OpenAI / Anthropic 两种格式
   ========================================================= */

/**
 * LLM 响应最大字符数。
 * 防止恶意或错误的 LLM 响应导致内存耗尽。
 * 基于典型章节长度（约 5000 字符）的 40 倍安全边际。
 */
const MAX_RESPONSE_CHARS = 200_000

async function parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<{ full: string; usage: UsageInfo | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let usage: UsageInfo | null = null
  let finishReason = ''
  const MAX = MAX_RESPONSE_CHARS
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
        const choice = json.choices?.[0]
        const token = choice?.delta?.content
        if (token) {
          full += token
          if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
          onToken?.(token)
        }
        if (choice?.finish_reason) finishReason = String(choice.finish_reason)
        const u = json.usage
        if (u && typeof u === 'object') {
          usage = {
            inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
            outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
            totalTokens: Number(u.total_tokens ?? 0) || 0
          }
        }
      } catch (err) {
        console.warn('[llm-service] Failed to parse SSE chunk:', data.substring(0, 100), err)
        // skip malformed chunk
      }
    }
  }
  if (finishReason === 'length') throw new Error('LLM_OUTPUT_TRUNCATED')
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
  let stopReason = ''
  const MAX = MAX_RESPONSE_CHARS

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
    } catch (err) {
      console.warn('[llm-service] Failed to parse Anthropic SSE event:', dataStr.substring(0, 100), err)
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
      const reason = json.stop_reason
      if (reason) stopReason = String(reason)
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

  if (stopReason === 'max_tokens') throw new Error('LLM_OUTPUT_TRUNCATED')

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
