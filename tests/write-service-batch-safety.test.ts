import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { WriteService } from '../src/main/data/write-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { DetailedOutlineWriter } from '../src/main/data/skill-format/detailed-outline-writer'
import type { WriteFlowService } from '../src/main/data/write-flow-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { LlmService } from '../src/main/data/llm-service'
import type { ChapterFlowResult, ChapterSelfCheckReport, MemoryApplyResult } from '../src/shared/types'

const content = '林远推开院门，把账册交给守门人。守门人核对印章后放他进门。'
const emptyMemory = (): MemoryApplyResult => ({
  applied: { characters: 0, locations: 0, items: 0, foreshadowings: 0, plotPoints: 0, stateChanges: 0, collected: 0 }, errors: []
})
const passedCheck: ChapterSelfCheckReport = {
  schemaVersion: 1, chapterNumber: 1, generatedAt: '', counts: { pass: 1, fail: 0, warn: 0, skip: 0 },
  items: [], ok: true, summary: '通过'
}
const resultFor = (chapterNumber: number): ChapterFlowResult => ({
  chapterNumber, content,
  audit: { schemaVersion: 1, wordCount: content.length, counts: { error: 0, warn: 0, info: 0 },
    passed: { ending: true, forbiddenWords: true, wordCount: true }, violations: [] },
  outlineDiff: { chapterNumber, hasOutline: true, checked: true, diffs: [], passed: true },
  memory: { chapterNumber, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
    newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] },
  memoryApply: emptyMemory(), selfCheck: passedCheck, rhythm: null,
  figure: { chapterNumber, shouldGenerate: false, type: '', topic: '', fileName: '', html: '', reason: '' }
})

