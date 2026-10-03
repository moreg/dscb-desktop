import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { WriteService, type ChapterGenerateOptions } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { contentRevision } from '../src/main/data/chapter-revision'
import { countWords } from '../src/main/data/words'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import type { LlmService } from '../src/main/data/llm-service'
import type { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { AutoDeslopResult, SavedChapterPolishResult } from '../src/shared/types'

const RAW = '林远缓缓推开院门，将账册放在守门人的桌上，等他核对印章。'
const POLISHED = RAW.replace('缓缓', '')
type PolishHarness = {
  autoDeslopGeneratedProse: (
    projectId: string, chapterNumber: number, content: string, style: string | null,
    opts: Pick<ChapterGenerateOptions, 'signal' | 'onAutoDeslopResult'> & { isTail: boolean }
  ) => Promise<string>
}
const applied: AutoDeslopResult = { status: 'applied', message: '已完成精修。', remainingIssues: 0 }

describe('已有正文批量精修：保存、概要、并发和取消', () => {
  let root: string
  let projectId: string
  let dir: string
  let service: WriteService
  let chapters: ChapterService
  let llm: LlmService
  let deslop: DeslopService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'saved-chapter-polish-'))
    const settings = {
      getProjectsRoot: async (fallback: string) => fallback,
      getSettingsFile: () => path.join(root, 'settings.json'),
      get: async () => ({ autoMemorySync: true }),
      getDeslopRules: async () => ({})
    } as unknown as SettingsRepository
    const projects = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), settings)
    projectId = (await projects.create({ name: '旧稿精修' })).id
    dir = await projects.resolveDir(projectId)
    chapters = new ChapterService(projects)
    llm = { generateStream: vi.fn() } as unknown as LlmService
    deslop = { deslop: vi.fn(async (text: string) => ({ rewritten: text, processedGates: [],
      beforeWords: countWords(text), afterWords: countWords(text), deleteRatio: 0, remainingFindings: [], changeSummary: [] })) } as unknown as DeslopService
    service = new WriteService(projects, llm, undefined, undefined, chapters, settings, undefined, deslop)
    await chapters.updateContent(projectId, 1, RAW)
    await chapters.updateContent(projectId, 2, RAW)
    vi.spyOn(service as unknown as PolishHarness, 'autoDeslopGeneratedProse').mockImplementation(async (_project, _chapter, _content, _style, opts) => {
      opts.onAutoDeslopResult?.(applied)
      return POLISHED
    })
    vi.spyOn(service, 'generateChapterSummary').mockImplementation(async (_project, chapterNumber, content) => ({
      schemaVersion: 1, chapterNumber, sourceHash: contentRevision(content), generatedAt: '', stale: false,
      events: [{ text: '交账册', evidence: '将账册放在守门人的桌上' }], stateChanges: [], openThreads: []
    }))
    vi.spyOn(service, 'syncChapterAfterWrite').mockResolvedValue(null)
    vi.spyOn(service, 'generateChapterStream')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const resolved = path.resolve(root)
    expect(resolved.startsWith(path.resolve(tmpdir()) + path.sep + 'saved-chapter-polish-')).toBe(true)
    await rm(resolved, { recursive: true, force: true })
  })

  function run(opts: { signal?: AbortSignal; onProgress?: (chapter: number, step: string) => void } = {}, from = 1, to = 2) {
    const complete = vi.fn<(chapter: number, result: SavedChapterPolishResult) => void>()
    return { complete, task: service.polishChaptersBatch(projectId, from, to, 'chosen-style', complete, opts) }
  }

  it('按章顺序仅精修旧稿，保存 reviewed 版本并从最终正文刷新概要，不重放全书状态', async () => {
    const onProgress = vi.fn()
    const { complete, task } = run({ onProgress })
    const result = await task
    expect(result.ok).toBe(true)
    expect(result.results.map((item) => [item.chapterNumber, item.changed])).toEqual([[1, true], [2, true]])
    expect(complete.mock.calls.map(([chapter]) => chapter)).toEqual([1, 2])
    expect(onProgress.mock.calls).toEqual([[1, 'deslop'], [1, 'saving'], [1, 'summary'], [2, 'deslop'], [2, 'saving'], [2, 'summary']])
    for (const chapter of [1, 2]) {
      expect((await chapters.getChapter(projectId, chapter)).content).toBe(POLISHED)
      expect((await new ChapterVersionRepository(dir).list(chapter)).map((version) => [version.source, version.content]))
        .toEqual([['reviewed', POLISHED], ['manual', RAW]])
      expect(service.generateChapterSummary).toHaveBeenCalledWith(projectId, chapter, POLISHED,
        expect.objectContaining({ force: true, expectedRevision: contentRevision(POLISHED) }))
    }
    expect((service as unknown as PolishHarness).autoDeslopGeneratedProse).toHaveBeenCalledWith(projectId, 1, RAW, 'chosen-style', expect.objectContaining({ isTail: true }))
    expect(service.generateChapterStream).not.toHaveBeenCalled()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    expect(llm.generateStream).not.toHaveBeenCalled()
  })

  it.each(['review_required', 'failed', 'unchanged'] as const)('%s 原正文原样保留，不保存或重新写概要/全书记忆', async (status) => {
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockImplementation(async (_project, _chapter, _content, _style, opts) => {
      opts.onAutoDeslopResult?.({ status, message: '已保留生成稿。', remainingIssues: 1, issues: ['事实待核验'] })
      return POLISHED
    })
    const result = await run().task
    expect(result.results.every((item) => !item.changed && item.autoDeslop.status === status)).toBe(true)
    expect(result.results[0].autoDeslop.message).toContain('原正文')
    expect(result.results[0].autoDeslop.issues).toEqual(['事实待核验'])
    expect((await chapters.getChapter(projectId, 1)).content).toBe(RAW)
    expect((await new ChapterVersionRepository(dir).list(1))).toHaveLength(1)
    expect(service.generateChapterSummary).not.toHaveBeenCalled()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('报告 applied 但正文相同也不重复保存或写概要', async () => {
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockImplementation(async (_project, _chapter, text, _style, opts) => {
      opts.onAutoDeslopResult?.(applied)
      return text
    })
    expect((await run().task).results.every((item) => !item.changed)).toBe(true)
    expect(service.generateChapterSummary).not.toHaveBeenCalled()
  })

  it('没有正文的章报告跳过，后续有正文的章继续处理', async () => {
    await chapters.updateContent(projectId, 1, '')
    const result = await run().task
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ chapterNumber: 1, changed: false, error: expect.stringContaining('没有已保存正文') })
    expect(result.results[1]).toMatchObject({ chapterNumber: 2, changed: true })
    expect(service.generateChapterSummary).toHaveBeenCalledTimes(1)
  })

  it('精修期间另一窗口改稿时不覆盖该稿，不写概要，并继续下一章', async () => {
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockImplementation(async (_project, chapter, _content, _style, opts) => {
      if (chapter === 1) await chapters.updateContent(projectId, 1, '作者刚修改的新正文。')
      opts.onAutoDeslopResult?.(applied)
      return POLISHED
    })
    const result = await run().task
    expect(result.results[0]).toMatchObject({ chapterNumber: 1, changed: false, error: expect.stringContaining('CHAPTER_REVISION_CONFLICT') })
    expect((await chapters.getChapter(projectId, 1)).content).toBe('作者刚修改的新正文。')
    expect(result.results[1].changed).toBe(true)
    expect(service.generateChapterSummary).toHaveBeenCalledTimes(1)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('概要更新失败时仍报告精修已保存，继续处理后章', async () => {
    vi.mocked(service.generateChapterSummary).mockRejectedValueOnce(new Error('概要调用失败'))
    const result = await run().task
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ changed: true, autoDeslop: { status: 'applied' }, error: expect.stringContaining('章节概要未更新') })
    expect((await chapters.getChapter(projectId, 1)).content).toBe(POLISHED)
    expect(result.results[1].changed).toBe(true)
  })

  it('正文写入后状态更新异常时仍识别已保存稿，刷新概要并提示历史记录问题', async () => {
    vi.spyOn(chapters, 'updateContent').mockImplementationOnce(async (_project, chapter, content) => {
      const title = (await chapters.getChapter(_project, chapter)).meta.title
      await new ProseRepo(dir).write(chapter, content, title)
      throw new Error('节奏状态写入失败')
    })
    const result = await run().task
    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ changed: true, autoDeslop: { status: 'applied' },
      error: expect.stringContaining('章节状态或历史记录更新未完成') })
    expect((await chapters.getChapter(projectId, 1)).content).toBe(POLISHED)
    expect(service.generateChapterSummary).toHaveBeenCalledWith(projectId, 1, POLISHED, expect.anything())
    expect(result.results[1].changed).toBe(true)
  })

  it('处理开始前已取消时不启动精修', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run({ signal: controller.signal }).task
    expect(result).toMatchObject({ ok: false, results: [], error: expect.stringContaining('已停止') })
    expect((service as unknown as PolishHarness).autoDeslopGeneratedProse).not.toHaveBeenCalled()
  })

  it('精修阶段取消即停，未保存稿不覆盖，下一章不启动', async () => {
    const controller = new AbortController()
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockImplementation(async (_project, _chapter, _content, _style, opts) => {
      opts.onAutoDeslopResult?.(applied)
      controller.abort()
      return POLISHED
    })
    const result = await run({ signal: controller.signal }).task
    expect(result).toMatchObject({ ok: false, results: [] })
    expect((await chapters.getChapter(projectId, 1)).content).toBe(RAW)
    expect((service as unknown as PolishHarness).autoDeslopGeneratedProse).toHaveBeenCalledTimes(1)
    expect(service.generateChapterSummary).not.toHaveBeenCalled()
  })

  it('概要阶段取消保留已保存精修，返回该章完成结果，下一章不启动', async () => {
    const controller = new AbortController()
    vi.mocked(service.generateChapterSummary).mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('LLM_ABORTED')
    })
    const { task, complete } = run({ signal: controller.signal })
    const result = await task
    expect(result).toMatchObject({ ok: false, results: [{ chapterNumber: 1, changed: true, autoDeslop: { status: 'applied' } }] })
    expect(complete).toHaveBeenCalledTimes(1)
    expect((await chapters.getChapter(projectId, 1)).content).toBe(POLISHED)
    expect((await chapters.getChapter(projectId, 2)).content).toBe(RAW)
  })

  it.each([[0, 1], [2, 1], [1, 101], [1.5, 2], [1, Number.MAX_SAFE_INTEGER + 1]])('拒绝非法范围 %s-%s', async (from, to) => {
    expect((await run({}, from, to).task).ok).toBe(false)
    expect((service as unknown as PolishHarness).autoDeslopGeneratedProse).not.toHaveBeenCalled()
  })

  it('概要的保存版本前提不符时在 LLM 调用前拒绝，避免旧稿概要写入', async () => {
    vi.mocked(service.generateChapterSummary).mockRestore()
    await expect(service.generateChapterSummary(projectId, 1, POLISHED, { force: true, expectedRevision: contentRevision(POLISHED) }))
      .rejects.toThrow('章节正文已改变')
    expect(llm.generateStream).not.toHaveBeenCalled()
    expect(await service.getChapterSummary(projectId, 1, RAW)).toBeNull()
  })

  it('实际精修链将排版引起的动作顺序变化放在事实核验之前，保存稿就是核验稿', async () => {
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockRestore()
    const before = '“先核对印章。”林远把账册摊开，“再打开院门。”\r\n\r\n' + RAW
    await chapters.updateContent(projectId, 1, before)
    vi.mocked(llm.generateStream).mockResolvedValue('{"unchanged":true,"issues":[]}')
    const result = await run({}, 1, 1).task
    const formatted = formatChapterProse(before)
    expect(formatted.indexOf('林远把账册摊开')).toBeLessThan(formatted.indexOf('先核对印章'))
    expect(llm.generateStream).toHaveBeenCalledWith(expect.stringContaining('【润色稿】\n\n' + formatted),
      expect.objectContaining({ meta: expect.objectContaining({ feature: 'deslop:verify' }) }))
    expect((await chapters.getChapter(projectId, 1)).content).toBe(formatted)
    expect(result.results[0]).toMatchObject({ changed: true, autoDeslop: { status: 'applied' } })
    expect(service.generateChapterSummary).toHaveBeenCalledWith(projectId, 1, formatted, expect.anything())
    expect(service.generateChapterStream).not.toHaveBeenCalled()
  })

  it('实际链核验排版动作顺序不通过时保留原正文全部字节，不写概要或记忆', async () => {
    vi.mocked((service as unknown as PolishHarness).autoDeslopGeneratedProse).mockRestore()
    const before = '“先核对印章。”林远把账册摊开，“再打开院门。”\r\n\r\n' + RAW
    await chapters.updateContent(projectId, 1, before)
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, opts) =>
      opts?.meta?.feature === 'deslop:repair'
        ? JSON.stringify({ text: before })
        : JSON.stringify({ unchanged: false, issues: ['原稿先说核对印章再摊开账册，排版稿将摊开动作前移'] }))
    const result = await run({}, 1, 1).task
    expect(result.results[0]).toMatchObject({ changed: false, autoDeslop: { status: 'review_required', repairAttempts: 2 } })
    expect((await chapters.getChapter(projectId, 1)).content).toBe(before)
    expect(service.generateChapterSummary).not.toHaveBeenCalled()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    expect(service.generateChapterStream).not.toHaveBeenCalled()
  })
})
