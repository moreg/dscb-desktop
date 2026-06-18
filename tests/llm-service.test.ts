import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) =>
      Buffer.from(`<enc>${Buffer.from(plain, 'utf8').toString('hex')}</enc>`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      const hex = s.replace(/^<enc>/, '').replace(/<\/enc>$/, '')
      return Buffer.from(hex, 'hex').toString('utf8')
    }
  }
}))

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
}

describe('LlmService', () => {
  let store: SecretStore
  let service: LlmService
  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-'))
    store = new SecretStore(path.join(dir, 'providers.enc'))
    await store.write({ activeProvider: 'minimax', providers: { minimax: { apiKey: 'sk-test' } } })
    service = new LlmService(store)
  })

  it('streams tokens from SSE delta content', async () => {
    const fakeRes = {
      ok: true,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeRes as never)
    const tokens: string[] = []
    await service.generateStream('hi', { onToken: (t) => tokens.push(t) })
    expect(tokens.join('')).toBe('你好世界')
    fetchSpy.mockRestore()
  })

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauth'
    } as never)
    await expect(service.generateStream('hi')).rejects.toThrow(/LLM_AUTH_FAILED/)
  })
})
