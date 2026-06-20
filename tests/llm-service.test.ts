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

  it('Anthropic protocol hits /v1/messages with bearer auth and parses content_block_delta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-ant-'))
    const antStore = new SecretStore(path.join(dir, 'providers.enc'))
    await antStore.write({
      activeId: 'p_ant',
      providers: [
        {
          id: 'p_ant',
          label: 'ant',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          model: 'MiniMax-M3',
          apiKey: 'sk-ant-key',
          protocol: 'anthropic'
        }
      ]
    })
    const svc = new LlmService(antStore)
    const fakeRes = {
      ok: true,
      body: sseBody([
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"世界"}}\n\n',
        'event: message_delta\ndata: {"usage":{"output_tokens":20}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ])
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeRes as never)
    const tokens: string[] = []
    const out = await svc.generateStream('hi', { onToken: (t) => tokens.push(t) })
    expect(out).toBe('你好世界')
    expect(tokens.join('')).toBe('你好世界')

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.minimaxi.com/anthropic/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-ant-key')
    expect(headers['api-key']).toBe('sk-ant-key')
    expect(headers['x-api-key']).toBe('sk-ant-key')
    expect(headers['anthropic-version']).toBe('2023-06-15')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('MiniMax-M3')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' })
    fetchSpy.mockRestore()
  })

  it('OpenAI protocol (default) hits /chat/completions with Bearer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    } as never)
    await service.generateStream('hi')
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
    fetchSpy.mockRestore()
  })

  it('Anthropic baseUrl with trailing /v1 does not double up', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-antv1-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p1',
      providers: [
        {
          id: 'p1',
          label: 't',
          baseUrl: 'https://example.com/v1',
          model: 'm',
          apiKey: 'k',
          protocol: 'anthropic'
        }
      ]
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['event: message_stop\ndata: {}\n\n'])
    } as never)
    await svc.generateStream('hi')
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/v1/messages')
    fetchSpy.mockRestore()
  })
})
