import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const { SecretStore } = await import('../src/main/data/secret-store')
const { registerLlmIpc } = await import('../src/main/ipc/llm')
const { LlmService } = await import('../src/main/data/llm-service')

// Test API key placeholder - never use real credentials in tests
const TEST_API_KEY = 'test-api-key-placeholder'

/** 模拟 ipcMain.handle 注册的 handler 池 */
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron')
  return {
    ...actual,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) =>
        Buffer.from(`<enc>${Buffer.from(plain, 'utf8').toString('hex')}</enc>`, 'utf8'),
      decryptString: (buf: Buffer) => {
        const s = buf.toString('utf8')
        const hex = s.replace(/^<enc>/, '').replace(/<\/enc>$/, '')
        return Buffer.from(hex, 'hex').toString('utf8')
      }
    },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn)
      }
    },
    BrowserWindow: { fromWebContents: () => null }
  }
})

describe('registerLlmIpc handlers', () => {
  let store: InstanceType<typeof SecretStore>
  let service: InstanceType<typeof LlmService>
  beforeEach(async () => {
    handlers.clear()
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-llm-ipc-'))
    store = new SecretStore(path.join(dir, 'providers.enc'))
    await store.write({ activeId: '', providers: [] })
    service = new LlmService(store)
    registerLlmIpc(store, service)
  })

  it('llm:listProviders returns masked key, never plaintext', async () => {
    await store.write({
      activeId: 'p1',
      providers: [
        {
          id: 'p1',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          apiKey: TEST_API_KEY
        }
      ]
    })
    const handler = handlers.get('llm:listProviders')
    expect(handler).toBeDefined()
    const out = (await handler!(null)) as {
      activeId: string
      providers: Array<{ hasKey: boolean; keyMasked: string; apiKey?: string }>
    }
    expect(out.activeId).toBe('p1')
    expect(out.providers[0].hasKey).toBe(true)
    expect(out.providers[0].keyMasked).toBe('test••••lder')
    // apiKey 字段必须不存在
    expect(out.providers[0].apiKey).toBeUndefined()
    // 整个对象序列化后也不应含明文
    expect(JSON.stringify(out)).not.toContain(TEST_API_KEY)
  })

  it('llm:upsertProvider sanitizes payload (rejects invalid url)', async () => {
    const handler = handlers.get('llm:upsertProvider')
    expect(handler).toBeDefined()
    await expect(
      handler!(null, {
        id: 'p2',
        label: 'bad',
        baseUrl: 'not-a-url',
        model: 'm',
        apiKey: TEST_API_KEY
      })
    ).rejects.toThrow(/PROVIDER_INVALID/)
  })

  it('llm:upsertProvider accepts protocol=anthropic and stores it', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_ant',
      label: 'minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M3',
      apiKey: TEST_API_KEY,
      protocol: 'anthropic'
    })
    const cfg = await store.read()
    expect(cfg.providers[0].protocol).toBe('anthropic')
  })

  it('llm:upsertProvider defaults protocol to openai when omitted', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_oa',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: TEST_API_KEY
    })
    const cfg = await store.read()
    expect(cfg.providers[0].protocol).toBe('openai')
  })

  it('llm:upsertProvider coerces unknown protocol value to openai', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_x',
      label: 'x',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      protocol: 'mystery-protocol'
    })
    const cfg = await store.read()
    expect(cfg.providers[0].protocol).toBe('openai')
  })

  it('llm:upsertProvider sanitizes payload (rejects non-http scheme)', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await expect(
      handler!(null, {
        id: 'p2',
        label: 'bad',
        baseUrl: 'ftp://example.com/v1',
        model: 'm',
        apiKey: TEST_API_KEY
      })
    ).rejects.toThrow(/PROVIDER_INVALID/)
  })

  it('llm:upsertProvider trims trailing slashes', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p2',
      label: 'trim',
      baseUrl: 'https://api.example.com/v1///',
      model: 'm',
      apiKey: TEST_API_KEY
    })
    const cfg = await store.read()
    expect(cfg.providers[0].baseUrl).toBe('https://api.example.com/v1')
  })

  it('llm:upsertProvider preserves existing apiKey when new is empty', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p3',
      label: 'first',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: TEST_API_KEY
    })
    // 第二次更新只改 label / model，apiKey 留空
    await handler!(null, {
      id: 'p3',
      label: 'renamed',
      baseUrl: 'https://api.example.com/v1',
      model: 'm2',
      apiKey: ''
    })
    const cfg = await store.read()
    expect(cfg.providers[0].apiKey).toBe(TEST_API_KEY)
    expect(cfg.providers[0].label).toBe('renamed')
    expect(cfg.providers[0].model).toBe('m2')
  })

  it('llm:deleteProvider clears activeId when deleting active', async () => {
    await store.write({
      activeId: 'p1',
      providers: [
        { id: 'p1', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: TEST_API_KEY },
        { id: 'p2', label: 'B', baseUrl: 'https://b.example.com/v1', model: 'm', apiKey: TEST_API_KEY }
      ]
    })
    const handler = handlers.get('llm:deleteProvider')
    await handler!(null, 'p1')
    const cfg = await store.read()
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.activeId).toBe('p2')
  })

  it('llm:setActive throws PROVIDER_NOT_FOUND for unknown id', async () => {
    const handler = handlers.get('llm:setActive')
    await expect(handler!(null, 'nope')).rejects.toThrow(/PROVIDER_NOT_FOUND/)
  })

  it('llm:setActive updates activeId on success', async () => {
    await store.write({
      activeId: 'p1',
      providers: [
        { id: 'p1', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: TEST_API_KEY },
        { id: 'p2', label: 'B', baseUrl: 'https://b.example.com/v1', model: 'm', apiKey: TEST_API_KEY }
      ]
    })
    const handler = handlers.get('llm:setActive')
    const result = await handler!(null, 'p2')
    expect(result).toBe('p2')
    const cfg = await store.read()
    expect(cfg.activeId).toBe('p2')
  })

  it('llm:upsertProvider stores temperature when provided', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_t',
      label: 't',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      temperature: 0.8
    })
    const cfg = await store.read()
    expect(cfg.providers[0].temperature).toBeCloseTo(0.8)
  })

  it('llm:upsertProvider clamps temperature to [0,2]', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_hi',
      label: 'hi',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      temperature: 99
    })
    const cfg = await store.read()
    expect(cfg.providers[0].temperature).toBe(2)

    // 负数同样被 clamp 到 0
    await handler!(null, {
      id: 'p_lo',
      label: 'lo',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      temperature: -5
    })
    const cfg2 = await store.read()
    expect(cfg2.providers.find((p) => p.id === 'p_lo')!.temperature).toBe(0)
  })

  it('llm:upsertProvider drops non-numeric temperature (keeps model default)', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_bad',
      label: 'bad',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      temperature: 'hot'
    })
    const cfg = await store.read()
    expect(cfg.providers[0].temperature).toBeUndefined()
  })

  it('llm:listProviders returns temperature in summary', async () => {
    await store.write({
      activeId: 'p1',
      providers: [
        {
          id: 'p1',
          label: 'A',
          baseUrl: 'https://a.example.com/v1',
          model: 'm',
          apiKey: TEST_API_KEY,
          temperature: 0.7
        }
      ]
    })
    const handler = handlers.get('llm:listProviders')
    const out = (await handler!(null)) as { providers: Array<{ temperature?: number }> }
    expect(out.providers[0].temperature).toBeCloseTo(0.7)
  })

  it('llm:upsertProvider preserves temperature via apiKey-empty update path', async () => {
    // 编辑（apiKey 传空保留旧 key）时，新 temperature 应覆盖旧值
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_e',
      label: 'e',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: TEST_API_KEY,
      temperature: 0.5
    })
    // 第二次只改温度，apiKey 留空
    await handler!(null, {
      id: 'p_e',
      label: 'e',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: '',
      temperature: 1.1
    })
    const cfg = await store.read()
    const p = cfg.providers[0]
    expect(p.apiKey).toBe(TEST_API_KEY) // 旧 key 保留
    expect(p.temperature).toBeCloseTo(1.1) // 新温度生效
  })

  /* ---- antigravity 协议（agy CLI）---- */

  it('llm:upsertProvider accepts antigravity protocol without baseUrl/apiKey', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_agy',
      label: 'agy 主力',
      baseUrl: '',
      model: '',
      apiKey: '',
      protocol: 'antigravity'
    })
    const cfg = await store.read()
    const p = cfg.providers[0]
    expect(p.protocol).toBe('antigravity')
    expect(p.apiKey).toBe('') // agy 不需要 key
    expect(p.model).toBe('default') // 空 model 被填充为 default
    expect(p.baseUrl).toBe('antigravity://local')
  })

  it('llm:listProviders reports antigravity provider as hasKey=true', async () => {
    await store.write({
      activeId: 'p_agy',
      providers: [
        {
          id: 'p_agy',
          label: 'agy',
          baseUrl: 'antigravity://local',
          model: 'default',
          apiKey: '',
          protocol: 'antigravity'
        }
      ]
    })
    const handler = handlers.get('llm:listProviders')
    const out = (await handler!(null)) as {
      providers: Array<{ hasKey: boolean; keyMasked: string; protocol: string }>
    }
    expect(out.providers[0].hasKey).toBe(true) // agy 靠 OAuth，视为已配置
    expect(out.providers[0].protocol).toBe('antigravity')
    expect(out.providers[0].keyMasked).toBe('agy 登录态')
  })

  it('llm:hasKey returns true for active antigravity provider (no apiKey needed)', async () => {
    await store.write({
      activeId: 'p_agy',
      providers: [
        {
          id: 'p_agy',
          label: 'agy',
          baseUrl: 'antigravity://local',
          model: 'default',
          apiKey: '',
          protocol: 'antigravity'
        }
      ]
    })
    const handler = handlers.get('llm:hasKey')
    const result = (await handler!(null)) as boolean
    expect(result).toBe(true) // 关键：agy provider 无 apiKey 但应通过检查
  })

  it('llm:hasKey returns false when no active provider configured', async () => {
    await store.write({ activeId: '', providers: [] })
    const handler = handlers.get('llm:hasKey')
    const result = (await handler!(null)) as boolean
    expect(result).toBe(false)
  })

  /* ---- codex 协议（codex CLI）---- */

  it('llm:upsertProvider accepts codex protocol without baseUrl/apiKey', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await handler!(null, {
      id: 'p_codex',
      label: 'codex 主力',
      baseUrl: '',
      model: '',
      apiKey: '',
      protocol: 'codex'
    })
    const cfg = await store.read()
    const p = cfg.providers[0]
    expect(p.protocol).toBe('codex')
    expect(p.apiKey).toBe('')
    expect(p.model).toBe('default')
    expect(p.baseUrl).toBe('codex://local')
  })

  it('llm:listProviders reports codex provider as hasKey=true with codex 登录态', async () => {
    await store.write({
      activeId: 'p_codex',
      providers: [
        {
          id: 'p_codex',
          label: 'codex',
          baseUrl: 'codex://local',
          model: 'default',
          apiKey: '',
          protocol: 'codex'
        }
      ]
    })
    const handler = handlers.get('llm:listProviders')
    const out = (await handler!(null)) as {
      providers: Array<{ hasKey: boolean; keyMasked: string; protocol: string }>
    }
    expect(out.providers[0].hasKey).toBe(true)
    expect(out.providers[0].protocol).toBe('codex')
    expect(out.providers[0].keyMasked).toBe('codex 登录态')
  })

  it('llm:hasKey returns true for active codex provider (no apiKey needed)', async () => {
    await store.write({
      activeId: 'p_codex',
      providers: [
        {
          id: 'p_codex',
          label: 'codex',
          baseUrl: 'codex://local',
          model: 'default',
          apiKey: '',
          protocol: 'codex'
        }
      ]
    })
    const handler = handlers.get('llm:hasKey')
    const result = (await handler!(null)) as boolean
    expect(result).toBe(true)
  })
})