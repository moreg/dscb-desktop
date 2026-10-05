import { mkdtemp, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ChapterService } from '../src/main/data/chapter-service'
import { DiagnosticsService } from '../src/main/data/diagnostics-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { MemoryEntityService } from '../src/main/data/memory-entity-service'
import { MemoryService } from '../src/main/data/memory-service'
import { OutlineService } from '../src/main/data/outline-service'
import { ProjectService } from '../src/main/data/project-service'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

describe('只保存项目信息的新作品', () => {
  it('重新打开和读取各工作台均正常，不生成规划目录或调用模型', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-info-only-'))
    const library = new LibraryRepository(join(root, 'library.json'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), library, settings)
    const project = await projects.create({ name: '先存一个脑洞', genre: '悬疑', description: '失踪者的影子仍在上班。' })
    const reopened = new ProjectService(join(root, 'projects'), library, settings)
    const generateStream = vi.fn()
    const outline = new OutlineService(reopened, { generateStream } as unknown as LlmService)
    const memory = new MemoryService(reopened)
    const entities = new MemoryEntityService(reopened)

    expect((await reopened.getProjectData(project.id)).description).toBe('失踪者的影子仍在上班。')
    expect(await reopened.listProjects()).toHaveLength(1)
    expect(await new ChapterService(reopened).listChapters(project.id)).toEqual([])
    expect(await new DiagnosticsService(reopened).report(project.id)).toEqual([])
    expect(await outline.getMain(project.id)).toBeNull()
    expect(await outline.listDetailed(project.id)).toEqual([])
    expect(await memory.listCharacters(project.id)).toEqual([])
    expect(await memory.listForeshadowings(project.id)).toEqual([])
    expect(await memory.listRelationships(project.id)).toEqual([])
    for (const type of ['location', 'worldview', 'timeline', 'plot_point', 'item'] as const) {
      expect(await entities.list(project.id, type)).toEqual([])
    }
    expect(await new TrackingMdRepo(project.path).read(1)).toBeNull()
    expect(await readdir(project.path)).toEqual(['project.json'])
    expect(generateStream).not.toHaveBeenCalled()
  })
})
