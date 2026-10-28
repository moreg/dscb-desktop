import { describe, expect, it } from 'vitest'
import { readProviderDraft, writeProviderDraft } from '../src/renderer/src/SettingsPage'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }
  }
}

describe('添加 provider 的本机草稿', () => {
  it('没有存过时用公开的默认地址，密钥为空', () => {
    expect(readProviderDraft(memoryStorage())).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: ''
    })
  })

  it('记住上次的 Base URL 和 API Key', () => {
    const storage = memoryStorage()
    writeProviderDraft(storage, { baseUrl: 'https://example.test/v1', apiKey: 'sk-local' })
    expect(readProviderDraft(storage)).toEqual({
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-local'
    })
  })
})
