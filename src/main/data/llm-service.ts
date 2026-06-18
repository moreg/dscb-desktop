import type { SecretStore } from './secret-store'

const MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/text/chatcompletion_v2'
const MINIMAX_MODEL = 'MiniMax-Text-01'

export interface GenerateOptions {
  onToken?: (token: string) => void
  signal?: AbortSignal
}

export class LlmService {
  constructor(private readonly secret: SecretStore) {}

  async generateStream(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const config = await this.secret.read()
    const apiKey = config.providers.minimax?.apiKey
    if (!apiKey) throw new Error('MiniMax API key not configured')

    const res = await fetch(MINIMAX_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
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

    return parseSse(res.body as ReadableStream<Uint8Array>, opts.onToken)
  }
}

async function parseSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
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
          onToken?.(token)
        }
      } catch {
        // skip malformed chunk
      }
    }
  }
  return full
}
