import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MobileBatchService,
  MobileBatchError,
  type MobileBatchJob
} from '../src/main/mobile/mobile-batch-service'
import { acquireBatchProject, activeBatchProjects } from '../src/main/data/write-batch-lock'
import type { WriteService } from '../src/main/data/write-service'
import type { BatchProgress, ChapterFlowResult } from '../src/shared/types'

const projectId = 'project-1'
const input = { requestId: 'phone-click-1', fromChapter: 1, toChapter: 2 }
const progress = (status: BatchProgress['status'] = 'completed'): BatchProgress => ({
  fromChapter: 1, toChapter: 2, total: 2, current: 2,
  currentChapter: 2, completed: [1, 2], status
})
const result = (chapter: number): ChapterFlowResult => ({
  chapterNumber: chapter, content: '林远把账册交给门卫。',
  autoDeslop: { status: 'applied', message: '已完成去 AI 味', remainingIssues: 0 },
  outlineDiff: { chapterNumber: chapter, hasOutline: true, checked: true, passed: true, diffs: [] },
  memory: { chapterNumber: chapter, newCharacters: [], newLocations: [], newItems: [], newForeshadowings: [],
    newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] },
  memoryApply: { applied: { characters: 1, locations: 0, items: 0, foreshadowings: 0, plotPoints: 1, stateChanges: 0, collected: 0 }, errors: [] },
  selfCheck: { schemaVersion: 1, chapterNumber: chapter, generatedAt: '', counts: { pass: 1, fail: 0, warn: 0, skip: 0 },
    items: [], ok: true, summary: '通过' },
  audit: { schemaVersion: 1, wordCount: 10, counts: { error: 0, warn: 0, info: 0 }, violations: [],
    passed: { ending: true, forbiddenWords: true, wordCount: true } },
  rhythm: null,
  figure: { chapterNumber: chapter, shouldGenerate: false, type: '', topic: '', fileName: '', html: '', reason: '' }
})

