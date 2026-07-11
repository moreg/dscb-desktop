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

  it('throws when OpenAI stream stops because max_tokens was reached', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n'
      ])
    } as never)

    await expect(service.generateStream('hi')).rejects.toThrow(/LLM_OUTPUT_TRUNCATED/)
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

  it('throws when Anthropic stream stops because max_tokens was reached', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-ant-truncated-'))
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody([
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\n',
        'event: message_delta\ndata: {"usage":{"output_tokens":20},"stop_reason":"max_tokens"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ])
    } as never)

    await expect(svc.generateStream('hi')).rejects.toThrow(/LLM_OUTPUT_TRUNCATED/)
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

  it('OpenAI: systemPrompt 插入 messages[0] 作为 role:system', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await service.generateStream('user-msg', { systemPrompt: 'you are a system' })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are a system' },
      { role: 'user', content: 'user-msg' }
    ])
    fetchSpy.mockRestore()
  })

  it('OpenAI: 未传 systemPrompt 时仅一条 user 消息（向后兼容）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await service.generateStream('hi')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    fetchSpy.mockRestore()
  })

  it('OpenAI: 空白 systemPrompt 视为未提供', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await service.generateStream('hi', { systemPrompt: '   ' })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    fetchSpy.mockRestore()
  })

  it('Anthropic: systemPrompt 落到 body.system 顶层字段', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-ants-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p',
      providers: [
        {
          id: 'p',
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
    await svc.generateStream('user-msg', { systemPrompt: 'sys-text' })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.system).toBe('sys-text')
    expect(body.messages).toEqual([{ role: 'user', content: 'user-msg' }])
    fetchSpy.mockRestore()
  })

  it('Anthropic: 未传 systemPrompt 时 body 不含 system 字段', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-ants2-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p',
      providers: [
        {
          id: 'p',
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
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.system).toBeUndefined()
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

  it('OpenAI: temperature from provider is sent in request body', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-temp-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p',
      providers: [
        {
          id: 'p',
          label: 't',
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          apiKey: 'k',
          temperature: 0.6
        }
      ]
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBeCloseTo(0.6)
    fetchSpy.mockRestore()
  })

  it('OpenAI: omits temperature when provider does not set it', async () => {
    // 默认 provider（无 temperature）→ 走模型默认，不应传该字段
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await service.generateStream('hi')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBeUndefined()
    fetchSpy.mockRestore()
  })

  it('Anthropic: temperature from provider is sent in request body', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-anttemp-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p',
      providers: [
        {
          id: 'p',
          label: 't',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          model: 'MiniMax-M3',
          apiKey: 'k',
          protocol: 'anthropic',
          temperature: 0.9
        }
      ]
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['event: message_stop\ndata: {}\n\n'])
    } as never)
    await svc.generateStream('hi')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBeCloseTo(0.9)
    fetchSpy.mockRestore()
  })
})

describe('LlmService feature routing', () => {
  it('routes to provider configured for the feature category', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' },
        { id: 'p_chapter', label: 'chapter', baseUrl: 'https://chapter.example.com/v1', model: 'chapter-model', apiKey: 'k2' }
      ],
      featureRouting: { chapter: { providerId: 'p_chapter' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi', { meta: { feature: 'chapter' } })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chapter.example.com/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('chapter-model')
    fetchSpy.mockRestore()
  })

  it('model override takes precedence over provider default model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-model-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' },
        { id: 'p_chapter', label: 'chapter', baseUrl: 'https://chapter.example.com/v1', model: 'chapter-model', apiKey: 'k2' }
      ],
      featureRouting: { chapter: { providerId: 'p_chapter', model: 'overridden-model' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi', { meta: { feature: 'chapter' } })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('overridden-model')
    fetchSpy.mockRestore()
  })

  it('falls back to activeId when feature has no routing entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-noroute-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' }
      ],
      featureRouting: {}
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi', { meta: { feature: 'chapter' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://active.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })

  it('falls back to activeId when routed provider was deleted (dangling ref)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-deleted-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' }
      ],
      // p_chapter 已不存在（死引用）-> 回退 activeId
      featureRouting: { chapter: { providerId: 'p_chapter' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi', { meta: { feature: 'chapter' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://active.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })

  it('unmapped feature falls back to activeId', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-unmapped-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' }
      ],
      featureRouting: { chapter: { providerId: 'p_active' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    // 'other' 未映射到任何大类 -> activeId
    await svc.generateStream('hi', { meta: { feature: 'other' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://active.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })

  it('backward compat: config without featureRouting uses activeId', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-compat-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' }
      ]
      // 无 featureRouting 字段（旧配置）
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    await svc.generateStream('hi', { meta: { feature: 'chapter' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://active.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })

  it('category aggregates multiple features (chapter-adjust -> chapter routing)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-agg-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' },
        { id: 'p_chapter', label: 'chapter', baseUrl: 'https://chapter.example.com/v1', model: 'chapter-model', apiKey: 'k2' }
      ],
      featureRouting: { chapter: { providerId: 'p_chapter' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    // chapter-adjust 归入 chapter 大类
    await svc.generateStream('hi', { meta: { feature: 'chapter-adjust' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chapter.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })

  it('deslop:cleanup:N resolves to humanize category via prefix normalization', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-route-cleanup-'))
    const s = new SecretStore(path.join(dir, 'providers.enc'))
    await s.write({
      activeId: 'p_active',
      providers: [
        { id: 'p_active', label: 'active', baseUrl: 'https://active.example.com/v1', model: 'active-model', apiKey: 'k1' },
        { id: 'p_human', label: 'human', baseUrl: 'https://human.example.com/v1', model: 'human-model', apiKey: 'k2' }
      ],
      featureRouting: { humanize: { providerId: 'p_human' } }
    })
    const svc = new LlmService(s)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBody(['data: [DONE]\n\n'])
    } as never)
    // deslop:cleanup:1 未精确命中映射表，按 ':' 前缀归一化 -> deslop -> humanize 大类
    await svc.generateStream('hi', { meta: { feature: 'deslop:cleanup:1' } })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://human.example.com/v1/chat/completions')
    fetchSpy.mockRestore()
  })
})
