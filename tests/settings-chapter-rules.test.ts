import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'

describe('SettingsRepository chapter rule overrides', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-scr-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('returns empty object when unset (= 全用内置默认)', async () => {
    expect(await repo.getChapterRuleOverrides()).toEqual({})
  })

  it('persists whitelisted keys and drops unknown keys', async () => {
    const saved = await repo.setChapterRuleOverrides({
      dialogue: '【自定义】只许说真话。',
      ending: '', // 空串=停用，应保留
      notARealKey: '应被剔除'
    } as Record<string, string>)

    expect(saved).toEqual({
      dialogue: '【自定义】只许说真话。',
      ending: ''
    })
    expect(await repo.getChapterRuleOverrides()).toEqual(saved)
  })

  it('sanitizes non-object / malformed payloads to empty on read', async () => {
    await repo.update({ chapterRuleOverrides: 'not-an-object' as unknown as Record<string, string> })
    expect(await repo.getChapterRuleOverrides()).toEqual({})
  })
})
