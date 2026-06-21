import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { CharacterRepository } from '../src/main/data/character-repository'
import { ChapterRepository } from '../src/main/data/chapter-repository'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

describe('WriteService', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-ws-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('buildChapterPrompt assembles project, outline, characters, prev chapter', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).writeMain({
      schemaVersion: 1,
      updatedAt: 't',
      synopsis: '少年修仙主线'
    })
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '本章细纲：林远突破'
    })
    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })
    await new ChapterRepository(dir).create({ title: '第一章' })
    await new ChapterRepository(dir).create({ title: '第二章' })
    await new ChapterRepository(dir).updateContent(1, '前一章的正文内容。')

    const service = new WriteService(ps, mockLlm('正文'))
    const { system, user } = await service.buildChapterPrompt(projectId, 2)
    expect(user).toContain('青云志')
    expect(user).toContain('少年修仙主线')
    expect(user).toContain('林远突破')
    expect(user).toContain('林远')
    expect(user).toContain('前一章的正文内容')
    // 新的 system prompt 含技能守则
    expect(system).toContain('章末结尾硬性原则')
    expect(system).toContain('禁用高频词')
  })

  it('generateChapterStream calls llm with assembled prompt', async () => {
    const llm = mockLlm('生成的正文')
    const service = new WriteService(ps, llm)
    const full = await service.generateChapterStream(projectId, 1)
    expect(full).toBe('生成的正文')
    expect(llm.generateStream).toHaveBeenCalled()
  })
})
