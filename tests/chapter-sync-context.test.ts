import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { ChapterService } from '../src/main/data/chapter-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { WriteFlowService } from '../src/main/data/write-flow-service'
import { createWritingProject } from './helpers/writing-project'

describe('chapter sync source/context contract', () => {
  let root: string, dir: string, id: string, service: WriteService, chapters: ChapterService
  let model: string | null, rules: string
  const memory = vi.fn(async (..._args: unknown[]) => '{}'), rhythm = vi.fn(async (..._args: unknown[]) => '{}'), figure = vi.fn(async (..._args: unknown[]) => '{}')
  const content = '林远将账册交给守门人。'
  beforeEach(async () => {
    vi.clearAllMocks(); model = 'model'; rules = 'rules'
    root = await mkdtemp(join(tmpdir(), 'sync-context-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback,
      get: async () => ({ rules }), getReviewRules: async () => ({}), getDeslopRules: async () => ({}) } as unknown as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    const project = await createWritingProject(projects, { name: '同步上下文' })
    id = project.id; dir = project.path; chapters = new ChapterService(projects)
    await chapters.updateContent(id, 1, content)
    service = new WriteService(projects, { getCacheIdentity: async () => model } as unknown as LlmService,
      { extractMemoryStream: memory, evaluateRhythmStream: rhythm, generateFigureStream: figure } as unknown as WriteFlowService,
      undefined, chapters, settings)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('invalidates changed rules, models, plans and prior summaries but ignores this run’s summary/index outputs', async () => {
    const key = await service.getChapterSyncContext(id, 1, content)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    await mkdir(join(dir, '记忆/章节概要'), { recursive: true })
    await writeFile(join(dir, '记忆/章节概要/第001章.json'), '{}')
    await writeFile(join(dir, '记忆/索引.md'), 'updated index')
    expect(await service.getChapterSyncContext(id, 1, content)).toBe(key)
    await writeFile(join(dir, '细纲/第001章.md'), '计划发生变化')
    const planKey = await service.getChapterSyncContext(id, 1, content)
    expect(planKey).not.toBe(key)
    model = 'new model'
    expect(await service.getChapterSyncContext(id, 1, content)).not.toBe(planKey)
    const modelKey = await service.getChapterSyncContext(id, 1, content)
    rules = 'changed rules'
    expect(await service.getChapterSyncContext(id, 1, content)).not.toBe(modelKey)
  })
  it('requires saved content even when models cannot be identified', async () => {
    model = null
    expect(await service.getChapterSyncContext(id, 1, content)).toBeNull()
    await expect(service.getChapterSyncContext(id, 1, '未保存的改稿')).rejects.toThrow('先保存正文')
    await expect(service.getChapterSyncContext(id, 1, ' ')).rejects.toThrow('正文为空')
  })
  it('all three disk-based analyses accept the same immutable snapshot without replacing saved prose', async () => {
    const snapshot = '林远在门外等候。'
    await service.extractMemoryStream(id, 1, {}, snapshot)
    await service.evaluateRhythmStream(id, 1, {}, snapshot)
    await service.generateFigureStream(id, 1, {}, snapshot)
    for (const call of [memory, rhythm, figure]) expect(call.mock.calls[0][0]).toBe(snapshot)
    expect((await chapters.getChapter(id, 1)).content).toBe(content)
    await service.extractMemoryStream(id, 1)
    expect(memory.mock.calls.at(-1)?.[0]).toBe(content)
  })
})
