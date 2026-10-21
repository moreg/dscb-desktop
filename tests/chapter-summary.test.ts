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
  events: [{ text, evidence }], stateChanges: [], openThreads: [], continuity: []
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
    llm = { generateStream: vi.fn().mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]}) : reply('林远交出账册并进门')) } as unknown as LlmService
    service = new WriteService(projects, llm)
  })

  it('generates from prose, reuses the same hash, and replaces the old summary only after validation', async () => {
    await new ProseRepo(dir).write(1, prose)
    const first = await service.generateChapterSummary(projectId, 1, prose)
    expect(first.events[0].text).toBe('林远交出账册并进门')
    expect((await service.generateChapterSummary(projectId, 1, prose)).reused).toBe(true)
    expect(llm.generateStream).toHaveBeenCalledTimes(1)

    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('新概要', '正文里没有这句话'))
    await expect(service.generateChapterSummary(projectId, 1, prose, { force: true })).resolves.toMatchObject({ stale: false })
    expect((await new ChapterSummaryRepo(dir).read(1))?.events[0].text).toBe(first.events[0].text)

    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('林远带着账册进门'))
    await service.generateChapterSummary(projectId, 1, prose, { force: true })
    expect((await new ChapterSummaryRepo(dir).read(1))?.events[0].text).toBe('林远带着账册进门')
  })

  it('normalizes punctuation-only quote differences back to exact source text without another model call', async () => {
    await new ProseRepo(dir).write(1, prose)
    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('账册交接', '林远推开院门, 把账册交给守门人。'))
    const result = await service.generateChapterSummary(projectId, 1, prose)
    expect(result.events[0].evidence).toBe('林远推开院门，把账册交给守门人。')
    expect(llm.generateStream).toHaveBeenCalledOnce()
  })

  it('automatically re-extracts invalid evidence and commits only the repaired, validated summary', async () => {
    await new ProseRepo(dir).write(1, prose)
    const write = vi.spyOn(ChapterSummaryRepo.prototype, 'write')
    try {
      vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('不存在的交接', '林远把账册交给船夫。'))
        .mockImplementationOnce(async prompt => {
          expect(prompt).toContain('自动修复并重新提取')
          expect(prompt).toContain('依据与当前正文不符')
          expect(prompt).toContain(prose)
          expect(write).not.toHaveBeenCalled()
          return reply('林远交出账册', '把账册交给守门人。')
        })
      const result = await service.generateChapterSummary(projectId, 1, prose)
      expect(result.events[0]).toEqual({ text: '林远交出账册', evidence: '把账册交给守门人。' })
      expect(llm.generateStream).toHaveBeenCalledTimes(2)
      expect(write).toHaveBeenCalledOnce()
    } finally { write.mockRestore() }
  })

  it('repairs a continuity ledger quote instead of stopping the single-chapter summary request', async () => {
    await new ProseRepo(dir).write(1, prose)
    const ledger = (value: string, evidence: string) => JSON.stringify({ events: [{ text: '账册交接', evidence: prose }],
      stateChanges: [], openThreads: [], continuity: [{ kind: 'item', subject: '账册', object: '', aspect: '持有者', value, evidence }] })
    vi.mocked(llm.generateStream).mockResolvedValueOnce(ledger('船夫', '账册交给了船夫。'))
      .mockResolvedValueOnce(ledger('守门人', '把账册交给守门人。'))
    const result = await service.generateChapterSummary(projectId, 1, prose, { requireContinuity: true })
    expect(result.continuity?.[0]).toMatchObject({ value: '守门人', evidence: '把账册交给守门人。' })
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })

  it('uses actual source quotes after repeated extraction failures without asking to resync or inventing events', async () => {
    await new ProseRepo(dir).write(1, prose)
    vi.mocked(llm.generateStream).mockResolvedValue(reply('虚构事件', '正文从未出现的句子。'))
    const result = await service.generateChapterSummary(projectId, 1, prose, { requireContinuity: true })
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.events.every(item => prose.includes(item.evidence))).toBe(true)
    expect(result.events[0].text).toContain('前文原文')
    expect(result.stateChanges).toEqual([])
    expect(result.continuity).toEqual([])
    expect(JSON.stringify(result)).not.toContain('虚构事件')
    expect(await new ProseRepo(dir).read(1)).toBe(prose)
  })

  it('preserves an already valid summary if every repair attempt fails', async () => {
    await new ProseRepo(dir).write(1, prose)
    await service.generateChapterSummary(projectId, 1, prose)
    const saved = await new ChapterSummaryRepo(dir).read(1)
    vi.mocked(llm.generateStream).mockClear().mockResolvedValue('不是有效 JSON')
    await service.generateChapterSummary(projectId, 1, prose, { force: true })
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
    expect(await new ChapterSummaryRepo(dir).read(1)).toEqual(saved)
  })

  it('stops retrying an outdated draft after an author edit and allows the newer draft to generate normally', async () => {
    await new ProseRepo(dir).write(1, prose)
    const newer = '林远转身离去，账册仍在原处。'
    vi.mocked(llm.generateStream).mockImplementationOnce(async () => {
      await new ProseRepo(dir).write(1, newer)
      return reply('交接', '没有这条原文依据。')
    })
    await expect(service.generateChapterSummary(projectId, 1, prose)).rejects.toThrow('旧概要未写入')
    expect(llm.generateStream).toHaveBeenCalledOnce()
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply('林远离去，未交出账册', newer))
    await expect(service.generateChapterSummary(projectId, 1, newer)).resolves.toMatchObject({ stale: false })
    expect((await new ChapterSummaryRepo(dir).readCurrent(1, newer))?.events[0].text).toContain('未交出账册')
  })

  it('honors cancellation before retrying evidence repair and does not commit a fallback after cancellation', async () => {
    await new ProseRepo(dir).write(1, prose)
    const controller = new AbortController()
    vi.mocked(llm.generateStream).mockImplementationOnce(async () => {
      controller.abort()
      return reply('错误摘要', '不存在的原文。')
    })
    await expect(service.generateChapterSummary(projectId, 1, prose, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(llm.generateStream).toHaveBeenCalledOnce()
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
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

  it('persists evidence-backed continuity and recalls it beyond the recent chapter window', async () => {
    await new ProseRepo(dir).write(1, prose)
    vi.mocked(llm.generateStream).mockResolvedValueOnce(JSON.stringify({
      events: [{ text: '交出账册', evidence: '把账册交给守门人。' }], stateChanges: [], openThreads: [],
      continuity: [{ kind: 'item', subject: '账册', object: '', aspect: '持有者', value: '守门人', evidence: '把账册交给守门人。' }]
    }))
    const result = await service.generateChapterSummary(projectId, 1, prose)
    expect(result.continuity?.[0].value).toBe('守门人')
    const prompt = await service.buildChapterPrompt(projectId, 60, null, '林远要取回账册')
    expect(prompt.user).toContain('账册 · 持有者：守门人')
    expect(prompt.user).toContain('长期连续性核对')

    vi.mocked(llm.generateStream).mockClear().mockResolvedValue('{"findings":[]}')
    await service.runDeepReview(projectId, '林远在门外等候，打算向守门人借走账册。', 60)
    expect(vi.mocked(llm.generateStream).mock.calls.some(([text]) =>
      text.includes('长期连续性核对') && text.includes('账册 · 持有者：守门人'))).toBe(true)

    vi.mocked(llm.generateStream).mockResolvedValueOnce(JSON.stringify({
      events: [{ text: '交出账册', evidence: '把账册交给守门人。' }], stateChanges: [], openThreads: [],
      continuity: [{ kind: 'item', subject: '账册', object: '', aspect: '持有者', value: '船夫', evidence: '账册交给了船夫。' }]
    }))
    await expect(service.generateChapterSummary(projectId, 1, prose, { force: true })).resolves.toMatchObject({ stale: false })
    expect((await new ChapterSummaryRepo(dir).read(1))?.continuity?.[0].value).toBe('守门人')
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

  it('keeps oversized previous prose intact until provider-specific budget handling', async () => {
    const previous = '甲'.repeat(40_001)
    await new ProseRepo(dir).write(1, previous)
    const prompt = await service.buildChapterPrompt(projectId, 2)
    expect(prompt.user).toContain(previous)
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
