import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { LocationRepo } from '../src/main/data/memory/location-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import { writeJsonAtomic } from '../src/main/data/atomic'
import { readMemoryCandidate } from '../src/main/data/memory/candidate-repository'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { MemoryExtraction } from '../src/shared/types'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('applyAllNewEntities', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let service: WriteService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-apply-all-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '太初剑道', genre: '玄幻' })).id
    service = new WriteService(ps, mockLlm('正文'))
  })

  it('automatically applies all new entities from candidate file and updates candidate', async () => {
    const dir = await ps.resolveDir(projectId)
    const candidateDir = path.join(dir, '.cache', 'memory-candidates')
    await mkdir(candidateDir, { recursive: true })

    const extraction: MemoryExtraction = {
      chapterNumber: 1,
      newCharacters: [
        { name: '苏白', role: '主角', identity: '青竹宗弟子', personality: '冷静果决' }
      ],
      newLocations: [
        { name: '问剑峰', category: '宗门圣地', notes: '试剑之所' }
      ],
      newItems: [
        { name: '斩铁残剑', category: '灵器', notes: '神秘古剑' }
      ],
      newForeshadowings: [
        { content: '后山禁地的神秘低语', expectedCollect: 10, note: '魔宗伏笔' }
      ],
      newPlotPoints: [],
      characterStateChanges: [],
      collectedForeshadowings: []
    }

    const candidateFile = path.join(candidateDir, 'chapter-1.json')
    await writeJsonAtomic(candidateFile, {
      chapterNumber: 1,
      sourceHash: 'hash-1',
      extraction,
      status: 'pending',
      updatedAt: new Date().toISOString()
    })

    const result = await service.applyAllNewEntities(projectId, 1)
    expect(result).toEqual({
      characters: 1,
      locations: 1,
      items: 1,
      foreshadowings: 1,
      total: 4
    })

    // Verify entities are created in markdown repositories
    const charList = await new CharacterRepo(dir).list()
    expect(charList.find((c) => c.name === '苏白')).toBeDefined()

    const locList = await new LocationRepo(dir).list()
    expect(locList.find((l) => l.name === '问剑峰')).toBeDefined()

    const itemList = await new ItemRepo(dir).list()
    expect(itemList.find((i) => i.name === '斩铁残剑')).toBeDefined()

    const fsList = await new ForeshadowingMdRepo(dir).list()
    expect(fsList.find((f) => f.content === '后山禁地的神秘低语')).toBeDefined()

    // Verify candidate was updated with appliedEntities
    const updatedCandidate = await readMemoryCandidate(dir, 1)
    expect(updatedCandidate?.appliedEntities).toEqual({
      characters: 1,
      locations: 1,
      items: 1,
      foreshadowings: 1
    })

    // Verify deduplication on re-running: no overwrite, no crash
    const secondResult = await service.applyAllNewEntities(projectId, 1)
    expect(secondResult.total).toBe(4)
    const charListAfter = await new CharacterRepo(dir).list()
    expect(charListAfter.filter((c) => c.name === '苏白').length).toBe(1)
  })
})
