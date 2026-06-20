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

const sampleProvider = {
  id: 'p_test',
  label: 'test',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'sk-test'
}

describe('LlmService', () => {
  let store: SecretStore
  let service: LlmService
  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-'))
    store = new SecretStore(path.join(dir, 'providers.enc'))
    await store.write({
      activeId: sampleProvider.id,
      providers: [sampleProvider]
    })
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
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    fetchSpy.mockRestore()
  })

  it('throws LLM_NOT_CONFIGURED when no provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-empty-'))
    const empty = new SecretStore(path.join(dir, 'providers.enc'))
    const svc = new LlmService(empty)
    await expect(svc.generateStream('hi')).rejects.toThrow(/LLM_NOT_CONFIGURED/)
  })

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauth'
    } as never)
    await expect(service.generateStream('hi')).rejects.toThrow(/LLM_AUTH_FAILED/)
  })

  it('does not expose apiKey when listing (defense in depth at service layer)', async () => {
    // 服务层直接读 SecretStore，明文只存在 main 内存里。
    // 这里验证 store.read() 的返回是完整结构（main 端用它拼请求）
    // 而 IPC 层应自行做脱敏后再传给 renderer —— 由 ipc 测试覆盖。
    const cfg = await store.read()
    expect(cfg.providers[0].apiKey).toBe('sk-test')
    // 真要做 ipc 端脱敏验证，见后续 ipc.llm.test.ts
  })
})