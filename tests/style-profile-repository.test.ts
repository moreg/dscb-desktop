import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { StyleProfileRepository } from '../src/main/data/style-profile-repository'

describe('StyleProfileRepository', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-style-repo-'))
  })

  it('returns an empty file shape when styles.json is absent', async () => {
    const repo = new StyleProfileRepository(dir)
    await expect(repo.read()).resolves.toEqual({ schemaVersion: 1, items: [] })
  })

  it('writes and reads styles.json', async () => {
    const repo = new StyleProfileRepository(dir)
    const payload = {
      schemaVersion: 1 as const,
      items: [
        {
          id: 's1',
          name: '冷峻文风',
          sourceType: 'sampleText' as const,
          sampleText: '样文',
          identifiedStyle: '冷峻',
          sentencePatterns: ['短句'],
          vocabularyPreferences: ['克制'],
          punctuationAndRhythm: ['停顿多'],
          narrativePerspective: ['第三人称'],
          tone: ['冷静'],
          narrativeTemplates: ['冲突先行'],
          styleConstraints: ['用短句', '避免华丽修辞'],
          characterConstraints: ['保持主角冷静'],
          plotConstraints: ['不要抒情过量'],
          dos: ['用短句'],
          donts: ['不要抒情过量'],
          stylePrompt: '保持冷峻克制。',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z'
        }
      ]
    }
    await repo.write(payload)
    await expect(repo.read()).resolves.toEqual(payload)
  })
})
