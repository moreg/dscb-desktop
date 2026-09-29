import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterFlowResult } from '../src/shared/types'

const prose = '林远推开院门，把账册交给守门人。守门人核对印章后放他进门。'
const reply = (text: string, evidence = '林远推开院门') => JSON.stringify({
  events: [{ text, evidence }], stateChanges: [], openThreads: []
})

describe('章节概要', () => {
  let service: WriteService
  let llm: LlmService
  let dir: string
  let projectId: string

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'chapter-summary-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), settings)
    projectId = (await projects.create({ name: '概要测试', genre: '玄幻' })).id
    dir = await projects.resolveDir(projectId)
    llm = { generateStream: vi.fn().mockResolvedValue(reply('林远交出账册并进门')) } as unknown as LlmService
    service = new WriteService(projects, llm)
  })

  it('generates from prose, reuses the same hash, and replaces the old summary only after validation', async () => {
    await new ProseRepo(dir).write(1, prose)
    const first = await service.generateChapterSummary(projectId, 1, prose)
    expect(first.events[0].text).toBe('林远交出账册并进门')
    expect((await service.generateChapterSummary(projectId, 1, prose)).reused).toBe(true)
    expect(llm.generateStream).toHaveBeenCalledTimes(1)

    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('新概要', '正文里没有这句话'))
    await expect(service.generateChapterSummary(projectId, 1, prose, { force: true })).rejects.toThrow('依据')
    expect((await new ChapterSummaryRepo(dir).read(1))?.events[0].text).toBe(first.events[0].text)

    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('林远带着账册进门'))
    await service.generateChapterSummary(projectId, 1, prose, { force: true })
    expect((await new ChapterSummaryRepo(dir).read(1))?.events[0].text).toBe('林远带着账册进门')
  })

  it('uses a current summary for older chapters and ignores one after its prose changes', async () => {
    await new ProseRepo(dir).write(1, prose)
    await service.generateChapterSummary(projectId, 1, prose)
    const current = await new PlotPointRepo(dir).listSummariesBefore(3)
    expect(current[0].source).toBe('chapter_summary')
    expect(current[0].summary).toContain('林远交出账册并进门')

    await new ProseRepo(dir).write(1, '林远没有进门，而是折回街上。')
    const stale = await new PlotPointRepo(dir).listSummariesBefore(3)
    expect(stale[0].source).toBe('prose_excerpt')
    expect(stale[0].summary).not.toContain('林远交出账册并进门')
  })

  it('does not let a slower generation for an old draft replace a newer summary', async () => {
    const newer = '林远推开院门，守门人核对印章后放他进门。'
    await new ProseRepo(dir).write(1, prose)
    const resolves: Array<(value: string) => void> = []
    vi.mocked(llm.generateStream).mockImplementation(() => new Promise((resolve) => { resolves.push(resolve) }))
    const oldTask = service.generateChapterSummary(projectId, 1, prose)
    await vi.waitFor(() => expect(resolves).toHaveLength(1))
    await new ProseRepo(dir).write(1, newer)
    const newTask = service.generateChapterSummary(projectId, 1, newer)
    await vi.waitFor(() => expect(resolves).toHaveLength(2))
    resolves[1](reply('新稿进门', '守门人核对印章后放他进门'))
    await newTask
    resolves[0](reply('旧稿进门'))
    await expect(oldTask).rejects.toThrow('旧概要未写入')
    expect((await new ChapterSummaryRepo(dir).read(1))?.events[0].text).toBe('新稿进门')
  })

  it('gives the previous chapter in full and the older chapter as a summary', async () => {
    await new ProseRepo(dir).write(1, prose)
    await service.generateChapterSummary(projectId, 1, prose)
    const previous = '上一章开头的重要情节。' + '中间的行动。'.repeat(250) + '上一章结尾的悬念。'
    await new ProseRepo(dir).write(2, previous)
    const prompt = await service.buildChapterPrompt(projectId, 3)
    expect(prompt.user).toContain('上一章开头的重要情节')
    expect(prompt.user).toContain('上一章结尾的悬念')
    expect(prompt.user).toContain('林远交出账册并进门')
    expect(prompt.user).not.toContain('第 2 章（正文原文摘录')
  })

  it('reports an oversized previous chapter before extracting its ending state', async () => {
    await new ProseRepo(dir).write(1, '甲'.repeat(40_001))
    await expect(service.buildChapterPrompt(projectId, 2)).rejects.toThrow('PREVIOUS_CHAPTER_CONTEXT_TOO_LARGE')
    expect(llm.generateStream).not.toHaveBeenCalled()
  })

  it('finishes each batch summary before starting the next chapter', async () => {
    const seen: number[] = []
    vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, chapterNumber) => {
      if (chapterNumber === 2) {
        expect((await new ChapterSummaryRepo(dir).readCurrent(1, prose))?.events[0].text)
          .toBe('林远交出账册并进门')
      }
      seen.push(chapterNumber)
      return {
        chapterNumber, content: prose,
        audit: { schemaVersion: 1, wordCount: prose.length, counts: { error: 0, warn: 0, info: 0 },
          passed: { ending: true, forbiddenWords: true, wordCount: true }, violations: [] },
        outlineDiff: { chapterNumber, hasOutline: true, checked: true, passed: true, diffs: [], proseSynced: 0 },
        memory: { chapterNumber, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
          newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] },
        memoryApply: { applied: { characters: 0, locations: 0, items: 0, foreshadowings: 0,
          plotPoints: 0, stateChanges: 0, collected: 0 }, errors: [] },
        settingsApply: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] },
        selfCheck: { schemaVersion: 1, chapterNumber, generatedAt: '', counts: { pass: 1, fail: 0, warn: 0, skip: 0 },
          items: [], ok: true, summary: '' },
        rhythm: null,
        figure: { chapterNumber, shouldGenerate: false, type: '', topic: '', fileName: '', html: '', reason: '' }
      } satisfies ChapterFlowResult
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(seen).toEqual([1, 2])
    expect((await new ChapterSummaryRepo(dir).read(2))?.events).toHaveLength(1)
  })
})