describe('batch safety and recovery', () => {
  let service: WriteService
  let flow: WriteFlowService
  let dir: string
  let projectId: string
  let llm: LlmService
  let summaryService: { generateChapterSummaryChecked: WriteService['generateChapterSummary'] }

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'batch-safety-'))
    const settings = {
      getProjectsRoot: async (fallback: string) => fallback,
      get: async () => ({ autoMemorySync: true }),
      getReviewRules: async () => ({ enabled: false })
    } as unknown as SettingsRepository
    const ps = new ProjectService(path.join(root, 'projects'), new LibraryRepository(path.join(root, 'library.json')), settings)
    projectId = (await ps.create({ name: '测试小说', genre: '玄幻' })).id
    dir = await ps.resolveDir(projectId)
    llm = { generateStream: vi.fn().mockImplementation(async (_prompt, options) => options?.meta?.feature === 'longformGuard'
      ? JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]}) : '[]') } as unknown as LlmService
    service = new WriteService(ps, llm, undefined, undefined, undefined, settings)
    summaryService = service as unknown as typeof summaryService
    vi.spyOn(summaryService, 'generateChapterSummaryChecked').mockImplementation(async (_pid, ch) => ({
      chapterNumber: ch, sourceHash: 'test', generatedAt: '', events: [], stateChanges: [], openThreads: [], stale: false
    }))
    flow = (service as unknown as { flow: WriteFlowService }).flow
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    for (const ch of [1, 2, 3, 4]) {
      await writeFile(path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_交接${ch}.md`),
        `# 细纲\n\n## 第 ${ch} 章：交接${ch}\n\n> 所属卷：第 1 卷\n\n- **核心事件**：原始事件${ch}\n`, 'utf-8')
    }
  })

  afterEach(() => vi.restoreAllMocks())

  function stubPostProcess(): void {
    // Summary preparation now overlaps the independent ending-state extraction.
    vi.spyOn(flow, 'extractEndingState').mockResolvedValue({ chapterNumber: 1,
      characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] })
    vi.spyOn(flow, 'verifyForeshadowingRepair').mockResolvedValue(undefined)
    vi.spyOn(service, 'selfCheckChapter').mockResolvedValue(passedCheck)
    vi.spyOn(flow, 'checkOutlineStream').mockResolvedValue('[]')
    vi.spyOn(flow, 'extractMemoryStream').mockResolvedValue(JSON.stringify(resultFor(1).memory))
    vi.spyOn(flow, 'evaluateRhythmStream').mockResolvedValue('{}')
    vi.spyOn(flow, 'generateFigureStream').mockResolvedValue('{}')
    vi.spyOn(service, 'syncChapterAfterWrite').mockImplementation(async (_pid, ch, text, options) => ({
      memory: emptyMemory(), settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] },
      extraction: options?.extraction ?? resultFor(ch).memory, selfCheck: passedCheck
    }))
  }

  const foreshadowDiff = [{ type: 1, typeLabel: '漏写', priority: 'P1',
    outline: 'FB-001：账册夹着父亲留下的半张借条', actual: '没有伏笔线索', suggestion: '补写伏笔' }]
  const foreshadowAddition = '账册封皮夹着半张借条，林远认出落款是父亲的笔迹。'
  const foreshadowPatch = JSON.stringify({ insertions: [{ after: -1, text: foreshadowAddition }] })

  it('automatically fills missing foreshadowing before syncing memory and generating the next chapter', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, ch) => {
      if (ch === 2) expect(await new ProseRepo(dir).read(1)).toContain(foreshadowAddition)
      return content
    })
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff)).mockResolvedValue('[]')
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => options?.meta?.feature === 'longformGuard'
      ? JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [] }) : foreshadowPatch)
    const completed = vi.fn()
    const progress = await service.generateChaptersBatch(projectId, 1, 2, completed, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(generate).toHaveBeenCalledTimes(2)
    const repaired = completed.mock.calls[0][1].content as string
    expect(repaired).toBe(foreshadowAddition + '\n' + content)
    expect(await new ProseRepo(dir).read(1)).toBe(repaired)
    expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][2]).toBe(repaired)
    expect(vi.mocked(summaryService.generateChapterSummaryChecked).mock.calls[0][2]).toBe(repaired)
    const extractedTexts = vi.mocked(flow.extractMemoryStream).mock.calls.map((call) => call[0])
    expect(extractedTexts).toContain(repaired)
    expect(vi.mocked(llm.generateStream).mock.calls.filter(call => call[1]?.meta?.feature === 'batchForeshadowRepair')).toHaveLength(1)
    expect(await readFile(path.join(dir, '细纲', '细纲_第001章_交接1.md'), 'utf-8')).toContain('原始事件1')
  })

  it('preserves the original prose and outline if two automatic repair rounds still miss the task', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockResolvedValue(JSON.stringify(foreshadowDiff))
    vi.mocked(llm.generateStream).mockResolvedValueOnce(foreshadowPatch).mockResolvedValueOnce(JSON.stringify({ insertions: [
      { after: -1, text: '林远把借条收进父亲留给他的信封。' }
    ] }))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1, completed: [1] })
    expect(progress.pauseReason).toContain('两轮后仍未通过')
    expect(generate).toHaveBeenCalledOnce()
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(await readFile(path.join(dir, '细纲', '细纲_第001章_交接1.md'), 'utf-8')).toContain('原始事件1')
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('keeps the original saved draft and pauses before memory sync when insertion verification fails', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff)).mockResolvedValue('[]')
    vi.mocked(llm.generateStream).mockResolvedValue(foreshadowPatch)
    vi.mocked(flow.verifyForeshadowingRepair).mockRejectedValue(new Error('伏笔补写引入新的剧情偏离：提前揭底'))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1 })
    expect(progress.pauseReason).toContain('提前揭底')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledOnce()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('invalidates an outline-check cache when author requirements change on retry', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.syncChapterAfterWrite).mockResolvedValueOnce({
      memory: { ...emptyMemory(), errors: ['同步失败'] }, extraction: resultFor(1).memory,
      settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }
    })
    const first = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null,
      { tempContext: '暂不揭晓父亲身份' }, undefined, { autoContinue: true })
    expect(first.status).toBe('paused')
    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null,
      { tempContext: '本次允许揭晓父亲身份' }, first, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(vi.mocked(flow.checkOutlineStream).mock.calls.map((call) => call[3]?.tempContext))
      .toEqual(['暂不揭晓父亲身份', '本次允许揭晓父亲身份'])
  })

  it('resumes failed repair from saved prose and does not regenerate the chapter', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff))
    vi.mocked(llm.generateStream).mockRejectedValueOnce(new Error('补写断流')).mockResolvedValue(foreshadowPatch)
    const first = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(first.status).toBe('paused')
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff)).mockResolvedValue('[]')
    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null, {}, first, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(generate).toHaveBeenCalledOnce()
    expect(await new ProseRepo(dir).read(1)).toBe(foreshadowAddition + '\n' + content)
  })

  it('does not overwrite a manual edit made during automatic repair', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff)).mockResolvedValue('[]')
    vi.mocked(llm.generateStream).mockImplementation(async () => {
      const chapters = (service as unknown as { chapterService: { updateContent: (pid: string, ch: number, text: string) => Promise<unknown> } }).chapterService
      await chapters.updateContent(projectId, 1, '作者手改后的正文。')
      return foreshadowPatch
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(await new ProseRepo(dir).read(1)).toBe('作者手改后的正文。')
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('keeps successfully saved repair on retry without inserting it twice', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockResolvedValueOnce(JSON.stringify(foreshadowDiff)).mockResolvedValue('[]')
    vi.mocked(llm.generateStream).mockResolvedValue(foreshadowPatch)
    vi.mocked(service.syncChapterAfterWrite).mockResolvedValueOnce({
      memory: { ...emptyMemory(), errors: ['写入失败'] }, extraction: resultFor(1).memory,
      settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }
    })
    const first = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(first.status).toBe('paused')
    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null, {}, first, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(generate).toHaveBeenCalledOnce()
    expect(llm.generateStream).toHaveBeenCalledOnce()
    expect(await new ProseRepo(dir).read(1)).toBe(foreshadowAddition + '\n' + content)
  })

  it('persists prose before any memory commit', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.syncChapterAfterWrite).mockImplementation(async (_pid, ch, _text, options) => {
      expect(await new ProseRepo(dir).read(ch)).toBe(content)
      return { memory: emptyMemory(), settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] },
        extraction: options!.extraction! }
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(service.syncChapterAfterWrite).toHaveBeenCalledOnce()
  })

  it('awaits the saved-content checkpoint before committing chapter memory', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    let checkpointComplete = false
    const checkpoint = vi.fn(async (chapter: number) => {
      expect(await new ProseRepo(dir).read(chapter)).toBe(content)
      checkpointComplete = true
    })
    vi.mocked(service.syncChapterAfterWrite).mockImplementation(async (_pid, ch, _text, options) => {
      expect(checkpointComplete).toBe(true)
      return { memory: emptyMemory(), settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] },
        extraction: options?.extraction ?? resultFor(ch).memory }
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null,
      { onContentSaved: checkpoint }, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(checkpoint).toHaveBeenCalledWith(1)
  })

  it('checkpoint failure preserves prose and pauses before any memory write', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null,
      { onContentSaved: async () => { throw new Error('进度存储失败') } }, undefined, { autoContinue: true })
    expect(progress).toMatchObject({ status: 'paused', completed: [1], pendingPostProcessChapter: 1 })
    expect(progress.pauseReason).toContain('进度存储失败')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('does not commit memory or announce completion when saving fails', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const chapterService = (service as unknown as { chapterService: { updateContent: () => Promise<unknown> } }).chapterService
    vi.spyOn(chapterService, 'updateContent').mockRejectedValue(new Error('EBUSY'))
    const complete = vi.fn()
    const progress = await service.generateChaptersBatch(projectId, 1, 2, complete, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('failed')
    expect(progress.completed).toEqual([])
    expect(complete).not.toHaveBeenCalled()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    const [draft] = await readdir(path.join(dir, '.cache', 'batch-drafts'))
    expect(await readFile(path.join(dir, '.cache', 'batch-drafts', draft), 'utf-8')).toBe(content)
  })

  it('recovers the final saved chapter by rerunning checks without generating or double-counting', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    // 对照会就地重试 3 次，三次都断网才暂停。
    vi.mocked(flow.checkOutlineStream)
      .mockRejectedValueOnce(new Error('暂时断网'))
      .mockRejectedValueOnce(new Error('暂时断网'))
      .mockRejectedValueOnce(new Error('暂时断网'))
    const first = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(first.status).toBe('paused')
    expect(first.pendingPostProcessChapter).toBe(1)
    expect(first.completed).toEqual([1])
    expect(first.pauseReason).toContain('暂时断网')
    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null, {}, first, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(resumed.pendingPostProcessChapter).toBeUndefined()
    expect(resumed.completed).toEqual([1])
    expect(resumed.current).toBe(1)
    expect(generate).toHaveBeenCalledOnce()
    expect(flow.checkOutlineStream).toHaveBeenCalledTimes(4)
    expect(await new ProseRepo(dir).read(1)).toBe(content)
  })

  it('retries a flaky memory extraction before handing it to memory sync', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.extractMemoryStream).mockResolvedValueOnce('<think>先列 {人物}</think>好的，结果如下：')
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(flow.extractMemoryStream).toHaveBeenCalledTimes(2)
    expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][3]?.extraction?.parseError).toBeUndefined()
  })

  it('runs outline check and memory extraction concurrently', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    let releaseOutline: () => void = () => {}
    // 对照要等记忆提取开始才返回：若两步仍串行，这里会一直卡住直到超时。
    vi.mocked(flow.checkOutlineStream).mockImplementation(() => new Promise((resolve) => {
      releaseOutline = () => resolve('[]')
    }))
    vi.mocked(flow.extractMemoryStream).mockImplementation(async () => {
      releaseOutline()
      return JSON.stringify(resultFor(1).memory)
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(flow.evaluateRhythmStream).not.toHaveBeenCalled()
    expect(flow.generateFigureStream).not.toHaveBeenCalled()
  })

  it('reuses successful steps when retrying a paused chapter', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    // 对照和回写细纲都成功，记忆提取连续三次失败 → 暂停
    vi.mocked(flow.extractMemoryStream)
      .mockRejectedValueOnce(new Error('模型断流'))
      .mockRejectedValueOnce(new Error('模型断流'))
      .mockRejectedValueOnce(new Error('模型断流'))
    const first = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(first.status).toBe('paused')
    expect(first.pauseReason).toContain('模型断流')
    const resumed = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null, {}, first, { autoContinue: true })
    expect(resumed.status).toBe('completed')
    expect(generate).toHaveBeenCalledOnce()
    // 细纲对照不重跑，只补跑失败的记忆提取
    expect(flow.checkOutlineStream).toHaveBeenCalledOnce()
    expect(flow.extractMemoryStream).toHaveBeenCalledTimes(4)
  })

  it('automatically retries missing summaries before the next chapter without regenerating prose', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(summaryService.generateChapterSummaryChecked).mockRejectedValueOnce(new Error('概要请求失败'))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(summaryService.generateChapterSummaryChecked).toHaveBeenCalledTimes(3)
  })

  it('falls back to dated source quotes when summary generation remains unavailable and keeps writing', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(summaryService.generateChapterSummaryChecked).mockRejectedValue(new Error('概要请求失败'))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    const summary = await new ChapterSummaryRepo(dir).readCurrent(1, content)
    expect(summary?.events.every(item => content.includes(item.evidence))).toBe(true)
    expect(summary?.stateChanges).toEqual([])
  })

  it('retries a flaky outline check in place instead of pausing the batch', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream)
      .mockRejectedValueOnce(new Error('暂时断网'))
      .mockResolvedValueOnce('对不起，我无法输出 JSON')
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(flow.checkOutlineStream).toHaveBeenCalledTimes(3)
  })

  it('preserves pending checks when recovery is cancelled before the first call', async () => {
    await new ProseRepo(dir).write(1, content)
    const controller = new AbortController()
    controller.abort()
    const run = vi.spyOn(service, 'runFullFlowForChapter')
    const progress = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null,
      { signal: controller.signal }, { fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 }, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps pending checks when continuous mode is turned off during recovery', async () => {
    await new ProseRepo(dir).write(1, content)
    const result = resultFor(1)
    result.outlineDiff.checked = false
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const progress = await service.resumeChaptersBatch(projectId, 1, 1, () => {}, null, {},
      { fromChapter: 1, total: 1, completed: [1], pendingPostProcessChapter: 1 }, { autoContinue: false })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
  })

  it('rejects invalid resume chapter numbers before adding one to the range', async () => {
    const run = vi.spyOn(service, 'runFullFlowForChapter')
    const progress = await service.resumeChaptersBatch(projectId, 0, 2, () => {})
    expect(progress.status).toBe('failed')
    expect(progress.error).toContain('正整数')
    expect(run).not.toHaveBeenCalled()
  })

  it('stops auxiliary LLM calls promptly and keeps the generated prose', async () => {
    stubPostProcess()
    const controller = new AbortController()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(flow.checkOutlineStream).mockImplementation(async () => {
      controller.abort()
      throw new Error('LLM_ABORTED')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null,
      { signal: controller.signal }, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(flow.extractMemoryStream).not.toHaveBeenCalled()
    expect(flow.evaluateRhythmStream).not.toHaveBeenCalled()
    expect(flow.generateFigureStream).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(1)).toBe(content)
  })

  it('rejects a concurrent author edit instead of overwriting it', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockImplementation(async () => {
      await new ProseRepo(dir).write(1, '作者在另一窗口刚写的正文')
      return content
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('failed')
    expect(progress.completed).toEqual([])
    expect(await new ProseRepo(dir).read(1)).toBe('作者在另一窗口刚写的正文')
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('does not commit stale memory when another edit arrives immediately after saving', async () => {
    stubPostProcess()
    vi.mocked(service.syncChapterAfterWrite).mockRestore()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const apply = vi.spyOn(service, 'applyMemory')
    const chapterService = (service as unknown as { chapterService: { updateContent: () => Promise<unknown> } }).chapterService
    vi.spyOn(chapterService, 'updateContent').mockImplementation(async () => {
      await new ProseRepo(dir).write(1, content)
      await new ProseRepo(dir).write(1, '保存后立即改成的新正文')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(apply).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(1)).toBe('保存后立即改成的新正文')
  })

  it('marks prose as pending if metadata fails after the prose write', async () => {
    stubPostProcess()
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const chapterService = (service as unknown as { chapterService: { updateContent: () => Promise<unknown> } }).chapterService
    vi.spyOn(chapterService, 'updateContent').mockImplementation(async () => {
      await new ProseRepo(dir).write(1, content)
      throw new Error('节奏文件被锁定')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.completed).toEqual([1])
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  const brokenContinuity: ChapterSelfCheckReport = { ...passedCheck, ok: false, items: [
    { id: 'confirmed_location_conflict', category: 'continuity', label: '人物位置矛盾', verdict: 'fail', detail: '人物同时出现在两地' }
  ] }
  const corrected = content.replace('守门人核对印章后放他进门。', '守门人核对印章后，让他留在门外等候。')
  const continuityPatch = JSON.stringify({ replacements: [{ before: '守门人核对印章后放他进门。', after: '守门人核对印章后，让他留在门外等候。' }] })
  function stubContinuityModel(): void {
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => {
      if (options?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
      if (options?.meta?.feature === 'continuityRepair') return continuityPatch
      if (options?.meta?.feature === 'continuityRepairVerify') return JSON.stringify({ passed: true, issues: [] })
      return '[]'
    })
  }

  async function stubLongformConflict(options: { stillConflicts?: boolean; verify?: () => Promise<string> } = {}): Promise<void> {
    const goal = '第1章必须留在门外等候，第2章才能进院，禁止提前完成进院节点。'
    await mkdir(path.join(dir, '大纲'), { recursive: true })
    await writeFile(path.join(dir, '大纲', '大纲.md'), `# 大纲\n\n## 主线剧情走向\n\n${goal}`)
    vi.mocked(llm.generateStream).mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'longformGuard') return JSON.stringify({
        completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'],
        findings: opts.meta.chapterNumber === 1 && (prompt.endsWith(content) || options.stillConflicts)
          ? [{ kind: 'mainline', message: '提前完成下一章进院节点，应保留门外等候。',
            snippet: prompt.endsWith(content) ? content : corrected, reference: goal }] : []
      })
      if (opts?.meta?.feature === 'continuityRepair') {
        expect(prompt).toContain('不得修改未来细纲')
        return continuityPatch
      }
      if (opts?.meta?.feature === 'continuityRepairVerify') {
        expect(await new ProseRepo(dir).read(1)).toBe(content)
        return options.verify ? options.verify() : JSON.stringify({ passed: true, issues: [] })
      }
      return '[]'
    })
  }

  it.each([false, true])('repairs a longform conflict and continues with fresh memory (recovered=%s)', async recovered => {
    stubPostProcess()
    await stubLongformConflict()
    const nextOutline = await readFile(path.join(dir, '细纲', '细纲_第002章_交接2.md'), 'utf8')
    if (recovered) await new ProseRepo(dir).write(1, content)
    const generate = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, n) => {
      if (n === 2) {
        expect(await new ProseRepo(dir).read(1)).toBe(corrected)
        expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][2]).toBe(corrected)
      }
      return content
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {},
      recovered ? { fromChapter: 1, total: 2, completed: [1], pendingPostProcessChapter: 1 } : undefined,
      { autoContinue: true })
    expect(progress.status, progress.pauseReason).toBe('completed')
    expect(generate.mock.calls.map(call => call[1])).toEqual(recovered ? [2] : [1, 2])
    expect(await new ProseRepo(dir).read(1)).toBe(corrected)
    expect(vi.mocked(summaryService.generateChapterSummaryChecked).mock.calls[0][2]).toBe(corrected)
    expect(vi.mocked(service.syncChapterAfterWrite).mock.calls.some(call => call[2] === content && call[1] === 1)).toBe(false)
    expect(await readFile(path.join(dir, '细纲', '细纲_第002章_交接2.md'), 'utf8')).toBe(nextOutline)
  })

  it.each(['longform', 'verify', 'outline'] as const)('retains the original draft when longform repair fails %s verification', async failure => {
    stubPostProcess()
    await stubLongformConflict({ stillConflicts: failure === 'longform',
      ...(failure === 'verify' ? { verify: async () => JSON.stringify({ passed: false, issues: ['仍提前完成节点'] }) } : {}) })
    if (failure === 'outline') vi.mocked(flow.checkOutlineStream).mockResolvedValue(JSON.stringify([
      { type: 4, priority: 'P0', outline: '门外等候', actual: '进院', suggestion: '恢复等候' }
    ]))
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress).toMatchObject({ status: 'paused', pendingPostProcessChapter: 1 })
    expect(progress.pauseReason).toContain('LONGFORM_CONFLICT')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledOnce()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    expect(vi.mocked(llm.generateStream).mock.calls.filter(call => call[1]?.meta?.feature === 'continuityRepair')).toHaveLength(2)
  })

  it('does not overwrite an author edit made during longform repair', async () => {
    stubPostProcess()
    const authorEdit = content + '作者刚补充了新的伏笔。'
    await stubLongformConflict({ verify: async () => {
      const file = (await readdir(path.join(dir, '正文'))).find(name => name.endsWith('.md'))!
      await writeFile(path.join(dir, '正文', file), authorEdit)
      return JSON.stringify({ passed: true, issues: [] })
    } })
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(await new ProseRepo(dir).read(1)).toBe(authorEdit)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('repairs a conflict raised immediately after raw prose is saved without generating the chapter twice', async () => {
    stubPostProcess()
    await stubLongformConflict()
    const generate = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, _n, opts) => {
      if (typeof opts !== 'string') await opts?.onProseGenerated?.(content)
      throw new Error('LONGFORM_CONFLICT: 提前完成下一章进院节点，应保留门外等候。')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status, progress.pauseReason).toBe('completed')
    expect(generate).toHaveBeenCalledOnce()
    expect(await new ProseRepo(dir).read(1)).toBe(corrected)
    expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][2]).toBe(corrected)
  })

  it('stops longform repair on cancellation without adopting the candidate or advancing', async () => {
    stubPostProcess()
    const controller = new AbortController()
    await stubLongformConflict({ verify: async () => {
      controller.abort()
      return JSON.stringify({ passed: true, issues: [] })
    } })
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, { signal: controller.signal }, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pauseReason).toContain('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledOnce()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('does not treat an incomplete longform review as permission to rewrite prose', async () => {
    stubPostProcess()
    const generate = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, _n, opts) => {
      if (typeof opts !== 'string') await opts?.onProseGenerated?.(content)
      throw new Error('LONGFORM_REVIEW_INCOMPLETE: 核对超时')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledOnce()
    expect(vi.mocked(llm.generateStream).mock.calls.some(call => call[1]?.meta?.feature === 'continuityRepair')).toBe(false)
  })

  it('automatically repairs confirmed continuity conflicts and uses rechecked prose and fresh memory for the next chapter', async () => {
    stubPostProcess()
    stubContinuityModel()
    const previous = '师父让林远在门外等候，没有允许他进院。'
    await new ProseRepo(dir).write(1, previous)
    vi.spyOn(flow, 'extractEndingState').mockResolvedValue({ chapterNumber: 1,
      characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] })
    const generate = vi.spyOn(service, 'generateChapterStream').mockImplementation(async (_pid, chapter) => {
      if (chapter === 3) {
        expect(await new ProseRepo(dir).read(2)).toBe(corrected)
        expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][2]).toBe(corrected)
        expect(vi.mocked(summaryService.generateChapterSummaryChecked).mock.calls[0][2]).toBe(corrected)
      }
      return content
    })
    vi.mocked(service.selfCheckChapter).mockImplementation(async (_pid, ch, text) => ch === 2 && text === content ? brokenContinuity : passedCheck)
    const stages: string[] = []
    const completed = vi.fn()
    const progress = await service.generateChaptersBatch(projectId, 2, 3, completed, null,
      { onGenerationStage: stage => stages.push(stage) }, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(generate.mock.calls.map(call => call[1])).toEqual([2, 3])
    expect(completed.mock.calls[0][1].content).toBe(corrected)
    expect(vi.mocked(flow.extractMemoryStream).mock.calls.map(call => call[0])).toContain(corrected)
    expect(vi.mocked(llm.generateStream).mock.calls.find(call => call[1]?.meta?.feature === 'continuityRepair')?.[0]).toContain(previous)
    expect(stages.some(stage => stage.startsWith('continuity:'))).toBe(true)
  })

  it.each(['logic_hole', 'character_breakdown'])('automatically repairs a confirmed %s from deep review before continuing', async (ruleId) => {
    stubPostProcess()
    stubContinuityModel()
    const settings = (service as unknown as { settings: SettingsRepository }).settings
    vi.spyOn(settings, 'getReviewRules').mockResolvedValue({ ...await settings.getReviewRules(), enabled: true, autoDeepReview: true })
    vi.spyOn(service, 'auditChapter').mockResolvedValue(resultFor(1).audit)
    const review = vi.spyOn(service, 'runDeepReview').mockImplementation(async (_pid, text, ch) => ch === 1 && text === content
      ? [{ category: 'llm_review', severity: 'error', ruleId, message: '与前文事实矛盾' }] : [])
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status, progress.pauseReason).toBe('completed')
    expect(await new ProseRepo(dir).read(1)).toBe(corrected)
    expect(review.mock.calls.some(call => call[1] === corrected)).toBe(true)
    expect(vi.mocked(service.syncChapterAfterWrite).mock.calls[0][2]).toBe(corrected)
  })

  it('retries failed semantic verification without saving the rejected candidate, then continues automatically', async () => {
    stubPostProcess()
    let verification = 0
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => {
      if (options?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
      if (options?.meta?.feature === 'continuityRepair') return continuityPatch
      if (options?.meta?.feature === 'continuityRepairVerify') {
        expect(await new ProseRepo(dir).read(1)).toBe(content)
        return JSON.stringify(++verification === 1 ? { passed: false, issues: ['转场依据不足'] } : { passed: true, issues: [] })
      }
      return '[]'
    })
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.selfCheckChapter).mockImplementation(async (_pid, ch, text) => ch === 1 && text === content ? brokenContinuity : passedCheck)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(verification).toBe(2)
    expect(await new ProseRepo(dir).read(1)).toBe(corrected)
  })

  it('keeps retrying failed repairs automatically until the user stops, preserving the saved draft and memory', async () => {
    stubPostProcess()
    stubContinuityModel()
    const generate = vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.selfCheckChapter).mockResolvedValue(brokenContinuity)
    const controller = new AbortController()
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {
      signal: controller.signal, onGenerationStage: stage => { console.log('DBG_STAGE', JSON.stringify(stage)); if (stage.includes('稍后自动重试')) controller.abort() }
    }, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(controller.signal.aborted).toBe(true)
    expect(progress.pauseReason).toContain('LLM_ABORTED')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(generate).toHaveBeenCalledOnce()
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    expect(vi.mocked(llm.generateStream).mock.calls.filter(call => call[1]?.meta?.feature === 'continuityRepair')).toHaveLength(3)
  })

  it('does not overwrite an author edit arriving during automatic continuity verification', async () => {
    stubPostProcess()
    const authorEdit = content + '作者新加的台词。'
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => {
      if (options?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
      if (options?.meta?.feature === 'continuityRepair') return continuityPatch
      if (options?.meta?.feature === 'continuityRepairVerify') {
        const file = (await readdir(path.join(dir, '正文'))).find(name => name.endsWith('.md'))!
        await writeFile(path.join(dir, '正文', file), authorEdit)
        return JSON.stringify({ passed: true, issues: [] })
      }
      return '[]'
    })
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.selfCheckChapter).mockImplementation(async (_pid, _ch, text) => text === content ? brokenContinuity : passedCheck)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(await new ProseRepo(dir).read(1)).toBe(authorEdit)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
  })

  it('cancels continuity repair immediately and retains the current draft without synchronizing rejected changes', async () => {
    stubPostProcess()
    const controller = new AbortController()
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => {
      if (options?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
      if (options?.meta?.feature === 'continuityRepair') { controller.abort(); return continuityPatch }
      return '[]'
    })
    vi.spyOn(service, 'generateChapterStream').mockResolvedValue(content)
    vi.mocked(service.selfCheckChapter).mockResolvedValue(brokenContinuity)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, { signal: controller.signal }, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(await new ProseRepo(dir).read(1)).toBe(content)
    expect(service.syncChapterAfterWrite).not.toHaveBeenCalled()
    expect(vi.mocked(llm.generateStream).mock.calls.filter(call => call[1]?.meta?.feature === 'continuityRepairVerify')).toHaveLength(0)
  })

  it('keeps writing when only prose self-check hints remain after the prose-first sync', async () => {
    const result = resultFor(1)
    result.selfCheck = { ...passedCheck, ok: false,
      items: [{ id: 'ending_taboo', category: 'structure', label: '章末无说教', detail: '结尾抒怀', verdict: 'fail' }] }
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(progress.completed).toEqual([1, 2])
  })

  it.each(['memory', 'settings'])('pauses continuous writing as retryable when %s cannot follow the prose, including the final chapter', async (kind) => {
    const result = resultFor(1)
    if (kind === 'memory') result.memoryApply!.reviewRequired = ['正文本身有矛盾，记忆暂缓']
    if (kind === 'settings') result.settingsApply = { applied: 0, skipped: 0, errors: ['设定文件被锁定'], appliedDiffs: [] }
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.completed).toEqual([1])
    expect(progress.pendingPostProcessChapter).toBe(1)
  })

  it('treats self-check execution errors as retryable checks instead of accepted prose issues', async () => {
    const result = resultFor(1)
    result.selfCheck = { ...passedCheck, ok: false, items: [
      { id: 'self_check_error', category: 'structure', label: '自检执行失败', detail: '读取失败',
        verdict: 'fail', repairKind: 'execution_error' }
    ] }
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
  })

  it('prose-first flow writes the outline back before re-checking and syncing memory', async () => {
    stubPostProcess()
    vi.mocked(flow.checkOutlineStream).mockResolvedValue(JSON.stringify([{ type: 3, priority: 'P0',
      actual: '守门人核对印章', suggestion: '以正文为准', outlinePatch: { plotSummary: '林远交出账册，守门人核对印章' } }]))
    const outlineFile = path.join(dir, '细纲', '细纲_第001章_交接1.md')
    const outlineSeenBySelfCheck: string[] = []
    vi.mocked(service.selfCheckChapter).mockImplementation(async () => {
      outlineSeenBySelfCheck.push(await readFile(outlineFile, 'utf-8'))
      return passedCheck
    })
    await service.runFullFlowForChapter(projectId, 1, () => {},
      { contentOverride: content, proseFirst: true } as Parameters<WriteService['runFullFlowForChapter']>[3])
    expect(await readFile(outlineFile, 'utf-8')).toContain('林远交出账册，守门人核对印章')
    // 第二次自检对照的是回写后的细纲
    expect(outlineSeenBySelfCheck).toHaveLength(2)
    expect(outlineSeenBySelfCheck[1]).toContain('林远交出账册，守门人核对印章')
    const syncOpts = vi.mocked(service.syncChapterAfterWrite).mock.calls[0][3]
    expect(syncOpts).toMatchObject({ proseFirst: true, skipIfDisabled: false })
  })

  it('writes a P0 outline change back from the prose instead of pausing', async () => {
    const result = resultFor(1)
    result.outlineDiff.diffs = [{ type: 3, typeLabel: '细节调整', priority: 'P0', actual: '改成另一人',
      suggestion: '参与交接的人换了', outlinePatch: { plotSummary: '正文实际剧情' } }]
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(await readFile(path.join(dir, '细纲', '细纲_第001章_交接1.md'), 'utf-8')).toContain('正文实际剧情')
  })

  function mockCoreChange(): void {
    vi.spyOn(service, 'runFullFlowForChapter').mockImplementation(async (_pid, ch) => {
      const result = resultFor(ch)
      if (ch === 1) result.outlineDiff.diffs = [{ type: 4, typeLabel: '核心事件改', priority: 'P1',
        actual: '提前拿到账册', suggestion: '更新细纲承接', outlinePatch: { plotSummary: '提前拿到账册', title: '模型擅自改名' } }]
      return result
    })
  }

  it('strips model-supplied titles and does not change outlines for later chapters with prose', async () => {
    mockCoreChange()
    await new ProseRepo(dir).write(4, '已经写好的第四章')
    vi.mocked(llm.generateStream).mockResolvedValue(JSON.stringify([2, 3, 4].map((ch) => ({
      chapterNumber: ch, patch: { title: `错误标题${ch}`, plotSummary: `承接新事件${ch}` }
    }))))
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    for (const ch of [1, 2, 3, 4]) {
      const raw = await readFile(path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_交接${ch}.md`), 'utf-8')
      expect(raw).toContain(`交接${ch}`)
      expect(raw).not.toContain('错误标题')
      expect(raw).not.toContain('模型擅自改名')
      if (ch === 4) expect(raw).toContain('原始事件4')
    }
  })

  it('rejects duplicate chapter patches before they can masquerade as three downstream chapters', async () => {
    mockCoreChange()
    vi.mocked(llm.generateStream).mockResolvedValue(JSON.stringify([1, 2, 3].map(() => ({
      chapterNumber: 2, patch: { plotSummary: '重复的第二章补丁' }
    }))))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
    for (const ch of [1, 2]) {
      expect(await readFile(path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_交接${ch}.md`), 'utf-8')).toContain(`原始事件${ch}`)
    }
  })

  it('automatically repairs a downstream chapter returned with an empty patch', async () => {
    mockCoreChange()
    vi.mocked(llm.generateStream)
      .mockResolvedValueOnce(JSON.stringify([
        { chapterNumber: 2, reason: '承接需要调整', patch: { plotSummary: '承接新事件2' } },
        { chapterNumber: 3, reason: '无需修改', patch: {} },
        { chapterNumber: 4, reason: '承接需要调整', patch: { plotSummary: '承接新事件4' } }
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        { chapterNumber: 3, reason: '补齐承接', patch: { plotSummary: '承接新事件3' } }
      ]))
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(await readFile(path.join(dir, '细纲', '细纲_第003章_交接3.md'), 'utf-8')).toContain('承接新事件3')
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })

  it('generates a focused patch for each missing downstream chapter before pausing', async () => {
    mockCoreChange()
    vi.mocked(llm.generateStream)
      .mockResolvedValueOnce(JSON.stringify([
        { chapterNumber: 2, reason: '承接需要调整', patch: { plotSummary: '承接新事件2' } }
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        { chapterNumber: 3, reason: '承接需要调整', patch: { plotSummary: '承接新事件3' } }
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        { chapterNumber: 4, reason: '承接需要调整', patch: { plotSummary: '承接新事件4' } }
      ]))
    const progress = await service.generateChaptersBatch(projectId, 1, 1, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('completed')
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
    expect(vi.mocked(llm.generateStream).mock.calls[1][0]).toContain('遗漏了第 3 章')
    expect(vi.mocked(llm.generateStream).mock.calls[2][0]).toContain('遗漏了第 4 章')
    expect(await readFile(path.join(dir, '细纲', '细纲_第002章_交接2.md'), 'utf-8')).toContain('承接新事件2')
    expect(await readFile(path.join(dir, '细纲', '细纲_第003章_交接3.md'), 'utf-8')).toContain('承接新事件3')
    expect(await readFile(path.join(dir, '细纲', '细纲_第004章_交接4.md'), 'utf-8')).toContain('承接新事件4')
  })

  it('cancels downstream calibration without consuming the original outline differences', async () => {
    mockCoreChange()
    const controller = new AbortController()
    vi.mocked(llm.generateStream).mockImplementation(async (_prompt, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort()
      throw new Error('LLM_ABORTED')
    })
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null,
      { signal: controller.signal }, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(await readFile(path.join(dir, '细纲', '细纲_第001章_交接1.md'), 'utf-8')).toContain('原始事件1')
    expect(service.runFullFlowForChapter).toHaveBeenCalledOnce()
  })

  it('pauses when a P2 outline update fails instead of continuing on its lower priority', async () => {
    const result = resultFor(1)
    result.outlineDiff.diffs = [{ type: 3, typeLabel: '细节调整', priority: 'P2',
      actual: '账册改成蓝色', suggestion: '更新账册颜色', outlinePatch: { plotSummary: '蓝色账册' } }]
    vi.spyOn(service, 'runFullFlowForChapter').mockResolvedValue(result)
    vi.spyOn(DetailedOutlineWriter.prototype, 'update').mockRejectedValue(new Error('EBUSY'))
    const progress = await service.generateChaptersBatch(projectId, 1, 2, () => {}, null, {}, undefined, { autoContinue: true })
    expect(progress.status).toBe('paused')
    expect(progress.pendingPostProcessChapter).toBe(1)
    expect(service.runFullFlowForChapter).toHaveBeenCalledOnce()
  })
})
