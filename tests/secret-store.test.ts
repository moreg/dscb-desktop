import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
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

describe('SecretStore', () => {
  let dir: string
  let store: InstanceType<typeof SecretStore>
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-sec-'))
    store = new SecretStore(path.join(dir, 'providers.enc'))
  })

  it('returns empty config when file absent', async () => {
    expect(await store.read()).toEqual({ activeId: '', providers: [] })
  })

  it('round-trips encrypted config', async () => {
    const provider = {
      id: 'p_a',
      label: '主力',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-123'
    }
    await store.write({ activeId: 'p_a', providers: [provider] })
    const read = await store.read()
    expect(read.providers[0].apiKey).toBe('sk-test-123')
    expect(read.activeId).toBe('p_a')
  })

  it('stored file is not plaintext', async () => {
    const provider = {
      id: 'p_b',
      label: '备用',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'sk-secret'
    }
    await store.write({ activeId: 'p_b', providers: [provider] })
    const raw = await readFile(path.join(dir, 'providers.enc'), 'utf-8')
    expect(raw).not.toContain('sk-secret')
  })

  it('migrates legacy schema with minimax provider', async () => {
    // 直接写一个旧 schema 的加密文件
    const { safeStorage } = await import('electron')
    const legacy = {
      activeProvider: 'minimax',
      providers: { minimax: { apiKey: 'sk-legacy-mm' } }
    }
    const enc = safeStorage.encryptString(JSON.stringify(legacy))
    const { writeFile } = await import('fs/promises')
    await writeFile(path.join(dir, 'providers.enc'), enc)

    const cfg = await store.read()
    expect(cfg.activeId).toBe('p_legacy_minimax')
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.providers[0].apiKey).toBe('sk-legacy-mm')
    expect(cfg.providers[0].baseUrl).toBe('https://api.minimaxi.com/v1')
  })

  it('migrates legacy schema with multiple providers', async () => {
    const { safeStorage } = await import('electron')
    const legacy = {
      providers: {
        openai: { apiKey: 'sk-oa' },
        deepseek: { apiKey: 'sk-ds' }
      }
    }
    const enc = safeStorage.encryptString(JSON.stringify(legacy))
    const { writeFile } = await import('fs/promises')
    await writeFile(path.join(dir, 'providers.enc'), enc)

    const cfg = await store.read()
    expect(cfg.providers).toHaveLength(2)
    const labels = cfg.providers.map((p) => p.label).sort()
    expect(labels).toEqual(['DeepSeek（旧）', 'OpenAI（旧）'])
    expect(cfg.activeId).toBeTruthy()
  })

  it('throws SCHEMA_INVALID on corrupted JSON', async () => {
    const { writeFile } = await import('fs/promises')
    // 写入一堆看似加密但实际不是的字节
    await writeFile(path.join(dir, 'providers.enc'), Buffer.from('<enc>not-hex</enc>'))
    await expect(store.read()).rejects.toThrow(/SCHEMA_INVALID|invalid/)
  })

  it('throws SCHEMA_INVALID when payload is not JSON', async () => {
    const { safeStorage } = await import('electron')
    // encryptString 后的 hex 内容故意不是合法 JSON
    const enc = safeStorage.encryptString('not json at all')
    const { writeFile } = await import('fs/promises')
    await writeFile(path.join(dir, 'providers.enc'), enc)
    await expect(store.read()).rejects.toThrow(/SCHEMA_INVALID/)
  })
})