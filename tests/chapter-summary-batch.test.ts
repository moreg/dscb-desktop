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
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'summary-batch-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    id = (await projects.create({ name: '全书补齐', genre: '玄幻' })).id
    dir = await projects.resolveDir(id)
    llm = { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
    service = new WriteService(projects, llm)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const options: ChapterSummaryBatchOptions = { fromChapter: 1, toChapter: 500, onlyMissing: false }
  const run = (input = options, signal?: AbortSignal) => service.regenerateSummariesBatch(id, input, () => {}, { signal })

  it('覆盖全书及稀疏章号，每章立即保存；单章失败不影响后续，继续时跳过成功且未改正文的章', async () => {
    for (const n of [1, 2, 201]) await new ProseRepo(dir).write(n, prose)
    vi.mocked(llm.generateStream).mockResolvedValueOnce(reply).mockRejectedValueOnce(new Error('临时断网')).mockResolvedValueOnce(reply)
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
    expect(llm.generateStream).toHaveBeenCalledTimes(4)
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
    vi.mocked(llm.generateStream).mockImplementation(async (_text, opts) => {
      if (opts?.meta?.chapterNumber === 1) return reply
      return new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('LLM_ABORTED')), { once: true }))
    })
    const task = run(options, controller.signal)
    await vi.waitFor(() => expect(llm.generateStream).toHaveBeenCalledTimes(2))
    controller.abort()
    const result = await task
    expect(result.stopped).toBe(true)
    expect(result.results.map((r) => r.chapterNumber)).toEqual([1])
    expect(await new ChapterSummaryRepo(dir).read(1)).not.toBeNull()
    expect(await new ChapterSummaryRepo(dir).read(2)).toBeNull()
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })

  it('缺少连续性数组或证据无效时不覆盖旧概要，失败可再次处理', async () => {
    await new ProseRepo(dir).write(1, prose)
    await service.generateChapterSummary(id, 1, prose)
    const old = await new ChapterSummaryRepo(dir).read(1)
    vi.mocked(llm.generateStream).mockResolvedValueOnce(JSON.stringify({ events: [{ text: '交接', evidence: prose }], stateChanges: [], openThreads: [] }))
    const result = await run()
    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].error).toContain('连续性记录')
    expect(await new ChapterSummaryRepo(dir).read(1)).toEqual(old)
    expect((await run()).ok).toBe(true)
  })

  it('生成期间正文改变时拒绝提交旧稿概要', async () => {
    await new ProseRepo(dir).write(1, prose)
    vi.mocked(llm.generateStream).mockImplementationOnce(async () => {
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
    expect(llm.generateStream).not.toHaveBeenCalled()
  })
})
