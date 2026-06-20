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

export class LlmService {
  constructor(
    private readonly secret: SecretStore,
    private readonly usage?: UsageRepository
  ) {}

  /** 读取当前 active provider（无 key 时返回 null） */
  private async activeProvider(): Promise<ProviderConfig | null> {
    const cfg = await this.secret.read()
    const p = cfg.providers.find((x) => x.id === cfg.activeId)
    if (!p) return null
    return p
  }

  /** 把 baseUrl 归一化为根 URL（去掉末尾 /） */
  private endpointOf(p: ProviderConfig): string {
    const base = p.baseUrl.replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  /** 轻量连通测试：发送 1 token 的请求，成功即返回模型名 */
  async ping(): Promise<{ ok: boolean; error?: string; model?: string; providerLabel?: string }> {
    const p = await this.activeProvider()
    if (!p) return { ok: false, error: 'NO_KEY' }
    if (!p.apiKey) return { ok: false, error: 'NO_KEY' }
    try {
      const res = await fetch(this.endpointOf(p), {
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
      })
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

    const res = await fetch(this.endpointOf(p), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true
      }),
      signal: opts.signal
    })

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('LLM_AUTH_FAILED')
      if (res.status === 429) throw new Error('LLM_RATE_LIMIT')
      throw new Error('LLM_REQUEST_FAILED')
    }

    const { full, usage } = await parseSse(res.body as ReadableStream<Uint8Array>, opts.onToken)
    // 记录用量（失败不阻塞）
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

async function parseSse(
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
        // 捕获 token 文本
        const token = json.choices?.[0]?.delta?.content
        if (token) {
          full += token
          if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
          onToken?.(token)
        }
        // 捕获用量（通常出现在末尾 chunk）
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
  // 若流式未给 usage，用 full 长度粗估输出 token
  if (!usage) {
    const out = Math.ceil(full.length / 1.5)
    usage = { inputTokens: 0, outputTokens: out, totalTokens: out }
  }
  return { full, usage }
}
