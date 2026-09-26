import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
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
    llm = { generateStream: vi.fn().mockResolvedValue('[]') } as unknown as LlmService
    service = new WriteService(ps, llm, undefined, undefined, undefined, settings)
    flow = (service as unknown as { flow: WriteFlowService }).flow
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    for (const ch of [1, 2, 3, 4]) {
      await writeFile(path.join(dir, '细纲', `细纲_第${String(ch).padStart(3, '0')}章_交接${ch}.md`),
        `# 细纲\n\n## 第 ${ch} 章：交接${ch}\n\n> 所属卷：第 1 卷\n\n- **核心事件**：原始事件${ch}\n`, 'utf-8')
    }
  })

  afterEach(() => vi.restoreAllMocks())

  function stubPostProcess(): void {
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
