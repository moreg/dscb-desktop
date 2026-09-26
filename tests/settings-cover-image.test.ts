import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'

describe('SettingsRepository 封面出图通道', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-cover-image-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('可从 codex CLI 切换并持久化为 API Key 通道', async () => {
    await repo.setCoverImageConfig({ channel: 'codex' })

    const saved = await repo.setCoverImageConfig({
      channel: 'api',
      apiKey: 'sk-cover-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-image-2'
    })

    expect(saved.channel).toBe('api')
    expect(saved.hasKey).toBe(true)
    await expect(repo.getCoverImageConfig()).resolves.toMatchObject({
      channel: 'api',
      apiKey: 'sk-cover-test'
    })
  })

  it('未传通道时保留当前选择', async () => {
    await repo.setCoverImageConfig({ channel: 'grok' })
    const saved = await repo.setCoverImageConfig({ model: 'new-image-model' })

    expect(saved.channel).toBe('grok')
    await expect(repo.getCoverImageConfig()).resolves.toMatchObject({
      channel: 'grok',
      model: 'new-image-model'
    })
  })
})
