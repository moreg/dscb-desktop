import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'

describe('SettingsRepository writing requirement templates', () => {
  let repo: SettingsRepository

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-swt-'))
    repo = new SettingsRepository(path.join(dir, 'settings.json'))
  })

  it('returns default templates when unset', async () => {
    const templates = await repo.getWritingRequirementTemplates()
    expect(templates.length).toBeGreaterThan(0)
    expect(templates[0].name).toBeTruthy()
    expect(templates[0].requirements.length).toBeGreaterThan(0)
  })

  it('persists custom templates and normalizes requirement lines', async () => {
    const saved = await repo.setWritingRequirementTemplates([
      {
        id: 'custom-1',
        name: '我的模板',
        description: '测试说明',
        requirements: ['1. 开头直接冲突', '', '- 结尾留钩子', '开头直接冲突']
      }
    ])

    expect(saved).toEqual([
      {
        id: 'custom-1',
        name: '我的模板',
        description: '测试说明',
        requirements: ['开头直接冲突', '结尾留钩子']
      }
    ])
    expect(await repo.getWritingRequirementTemplates()).toEqual(saved)
  })

  it('falls back to defaults when templates become invalid or empty', async () => {
    const saved = await repo.setWritingRequirementTemplates([
      {
        id: '   ',
        name: '',
        description: '',
        requirements: []
      }
    ] as unknown as Parameters<typeof repo.setWritingRequirementTemplates>[0])

    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0].id).not.toBe('')
  })
})
