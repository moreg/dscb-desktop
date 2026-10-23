import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter } from '../src/main/data/skill-format/detailed-outline-writer'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterGenerationStage } from '../src/shared/types'

const previous = '师父把钥匙交给林远，让他守在山门。林远接住钥匙，留在门边等候。'
const ending = { chapterNumber: 1, characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] }
let root: string, dir: string, id: string, service: WriteService
let generate: ReturnType<typeof vi.fn>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writing-context-recovery-'))
  const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
  const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
  id = (await projects.create({ name: '自动补齐', genre: '玄幻' })).id
  dir = await projects.resolveDir(id)
  await mkdir(join(dir, '大纲'), { recursive: true })
  generate = vi.fn(async (_prompt, opts) => {
    if (opts?.meta?.feature === 'outline-generate') return JSON.stringify({ plotSummary: '林远依照师父嘱咐守门，核对来客的身份。', charactersAppearing: [], foreshadowings: [] })
    if (opts?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
    if (opts?.meta?.feature === 'chapterSummary') return JSON.stringify({ events: [{ text: '师父交出钥匙，林远守门。', evidence: previous }], stateChanges: [], openThreads: [], continuity: [] })
    return '林远抬起手，示意来客在门外等候。'
  })
  service = new WriteService(projects, { generateStream: generate } as unknown as LlmService)
  vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockResolvedValue(ending)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function plan(number: number, summary = '林远核对来客') {
  await new OutlineRepository(dir).upsertDetailed({ chapterNumber: number, plotSummary: summary })
}
function chapterPrompt(): string { return generate.mock.calls.find(call => call[1]?.meta?.feature === 'chapter')![0] }
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe('automatic writing context recovery', () => {
  it('reviews the previous chapter only once when rebuilding its summary, including CLI routes without cache identity', async () => {
    await plan(1)
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    await writeFile(join(dir, '大纲', '大纲.md'), '# 守门\n\n## 主线剧情走向\n\n林远守住山门，查清来客身份。')
    await service.buildChapterPrompt(id, 2, null, undefined, undefined, true)
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'longformGuard')).toHaveLength(1)
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapterSummary')).toHaveLength(1)
    expect(await new ChapterSummaryRepo(dir).readCurrent(1, previous)).not.toBeNull()
  })

  it('starts ending extraction while the previous summary is still waiting and reuses its result', async () => {
    await plan(1)
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const original = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') await blocked
      return original(prompt, opts)
    })
    const preparation = service.buildChapterPrompt(id, 2, null, undefined, undefined, true)
    try {
      await vi.waitFor(() => {
        expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapterSummary')).toBe(true)
        expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(1)
      })
    } finally { release() }
    await preparation
    expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(1)
  })

  it('overlaps ending extraction with prose using complete source, but waits before saving', async () => {
    await plan(1)
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const summaryGate = deferred()
    const endingGate = deferred()
    const chapterStarted = deferred()
    const chapterGate = deferred()
    const stages: ChapterGenerationStage[] = []
    const tokens: string[] = []
    const onProseGenerated = vi.fn()
    let sendToken!: (token: string) => void
    const original = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') await summaryGate.promise
      if (opts?.meta?.feature === 'chapter') {
        sendToken = opts.onToken
        chapterStarted.release()
        await chapterGate.promise
      }
      return original(prompt, opts)
    })
    vi.mocked(WriteFlowService.prototype.extractEndingState).mockImplementation(async () => {
      await endingGate.promise
      return ending
    })
    const generation = service.generateChapterStream(id, 2, {
      onGenerationStage: stage => stages.push(stage),
      onToken: token => tokens.push(token), onProseGenerated
    })
    const expectStillPreparing = (): void => {
      expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapter')).toBe(false)
      expect(stages).not.toContain('waiting')
      expect(stages).not.toContain('generating')
    }
    try {
      await vi.waitFor(() => {
        expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapterSummary')).toBe(true)
        expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(1)
      })
      expect(stages.at(-1)).toBe('preparing:正在准备：前章长期核对与概要、上章结尾状态')
      expectStillPreparing()

      summaryGate.release()
      await chapterStarted.promise
      expect(chapterPrompt()).toContain(previous)
      expect(stages.at(-1)).toBe('waiting')
      expect(stages).not.toContain('generating')
      sendToken('')
      sendToken(' \n')
      expect(stages.at(-1)).toBe('waiting')
      sendToken('林远抬起手，')
      sendToken('示意来客在门外等候。')
      expect(stages.at(-1)).toBe('generating')
      expect(stages.filter(stage => stage === 'generating')).toHaveLength(1)
      expect(tokens).toEqual(['', ' \n', '林远抬起手，', '示意来客在门外等候。'])
      chapterGate.release()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(onProseGenerated).not.toHaveBeenCalled()
      expect(await new ProseRepo(dir).read(2)).toBe('')
      endingGate.release()
      await generation
      expect(onProseGenerated).toHaveBeenCalledTimes(1)
    } finally {
      summaryGate.release()
      endingGate.release()
      chapterGate.release()
      await generation
    }
    expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it.each(['cancel', 'source'] as const)('does not save overlapped prose after %s changes before ending extraction completes', async change => {
    await plan(1); await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const gate = deferred(), started = deferred()
    const controller = new AbortController(), onProseGenerated = vi.fn()
    vi.mocked(WriteFlowService.prototype.extractEndingState).mockImplementation(async () => { await gate.promise; return ending })
    const original = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapter') started.release()
      return original(prompt, opts)
    })
    const result = service.generateChapterStream(id, 2, {signal: controller.signal, onProseGenerated})
    const rejected = expect(result).rejects.toThrow(change === 'cancel' ? 'LLM_ABORTED' : 'LONGFORM_CONTEXT_CHANGED')
    await started.promise
    if (change === 'cancel') controller.abort()
    else await new ProseRepo(dir).write(1, previous + '师父取回了钥匙。')
    gate.release()
    await rejected
    expect(onProseGenerated).not.toHaveBeenCalled()
    expect(await new ProseRepo(dir).read(2)).toBe('')
  })

  it.each(['failed', 'cancelled'] as const)('does not announce or request prose when preparation is %s', async outcome => {
    await plan(1)
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const outlineFile = join(dir, '大纲', '大纲.md')
    await writeFile(outlineFile, '# 守门\n\n## 主线剧情走向\n\n林远守住山门，查清来客身份。')
    const controller = new AbortController()
    const stages: ChapterGenerationStage[] = []
    const original = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') {
        if (outcome === 'cancelled') controller.abort()
        else await writeFile(outlineFile, '# 守门\n\n## 主线剧情走向\n\n林远离开山门去寻找师父。')
      }
      return original(prompt, opts)
    })
    await expect(service.generateChapterStream(id, 2, {
      signal: controller.signal,
      onGenerationStage: stage => stages.push(stage)
    })).rejects.toThrow(outcome === 'cancelled' ? 'LLM_ABORTED' : 'LONGFORM_CONTEXT_CHANGED')
    expect(stages.some(stage => stage.startsWith('preparing:'))).toBe(true)
    expect(stages).not.toContain('waiting')
    expect(stages).not.toContain('generating')
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapter')).toBe(false)
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
  })

  it.each(['plan', 'prose', 'cancel'] as const)('does not commit a summary using a reused review after %s changes during extraction', async change => {
    await plan(1)
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const file = join(dir, '大纲', '大纲.md')
    await writeFile(file, '# 守门\n\n## 主线剧情走向\n\n林远守住山门，查清来客身份。')
    const controller = new AbortController()
    const original = generate.getMockImplementation()!
    generate.mockImplementation(async (prompt, opts) => {
      if (opts?.meta?.feature === 'chapterSummary') {
        if (change === 'plan') await writeFile(file, '# 守门\n\n## 主线剧情走向\n\n作者修改主线：林远离开山门去寻找师父。')
        if (change === 'prose') await new ProseRepo(dir).write(1, previous + '师父又取回钥匙。')
        if (change === 'cancel') controller.abort()
      }
      return original(prompt, opts)
    })
    await expect(service.buildChapterPrompt(id, 2, null, undefined, undefined, true, controller.signal))
      .rejects.toThrow(change === 'cancel' ? 'LLM_ABORTED' : 'LONGFORM_CONTEXT_CHANGED')
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapter')).toBe(false)
  })

  it('creates a missing outline and continues writing without a manual resume', async () => {
    await service.generateChapterStream(id, 1)
    expect((await new DetailedOutlineMdRepo(dir).readChapter(1))?.plotSummary).toContain('守门')
    expect(chapterPrompt()).toContain('守门')
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('uses a sourced writing plan when outline generation cannot return JSON', async () => {
    generate.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'outline-generate' ? '不是 JSON' : '林远守在山门。')
    await service.generateChapterStream(id, 1)
    expect(chapterPrompt()).toContain('自动补齐写作安排')
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'outline-generate')).toHaveLength(3)
    expect(generate.mock.calls.filter(call => call[1]?.meta?.feature === 'chapter')).toHaveLength(1)
  })

  it('loads both legacy outlines, restores prior prose from history and rebuilds dated memory before writing', async () => {
    await plan(1, '上一章交出钥匙')
    await plan(2, '本章核对来客')
    await new ChapterVersionRepository(dir).create(1, { source: 'manual', content: previous })
    await service.generateChapterStream(id, 2)
    expect(await new ProseRepo(dir).read(1)).toBe(previous)
    expect(chapterPrompt()).toContain(previous)
    expect(chapterPrompt()).toContain('上一章交出钥匙')
    expect(chapterPrompt()).toContain('本章核对来客')
    expect(await new ChapterSummaryRepo(dir).readCurrent(1, previous)).toMatchObject({ continuity: [] })
    expect(generate.mock.calls.findIndex(call => call[1]?.meta?.feature === 'chapterSummary'))
      .toBeLessThan(generate.mock.calls.findIndex(call => call[1]?.meta?.feature === 'chapter'))
    await new DetailedOutlineWriter(dir).update(2, { plotSummary: '更新后的旧格式细纲' })
    expect((await new DetailedOutlineMdRepo(dir).readChapter(2))?.plotSummary).toBe('更新后的旧格式细纲')
    expect((await new DetailedOutlineMdRepo(dir).listAll()).map(item => item.chapterNumber)).toEqual([1, 2])
  })

  it('rebuilds a missing previous outline from verified prose instead of inventing history', async () => {
    await plan(2)
    await new ProseRepo(dir).write(1, previous)
    await service.generateChapterStream(id, 2)
    expect((await new DetailedOutlineMdRepo(dir).readChapter(1))?.plotSummary).toContain('交出钥匙')
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'outline-generate')).toBe(false)
  })

  it('retries transient memory reads and then writes with the complete previous manuscript', async () => {
    await plan(1); await plan(2)
    await new ProseRepo(dir).write(1, previous)
    const read = vi.spyOn(TrackingMdRepo.prototype, 'read').mockRejectedValueOnce(new Error('文件暂时被占用')).mockResolvedValue(null)
    await service.generateChapterStream(id, 2)
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(chapterPrompt()).toContain(previous)
  })

  it('falls back to original evidence when summary and ending extraction fail, without fabricating facts or stopping', async () => {
    await plan(1); await plan(2)
    await new ProseRepo(dir).write(1, previous)
    generate.mockImplementation(async (_prompt, opts) => {
      if (opts?.meta?.feature === 'longformGuard') return JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item'],findings:[]})
    if (opts?.meta?.feature === 'chapterSummary') throw new Error('提取暂时不可用')
      return '林远示意来客等候。'
    })
    vi.mocked(WriteFlowService.prototype.extractEndingState).mockRejectedValue(new Error('状态提取失败'))
    await service.generateChapterStream(id, 2)
    expect(chapterPrompt()).toContain(previous)
    const saved = await new ChapterSummaryRepo(dir).readCurrent(1, previous)
    expect(saved?.events.every(item => previous.includes(item.evidence))).toBe(true)
    expect(saved?.stateChanges).toEqual([])
    const check = await service.selfCheckChapter(id, 2, '林远示意来客等候。')
    expect(check.items.find(item => item.id === 'prev_state_fallback')?.verdict).toBe('warn')
    expect(WriteFlowService.prototype.extractEndingState).toHaveBeenCalledTimes(3)
  })

  it('continues with explicitly labelled planned context when no prior manuscript can be recovered', async () => {
    await plan(1, '计划由师父交出钥匙'); await plan(2)
    await service.generateChapterStream(id, 2)
    expect(chapterPrompt()).toContain('上一章自动补齐资料')
    expect(chapterPrompt()).toContain('细纲属于计划，不代表已发生')
    expect(chapterPrompt()).not.toContain('**上一章完整正文**')
    expect(await new ProseRepo(dir).read(1)).toBe('')
    expect(WriteFlowService.prototype.extractEndingState).not.toHaveBeenCalled()
  })

  it('preserves an unusually long previous manuscript and stops rather than bypassing full-chapter review', async () => {
    await plan(1); await plan(2)
    const long = '开篇事实。' + '林远在门外等候。'.repeat(6000) + '最后的衔接。'
    await new ProseRepo(dir).write(1, long)
    await expect(service.generateChapterStream(id, 2)).rejects.toThrow('40000')
    expect(await new ProseRepo(dir).read(1)).toBe(long)
    expect(generate.mock.calls.some(call => call[1]?.meta?.feature === 'chapter')).toBe(false)
  })
})
