import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterSummaryBatchOptions, ChapterSummaryBatchItem } from '../src/shared/types'

const prose = '林远把账册交给守门人，守门人将账册收进木匣。'
const reply = JSON.stringify({ events: [{ text: '账册交接', evidence: prose }], stateChanges: [], openThreads: [],
  continuity: [{ kind: 'item', subject: '账册', object: '', aspect: '持有者', value: '守门人', evidence: prose }] })

describe('全书批量重新生成概要', () => {
  let root: string, dir: string, id: string, service: WriteService, llm: LlmService
  let summaryModel: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'summary-batch-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    id = (await projects.create({ name: '全书补齐', genre: '玄幻' })).id
    dir = await projects.resolveDir(id)
    summaryModel = vi.fn().mockResolvedValue(reply)
    llm = { generateStream: vi.fn().mockImplementation((prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? JSON.stringify({completed:true,checked:['mainline','knowledge','thread','item','boundary'],findings:[]})
      : summaryModel(prompt, opts)) } as unknown as LlmService
    service = new WriteService(projects, llm)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const options: ChapterSummaryBatchOptions = { fromChapter: 1, toChapter: 500, onlyMissing: false }
  const run = (input = options, signal?: AbortSignal) => service.regenerateSummariesBatch(id, input, () => {}, { signal })

  it('真实模型遗漏回归：仅补缺和普通复用均重建漏掉逐人知情的概要', async () => {
    const evidence = '陆宁此时仍在远处的南关，没有收到消息，仍不知道内应是谁。'
    const early = '陆宁不知道内应是谁。'
    await new ProseRepo(dir).write(3, early)
    await new ProseRepo(dir).write(640, evidence)
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: 3, sourceHash: hashProse(early), generatedAt: '',
      events: [], stateChanges: [], openThreads: [], continuity: [
        { kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '不知内应是谁', evidence: early }
      ] })
    const omitted = { events: [{ text: '陆宁仍不知道内应身份。', evidence }], stateChanges: [], openThreads: [], continuity: [] }
    const correct = { ...omitted, continuity: [{ kind: 'knowledge', subject: '陆宁', object: '内应身份', aspect: '知情程度', value: '仍不知内应是谁', evidence }] }
    const seedIncomplete = () => new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: 640,
      sourceHash: hashProse(evidence), generatedAt: '', ...omitted })
    await seedIncomplete()
    let extractions = 0
    summaryModel.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
      : JSON.stringify(++extractions === 1 ? omitted : correct))
    const first = await run({ fromChapter: 640, toChapter: 640, onlyMissing: true })
    expect(first.results[0].status).toBe('generated')
    expect(extractions).toBe(2)
    expect(summaryModel.mock.calls.some(([prompt]) => prompt.includes('陆宁的知情事实缺少对应连续性台账'))).toBe(true)
    await seedIncomplete()
    const second = await service.generateChapterSummary(id, 640, evidence)
    expect(second.reused).not.toBe(true)
    expect(second.continuity).toEqual(correct.continuity)
    await seedIncomplete()
    summaryModel.mockImplementation(async (_prompt, opts) => opts?.meta?.feature === 'longformGuard'
      ? JSON.stringify({ completed: true, checked: ['mainline', 'knowledge', 'thread', 'item', 'boundary'], findings: [] })
      : JSON.stringify(omitted))
    const failed = await run({ fromChapter: 640, toChapter: 640, onlyMissing: true })
    expect(failed.results[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('MEMORY_KNOWLEDGE_INCOMPLETE') })
    const complete = service as unknown as { completeChapterSummary: (id: string, dir: string, chapter: number, content: string) => Promise<unknown> }
    await expect(complete.completeChapterSummary(id, dir, 640, evidence)).rejects.toThrow('MEMORY_KNOWLEDGE_INCOMPLETE')
    expect((await new ChapterSummaryRepo(dir).read(640))?.events).toEqual(omitted.events)
  })

  it('覆盖全书及稀疏章号，每章立即保存；单章失败不影响后续，继续时跳过成功且未改正文的章', async () => {
    for (const n of [1, 2, 201]) await new ProseRepo(dir).write(n, prose)
    summaryModel.mockResolvedValueOnce(reply).mockRejectedValueOnce(new Error('临时断网')).mockResolvedValueOnce(reply)
    const complete = vi.fn<(result: ChapterSummaryBatchItem) => void>()
    const progress = vi.fn()
    const first = await service.regenerateSummariesBatch(id, options, complete, { onProgress: progress })
    expect(first.ok).toBe(false)
    expect(first.results.map((r) => [r.chapterNumber, r.status])).toEqual([[1, 'generated'], [2, 'failed'], [201, 'generated']])
    expect(complete).toHaveBeenCalledTimes(3)
    expect(progress.mock.calls.map(([p]) => p)).toEqual([
      { chapter: 1, index: 1, total: 3 }, { chapter: 2, index: 2, total: 3 }, { chapter: 201, index: 3, total: 3 }
    ])
    expect((await new ChapterSummaryRepo(dir).read(201))?.continuity?.[0].value).toBe('守门人')
    const completed = first.results.filter((r) => r.sourceHash).map((r) => ({ chapterNumber: r.chapterNumber, sourceHash: r.sourceHash! }))
    const second = await run({ ...options, completed })
    expect(second.results.map((r) => r.status)).toEqual(['reused', 'generated', 'reused'])
    expect(summaryModel).toHaveBeenCalledTimes(4)
    expect(await new ProseRepo(dir).read(1)).toBe(prose)
  })

  it('仅补缺失模式重建旧格式与过期概要，跳过有效新概要；改稿后的成功章也重新处理', async () => {
    for (const n of [1, 2, 3]) await new ProseRepo(dir).write(n, prose)
    await service.generateChapterSummary(id, 1, prose)
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: 2, sourceHash: hashProse(prose), generatedAt: '',
      events: [], stateChanges: [], openThreads: [] })
    await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: 3, sourceHash: 'old', generatedAt: '',
      events: [], stateChanges: [], openThreads: [], continuity: [] })
    const result = await run({ ...options, onlyMissing: true })
    expect(result.results.map((r) => r.status)).toEqual(['reused', 'generated', 'generated'])
    const changed = `${prose}林远随即离开。`
    await new ProseRepo(dir).write(1, changed)
    const next = await run({ ...options, completed: [{ chapterNumber: 1, sourceHash: hashProse(prose) }] })
    expect(next.results[0].status).toBe('generated')
    expect((await new ChapterSummaryRepo(dir).read(1))?.sourceHash).toBe(hashProse(changed))
  })

  it('停止中断当前模型请求，已保存概要保留，尚未开始的章节不调用模型', async () => {
    for (const n of [1, 2, 3]) await new ProseRepo(dir).write(n, prose)
    const controller = new AbortController()
    summaryModel.mockImplementation(async (_text, opts) => {
      if (opts?.meta?.chapterNumber === 1) return reply
      return new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('LLM_ABORTED')), { once: true }))
    })
    const task = run(options, controller.signal)
    await vi.waitFor(() => expect(summaryModel).toHaveBeenCalledTimes(2))
    controller.abort()
    const result = await task
    expect(result.stopped).toBe(true)
    expect(result.results.map((r) => r.chapterNumber)).toEqual([1])
    expect(await new ChapterSummaryRepo(dir).read(1)).not.toBeNull()
    expect(await new ChapterSummaryRepo(dir).read(2)).toBeNull()
    expect(summaryModel).toHaveBeenCalledTimes(2)
  })

  it('缺少连续性数组时自动重新提取，原概要仅在新稿验证通过后替换', async () => {
    await new ProseRepo(dir).write(1, prose)
    await service.generateChapterSummary(id, 1, prose)
    summaryModel.mockResolvedValueOnce(JSON.stringify({ events: [{ text: '交接', evidence: prose }], stateChanges: [], openThreads: [] }))
    const result = await run()
    expect(result.results[0].status).toBe('generated')
    expect(result.ok).toBe(true)
    expect((await new ChapterSummaryRepo(dir).read(1))?.continuity?.[0].value).toBe('守门人')
    expect(summaryModel).toHaveBeenCalledTimes(3)
    expect(summaryModel.mock.calls[2][0]).toContain('自动修复并重新提取')
  })

  it('生成期间正文改变时拒绝提交旧稿概要', async () => {
    await new ProseRepo(dir).write(1, prose)
    summaryModel.mockImplementationOnce(async () => {
      await new ProseRepo(dir).write(1, '林远转身离去，账册仍在原处。')
      return reply
    })
    const result = await run()
    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].error).toContain('旧概要未写入')
    expect(await new ChapterSummaryRepo(dir).read(1)).toBeNull()
  })

  it('拒绝非法范围，空范围和预先停止不调用模型', async () => {
    expect((await run({ ...options, fromChapter: 0 })).ok).toBe(false)
    expect((await run()).error).toContain('没有已保存正文')
    const controller = new AbortController(); controller.abort()
    expect((await run(options, controller.signal)).stopped).toBe(true)
    expect(summaryModel).not.toHaveBeenCalled()
  })
})
