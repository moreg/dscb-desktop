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

  it('allows long requirement lists beyond the old 20-line IPC limit', async () => {
    const requirements = Array.from({ length: 25 }, (_, i) => `第 ${i + 1} 条要求`)

    const saved = await repo.setWritingRequirementTemplates([
      {
        id: 'long-list',
        name: '长要求模板',
        description: '用于覆盖超过 20 条要求的模板',
        requirements
      }
    ])

    expect(saved[0].requirements).toHaveLength(25)
    expect(saved[0].requirements[24]).toBe('第 25 条要求')
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
