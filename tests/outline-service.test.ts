import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineService } from '../src/main/data/outline-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('OutlineService', () => {
  let root: string
  let projectId: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ols-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    const projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await projectService.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('generateMain is not implemented in the current phase', async () => {
    const ps = new ProjectService(
      path.join(root, 'projects'),
      new LibraryRepository(path.join(root, 'library.json')),
      mockSettings
    )
    const service = new OutlineService(ps, mockLlm('这是一个关于少年的修仙故事。'))
    await expect(service.generateMain(projectId)).rejects.toThrow(/Phase 3b/)
  })

  it('generateDetailed is not implemented in the current phase', async () => {
    const ps = new ProjectService(
      path.join(root, 'projects'),
      new LibraryRepository(path.join(root, 'library.json')),
      mockSettings
    )
    const service = new OutlineService(ps, mockLlm('第3章细纲：林远觉醒。'))
    await expect(service.generateDetailed(projectId, 3)).rejects.toThrow(/Phase 3b/)
  })
})
