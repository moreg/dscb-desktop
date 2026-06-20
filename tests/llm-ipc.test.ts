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
          apiKey: 'sk-abcdefghijklmnop'
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
    expect(out.providers[0].keyMasked).toBe('sk-a••••mnop')
    // apiKey 字段必须不存在
    expect(out.providers[0].apiKey).toBeUndefined()
    // 整个对象序列化后也不应含明文
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijklmnop')
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
        apiKey: 'k'
      })
    ).rejects.toThrow(/PROVIDER_INVALID/)
  })

  it('llm:upsertProvider sanitizes payload (rejects non-http scheme)', async () => {
    const handler = handlers.get('llm:upsertProvider')
    await expect(
      handler!(null, {
        id: 'p2',
        label: 'bad',
        baseUrl: 'ftp://example.com/v1',
        model: 'm',
        apiKey: 'k'
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
      apiKey: 'k'
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
      apiKey: 'sk-original'
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
    expect(cfg.providers[0].apiKey).toBe('sk-original')
    expect(cfg.providers[0].label).toBe('renamed')
    expect(cfg.providers[0].model).toBe('m2')
  })

  it('llm:deleteProvider clears activeId when deleting active', async () => {
    await store.write({
      activeId: 'p1',
      providers: [
        { id: 'p1', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: 'k' },
        { id: 'p2', label: 'B', baseUrl: 'https://b.example.com/v1', model: 'm', apiKey: 'k' }
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
        { id: 'p1', label: 'A', baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: 'k' },
        { id: 'p2', label: 'B', baseUrl: 'https://b.example.com/v1', model: 'm', apiKey: 'k' }
      ]
    })
    const handler = handlers.get('llm:setActive')
    const result = await handler!(null, 'p2')
    expect(result).toBe('p2')
    const cfg = await store.read()
    expect(cfg.activeId).toBe('p2')
  })
})