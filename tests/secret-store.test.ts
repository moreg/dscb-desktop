import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SecretStore } from '../src/main/data/secret-store'

describe('SecretStore', () => {
  let dir: string
  let store: SecretStore
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-sec-'))
    store = new SecretStore(path.join(dir, 'providers.enc'))
  })

  it('returns empty config when file absent', async () => {
    expect(await store.read()).toEqual({ activeProvider: 'minimax', providers: {} })
  })

  it('round-trips encrypted config', async () => {
    await store.write({ activeProvider: 'minimax', providers: { minimax: { apiKey: 'sk-test-123' } } })
    const read = await store.read()
    expect(read.providers.minimax?.apiKey).toBe('sk-test-123')
  })

  it('stored file is not plaintext', async () => {
    await store.write({ activeProvider: 'minimax', providers: { minimax: { apiKey: 'sk-secret' } } })
    const raw = await readFile(path.join(dir, 'providers.enc'), 'utf-8')
    expect(raw).not.toContain('sk-secret')
  })
})