describe('MobileBatchService: 电脑执行、可信恢复与写入安全', () => {
  let service: MobileBatchService
  let dir: string
  let contents: Map<number, string>
  let outlines: Set<number>
  let generate: ReturnType<typeof vi.fn<WriteService['generateChaptersBatch']>>
  let resume: ReturnType<typeof vi.fn<WriteService['resumeChaptersBatch']>>
  let projects: { resolveDir: ReturnType<typeof vi.fn> }
  let chapters: ConstructorParameters<typeof MobileBatchService>[2]
  let references: ConstructorParameters<typeof MobileBatchService>[3]

  const file = () => join(dir, `${createHash('sha256').update(projectId).digest('hex')}.json`)
  const saved = async () => JSON.parse(await readFile(file(), 'utf8')) as { version: number; job: MobileBatchJob }
  const settle = async () => {
    await vi.waitFor(async () => expect((await service.get(projectId))?.running).toBe(false))
    // 最终快照先更新内存再落盘；shutdown 等到最后一次写盘完成。
    await service.shutdown()
  }
  const fresh = () => new MobileBatchService(projects, { generateChaptersBatch: generate, resumeChaptersBatch: resume }, chapters, references, dir)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mobile-batch-'))
    contents = new Map()
    outlines = new Set([1, 2, 3, 4])
    projects = { resolveDir: vi.fn(async () => dir) }
    chapters = { getChapter: vi.fn(async (_id: string, chapter: number) => ({
      content: contents.get(chapter) ?? '',
      meta: { schemaVersion: 1, updatedAt: '', chapterNumber: chapter, title: `交接${chapter}`, wordCount: 0, status: 'outline' as const }
    })) }
    references = { getChapterDetail: vi.fn(async (_id: string, chapter: number) => outlines.has(chapter)
      ? { chapterNumber: chapter, title: `交接${chapter}`, plotSummary: '林远交接账册' } : null) }
    generate = vi.fn<WriteService['generateChaptersBatch']>().mockResolvedValue(progress())
    resume = vi.fn<WriteService['resumeChaptersBatch']>().mockResolvedValue(progress())
    service = fresh()
  })

  afterEach(async () => {
    await service.shutdown()
    expect(activeBatchProjects.size).toBe(0)
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('验证范围和整批细纲后才允许调用写作模型', async () => {
    await expect(service.start(projectId, { ...input, fromChapter: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(service.start(projectId, { ...input, toChapter: 101 })).rejects.toMatchObject({ status: 400 })
    await expect(service.start(projectId, { ...input, requestId: '' })).rejects.toMatchObject({ status: 400 })
    outlines.delete(2)
    await expect(service.start(projectId, input)).rejects.toThrow('第 2 章缺少细纲')
    expect(generate).not.toHaveBeenCalled()
    expect(activeBatchProjects.size).toBe(0)
    expect(await service.get(projectId)).toBeNull()
  })

  it('检查整个范围实际正文，拒绝覆盖，不依赖列表字数', async () => {
    contents.set(2, '已保存正文')
    await expect(service.start(projectId, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('第 2 章已有正文') })
    expect(generate).not.toHaveBeenCalled()
    expect(contents.get(2)).toBe('已保存正文')
  })

  it('与电脑端沿用单批 100 章上限，逐章预检整个范围', async () => {
    outlines = new Set(Array.from({ length: 100 }, (_, index) => index + 1))
    generate.mockResolvedValue({ ...progress(), toChapter: 100, total: 100, current: 100,
      currentChapter: 100, completed: [...outlines] })
    await service.start(projectId, { ...input, toChapter: 100 })
    await settle()
    expect(references.getChapterDetail).toHaveBeenCalledTimes(100)
    expect(generate.mock.calls[0][2]).toBe(100)
    expect((await service.get(projectId))?.progress.total).toBe(100)
  })

  it('开始立即返回且不等待整批结束，重复 requestId 保持幂等', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = await service.start(projectId, input)
    expect(first.running).toBe(true)
    expect((await service.start(projectId, input)).id).toBe(first.id)
    expect(generate).toHaveBeenCalledOnce()
    await expect(service.start(projectId, { ...input, requestId: 'another-click' })).rejects.toMatchObject({ status: 409 })
    finish(progress())
    await settle()
    expect((await service.start(projectId, input)).id).toBe(first.id)
    expect(generate).toHaveBeenCalledOnce()
  })

  it('正文检查点落盘后才返回给写后流程，并完整透传连续模式', async () => {
    generate.mockImplementation(async (_id, _from, _to, onChapter, _style, options, _state, run, onRetry) => {
      expect(run).toEqual({ autoContinue: true, autoStrength: true })
      options!.onGenerationStage!('generating', 1)
      options!.onToken!('甲'.repeat(5_000))
      expect((await service.get(projectId))?.streamText).toHaveLength(4_000)
      contents.set(1, result(1).content)
      await options!.onContentSaved!(1)
      expect((await saved()).job.progress).toMatchObject({ current: 1, completed: [1], pendingPostProcessChapter: 1, status: 'flow' })
      options!.onAutoDeslopResult!(result(1).autoDeslop!, 1)
      onChapter(1, result(1))
      onRetry!(2, 1, 3, 30_000)
      expect((await service.get(projectId))?.retryWait).toMatchObject({ chapter: 2, attempt: 1, maxAttempts: 3, waitMs: 30_000 })
      options!.onGenerationStage!('generating', 2)
      const live = (await service.get(projectId))!
      expect(live.progress.pendingPostProcessChapter).toBeUndefined()
      expect(live.streamText).toBe('')
      contents.set(2, result(2).content)
      await options!.onContentSaved!(2)
      onChapter(2, result(2))
      return progress()
    })
    await service.start(projectId, { ...input, autoStrength: true })
    await settle()
    const job = (await service.get(projectId))!
    expect(job.progress.status).toBe('completed')
    expect(job.stage).toBeUndefined()
    expect(job.retryWait).toBeUndefined()
    expect(job.summaries).toEqual([1, 2].map((chapter) => ({ chapter, wordCount: expect.any(Number), saved: true,
      checks: 'completed', deslop: '已完成去 AI 味', memory: '记忆已同步 2 项' })))
    expect((await saved()).job).toEqual(job)
  })

  it('桌面与手机批量任务共用项目锁，锁释放后可重新启动', async () => {
    const release = acquireBatchProject(projectId)
    await expect(service.start(projectId, input)).rejects.toMatchObject({ status: 409 })
    expect(generate).not.toHaveBeenCalled()
    release()
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await service.start(projectId, input)
    expect(() => acquireBatchProject(projectId)).toThrow('BATCH_ALREADY_RUNNING')
    const otherRelease = acquireBatchProject('another-project')
    otherRelease()
    finish(progress())
    await settle()
    const afterRelease = acquireBatchProject(projectId)
    afterRelease()
  })

  it('旧页面的 jobId 不能停止、继续或清除新任务', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await service.start(projectId, input)
    for (const method of ['stop', 'resume', 'clear'] as const) {
      await expect(service[method](projectId, 'old-job')).rejects.toMatchObject({ status: 409 })
    }
    expect(generate.mock.calls[0][5]?.signal?.aborted).toBe(false)
    finish(progress())
    await settle()
  })

  it('停止保留已保存正文和待补检查点，继续时复用服务端进度', async () => {
    let stopped!: (value: BatchProgress) => void
    generate.mockImplementation(async (_id, _from, _to, _onChapter, _style, options) => {
      contents.set(1, '已保存正文')
      await options!.onContentSaved!(1)
      return await new Promise((resolve) => { stopped = resolve })
    })
    const first = await service.start(projectId, input)
    await vi.waitFor(() => expect(stopped).toBeTypeOf('function'))
    const stopping = await service.stop(projectId, first.id)
    expect(stopping.stopping).toBe(true)
    expect(generate.mock.calls[0][5]?.signal?.aborted).toBe(true)
    stopped({ ...progress('paused'), current: 1, currentChapter: 1, completed: [1], pendingPostProcessChapter: 1,
      pauseReason: '正文已保存，检查尚未完成' })
    await settle()
    service = fresh()
    const restored = (await service.get(projectId))!
    expect(restored.progress.pendingPostProcessChapter).toBe(1)
    resume.mockImplementation(async (_id, from, to, _onChapter, _style, _opts, state) => {
      expect({ from, to, state }).toEqual({ from: 1, to: 2, state: { fromChapter: 1, total: 2, completed: [1], pendingPostProcessChapter: 1 } })
      return progress()
    })
    const resumed = await service.resume(projectId, restored.id)
    expect(resumed.progress.status).toBe('flow')
    expect(resumed.progress.pauseReason).toBeUndefined()
    expect(resumed.progress.error).toBeUndefined()
    await settle()
    expect(generate).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(contents.get(1)).toBe('已保存正文')
  })

  it('电脑重启核对中断章正文，即使完成回调未送达也只补跑检查', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, job: savedJob({ running: true,
      progress: { ...progress('flow'), current: 1, completed: [1], currentChapter: 2 } }) }))
    contents.set(1, '第一章正文')
    contents.set(2, '第二章已保存，尚未发回调')
    const restored = (await service.get(projectId))!
    expect(restored).toMatchObject({ running: false, stopping: false, progress: {
      status: 'paused', current: 2, completed: [1, 2], currentChapter: 2, pendingPostProcessChapter: 2 } })
    expect(restored.progress.pauseReason).toContain('先补跑检查')
    await service.resume(projectId, restored.id)
    await settle()
    expect(resume.mock.calls[0][1]).toBe(2)
    expect(resume.mock.calls[0][6]).toMatchObject({ completed: [1, 2], pendingPostProcessChapter: 2 })
    expect(generate).not.toHaveBeenCalled()
  })

  it('电脑重启时当前章尚未落盘，继续从同一章生成', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, job: savedJob({ running: true,
      progress: { ...progress('generating'), current: 0, completed: [], currentChapter: 1 } }) }))
    const restored = (await service.get(projectId))!
    expect(restored.progress).toMatchObject({ current: 0, completed: [], currentChapter: 1, status: 'paused' })
    expect(restored.progress.pendingPostProcessChapter).toBeUndefined()
    await service.resume(projectId, restored.id)
    await settle()
    expect(resume.mock.calls[0][1]).toBe(1)
    expect(resume.mock.calls[0][6]?.completed).toEqual([])
  })

  it('待补检查的小结在恢复完成后更新为已检查', async () => {
    contents.set(2, '第二章已保存正文')
    await writeFile(file(), JSON.stringify({ version: 1, job: savedJob({
      progress: { ...progress('paused'), pendingPostProcessChapter: 2 },
      summaries: [{ chapter: 2, wordCount: 10, saved: true, checks: 'pending', deslop: '已完成', memory: '记忆已同步' }]
    }) }))
    const job = (await service.get(projectId))!
    await service.resume(projectId, job.id)
    await settle()
    expect((await service.get(projectId))?.summaries[0].checks).toBe('completed')
    expect((await saved()).job.summaries[0].checks).toBe('completed')
  })

  it('shutdown 中止并等待最终进度保存，之后同实例仍能继续', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation((_id, _from, _to, _onChapter, _style, options) => new Promise((resolve) => {
      finish = () => resolve({ ...progress('failed'), current: 0, currentChapter: 1, completed: [], error: 'LLM_ABORTED' })
      options!.signal!.addEventListener('abort', () => {}, { once: true })
    }))
    const job = await service.start(projectId, input)
    let shutdownDone = false
    const shutdown = service.shutdown().then(() => { shutdownDone = true })
    await vi.waitFor(() => expect(generate.mock.calls[0][5]?.signal?.aborted).toBe(true))
    expect(shutdownDone).toBe(false)
    finish(progress())
    await shutdown
    expect((await saved()).job).toMatchObject({ running: false, progress: { status: 'paused', completed: [] } })
    await service.resume(projectId, job.id)
    await settle()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('不能清除运行任务；完成后清除只删进度，保留正文', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const job = await service.start(projectId, input)
    await expect(service.clear(projectId, job.id)).rejects.toMatchObject({ status: 409 })
    contents.set(1, '保留正文')
    finish(progress())
    await settle()
    expect(await service.clear(projectId, job.id)).toBeNull()
    expect(await service.get(projectId)).toBeNull()
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(contents.get(1)).toBe('保留正文')
    await service.start(projectId, { requestId: 'new-batch', fromChapter: 3, toChapter: 4 })
    finish({ ...progress(), fromChapter: 3, toChapter: 4, currentChapter: 4, completed: [3, 4] })
    await settle()
  })

  it('恢复前复查未写范围，不会覆盖任务暂停期间的新正文', async () => {
    generate.mockResolvedValue({ ...progress('paused'), current: 1, currentChapter: 1, completed: [1] })
    const job = await service.start(projectId, input)
    await settle()
    contents.set(2, '用户在电脑端新写的正文')
    await expect(service.resume(projectId, job.id)).rejects.toThrow('第 2 章已有正文')
    expect(resume).not.toHaveBeenCalled()
  })

  it('损坏或伪造的磁盘范围不会成为恢复参数', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, job: savedJob({ progress: {
      ...progress('paused'), completed: [1, 999], current: 2
    } }) }))
    await expect(service.get(projectId)).rejects.toBeInstanceOf(MobileBatchError)
    await expect(service.start(projectId, input)).rejects.toMatchObject({ status: 409 })
    expect(generate).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('异常进度不向手机泄露恢复文件的电脑路径', async () => {
    generate.mockResolvedValue({ ...progress('failed'), current: 0, completed: [], currentChapter: 1,
      error: '保存失败，恢复稿已保存在：C:\\private\\novel\\draft.md' })
    await service.start(projectId, input)
    await settle()
    expect((await service.get(projectId))?.progress.error).toBe('保存失败，恢复稿已保存在：[电脑端恢复文件]')
  })

  it('快照是独立副本，浏览器数据不能修改服务端已完成章节', async () => {
    const first = await service.start(projectId, input)
    first.progress.completed.push(99)
    await settle()
    const current = (await service.get(projectId))!
    expect(current.progress.completed).toEqual([1, 2])
    current.progress.completed.length = 0
    expect((await service.get(projectId))?.progress.completed).toEqual([1, 2])
  })
})

function savedJob(patch: Partial<MobileBatchJob> = {}): MobileBatchJob {
  return {
    id: 'restored-job', projectId, requestId: 'restored-click', autoStrength: false,
    running: false, stopping: false, progress: progress('paused'),
    streamText: '', summaries: [], updatedAt: Date.now(), ...patch
  }
}
