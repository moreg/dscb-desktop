import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { getBatchRangeError, MAX_BATCH_CHAPTERS } from '../../shared/batch-range'
import type { BatchProgress, ChapterContent, ChapterDetail, ChapterFlowResult } from '../../shared/types'
import { writeJsonAtomic } from '../data/atomic'
import { acquireBatchProject } from '../data/write-batch-lock'
import type { BatchGenerateOptions, WriteService } from '../data/write-service'
import { countWords } from '../data/words'

const chapterSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const mobileBatchInputSchema = z.object({
  requestId: z.string().trim().min(1).max(255),
  fromChapter: chapterSchema,
  toChapter: chapterSchema,
  autoStrength: z.boolean().optional()
}).superRefine((input, ctx) => {
  const error = getBatchRangeError(input.fromChapter, input.toChapter)
  if (error) ctx.addIssue({ code: 'custom', message: error })
})

export type MobileBatchStartInput = z.infer<typeof mobileBatchInputSchema>

export interface MobileBatchSummary {
  chapter: number
  wordCount: number
  saved: true
  checks: 'completed' | 'pending'
  deslop: string
  memory: string
}

export interface MobileBatchJob {
  id: string
  projectId: string
  requestId: string
  autoStrength: boolean
  running: boolean
  stopping: boolean
  progress: BatchProgress
  stage?: 'generating' | 'deslop' | 'checking'
  streamText: string
  summaries: MobileBatchSummary[]
  retryWait?: {
    chapter: number
    attempt: number
    maxAttempts: number
    waitMs: number
    retryAt: number
  }
  updatedAt: number
}

export interface MobileBatchRunner {
  get(projectId: string): Promise<MobileBatchJob | null>
  start(projectId: string, input: MobileBatchStartInput): Promise<MobileBatchJob>
  resume(projectId: string, jobId: string): Promise<MobileBatchJob>
  stop(projectId: string, jobId: string): Promise<MobileBatchJob>
  clear(projectId: string, jobId: string): Promise<null>
  shutdown(): Promise<void>
}

export class MobileBatchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'MobileBatchError'
  }
}

type BatchWriter = Pick<WriteService, 'generateChaptersBatch' | 'resumeChaptersBatch'>
type Projects = { resolveDir(projectId: string): Promise<string> }
type Chapters = { getChapter(projectId: string, chapterNumber: number): Promise<ChapterContent> }
type References = { getChapterDetail(projectId: string, chapterNumber: number): Promise<ChapterDetail | null> }
type ActiveRun = { controller: AbortController; promise: Promise<void> }

const progressSchema = z.object({
  total: z.number().int().min(1).max(MAX_BATCH_CHAPTERS),
  current: z.number().int().min(0).max(MAX_BATCH_CHAPTERS),
  currentChapter: chapterSchema,
  fromChapter: chapterSchema,
  toChapter: chapterSchema,
  status: z.enum(['pending', 'generating', 'flow', 'paused', 'completed', 'failed']),
  pauseReason: z.string().max(2_000).optional(),
  error: z.string().max(2_000).optional(),
  pendingPostProcessChapter: chapterSchema.optional(),
  completed: z.array(chapterSchema).max(MAX_BATCH_CHAPTERS)
})

const savedJobSchema = z.object({
  version: z.literal(1),
  job: z.object({
    id: z.string().min(1).max(255),
    projectId: z.string().min(1).max(255),
    requestId: z.string().min(1).max(255),
    autoStrength: z.boolean(),
    running: z.boolean(),
    stopping: z.boolean(),
    progress: progressSchema,
    stage: z.enum(['generating', 'deslop', 'checking']).optional(),
    streamText: z.string().max(4_000),
    summaries: z.array(z.object({
      chapter: chapterSchema,
      wordCount: z.number().int().min(0),
      saved: z.literal(true),
      checks: z.enum(['completed', 'pending']),
      deslop: z.string().max(300),
      memory: z.string().max(300)
    })).max(MAX_BATCH_CHAPTERS),
    retryWait: z.object({
      chapter: chapterSchema,
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      waitMs: z.number().int().positive(),
      retryAt: z.number().finite()
    }).optional(),
    updatedAt: z.number().finite()
  })
})

/** 手机只提交启动/停止指令；进度与恢复参数始终来自电脑端保存的任务。 */
export class MobileBatchService implements MobileBatchRunner {
  private readonly jobs = new Map<string, MobileBatchJob | null>()
  private readonly runs = new Map<string, ActiveRun>()
  private readonly commandTails = new Map<string, Promise<void>>()
  private readonly saveTails = new Map<string, Promise<void>>()
  private closed = false

  constructor(
    private readonly projects: Projects,
    private readonly writer: BatchWriter,
    private readonly chapters: Chapters,
    private readonly references: References,
    private readonly storageDir: string
  ) {}

  get(projectId: string): Promise<MobileBatchJob | null> {
    return this.command(projectId, async () => {
      await this.projectDir(projectId)
      return clone(await this.load(projectId))
    })
  }

  start(projectId: string, input: MobileBatchStartInput): Promise<MobileBatchJob> {
    return this.command(projectId, async () => {
      this.assertOpen()
      const parsed = mobileBatchInputSchema.safeParse(input)
      if (!parsed.success) throw new MobileBatchError(400, parsed.error.issues[0]?.message || '批量写作参数无效')
      const args = parsed.data
      await this.projectDir(projectId)
      const previous = await this.load(projectId)
      if (previous?.requestId === args.requestId) return clone(previous)!
      if (this.runs.has(projectId) || (previous && previous.progress.status !== 'completed')) {
        throw new MobileBatchError(409, '该作品已有批量任务，请先继续或清除原任务')
      }
      const release = this.lock(projectId)
      try {
        await this.preflight(projectId, args.fromChapter, args.toChapter)
        const job: MobileBatchJob = {
          id: randomUUID(), projectId, requestId: args.requestId,
          autoStrength: args.autoStrength === true, running: true, stopping: false,
          progress: {
            fromChapter: args.fromChapter, toChapter: args.toChapter,
            total: args.toChapter - args.fromChapter + 1, current: 0,
            currentChapter: args.fromChapter, completed: [], status: 'generating'
          },
          stage: 'generating', streamText: '', summaries: [], updatedAt: Date.now()
        }
        await this.save(job)
        this.jobs.set(projectId, job)
        this.launch(job, false, release)
        return clone(job)!
      } catch (error) {
        release()
        throw error
      }
    })
  }

  resume(projectId: string, jobId: string): Promise<MobileBatchJob> {
    return this.command(projectId, async () => {
      this.assertOpen()
      await this.projectDir(projectId)
      const job = await this.requireJob(projectId, jobId)
      if (this.runs.has(projectId)) throw new MobileBatchError(409, '任务仍在运行或停止中，请稍后再继续')
      if (job.progress.status === 'completed') return clone(job)!
      const next = resumeChapter(job.progress)
      if (next > job.progress.toChapter) throw new MobileBatchError(409, '本批章节已保存，请重新查看任务进度')
      const release = this.lock(projectId)
      try {
        await this.preflight(projectId, next, job.progress.toChapter, job.progress.pendingPostProcessChapter)
        job.running = true
        job.stopping = false
        job.streamText = ''
        job.stage = job.progress.pendingPostProcessChapter ? 'checking' : 'generating'
        job.progress.status = job.progress.pendingPostProcessChapter ? 'flow' : 'generating'
        delete job.progress.pauseReason
        delete job.progress.error
        delete job.retryWait
        await this.save(job)
        this.launch(job, true, release)
        return clone(job)!
      } catch (error) {
        job.running = false
        release()
        throw error
      }
    })
  }

  stop(projectId: string, jobId: string): Promise<MobileBatchJob> {
    return this.command(projectId, async () => {
      await this.projectDir(projectId)
      const job = await this.requireJob(projectId, jobId)
      const run = this.runs.get(projectId)
      if (run) {
        job.stopping = true
        run.controller.abort()
        await this.save(job)
      }
      return clone(job)!
    })
  }

  clear(projectId: string, jobId: string): Promise<null> {
    return this.command(projectId, async () => {
      await this.projectDir(projectId)
      await this.requireJob(projectId, jobId)
      if (this.runs.has(projectId)) throw new MobileBatchError(409, '请先停止任务，等待正文与进度保存后再清除记录')
      await (this.saveTails.get(projectId) ?? Promise.resolve())
      await fs.rm(this.file(projectId), { force: true })
      this.jobs.set(projectId, null)
      return null
    })
  }

  async shutdown(): Promise<void> {
    this.closed = true
    // 正在预检的启动指令也必须完成登记，才能一并中止。
    await Promise.allSettled([...this.commandTails.values()])
    for (const [projectId, run] of this.runs) {
      const job = this.jobs.get(projectId)
      if (job) job.stopping = true
      run.controller.abort()
    }
    await Promise.allSettled([...this.runs.values()].map((run) => run.promise))
    await Promise.allSettled([...this.saveTails.values()])
    // 手机服务关停/重新启动不应阻止之后新配对设备继续操作。
    this.closed = false
  }

  private async preflight(projectId: string, from: number, to: number, pending?: number): Promise<void> {
    for (let chapter = from; chapter <= to; chapter++) {
      const [saved, detail] = await Promise.all([
        this.chapters.getChapter(projectId, chapter),
        this.references.getChapterDetail(projectId, chapter)
      ])
      if (!detail?.plotSummary?.trim()) {
        throw new MobileBatchError(400, `第 ${chapter} 章缺少细纲，请先在电脑端补齐后再开始`)
      }
      if (chapter === pending) {
        if (!saved.content.trim()) throw new MobileBatchError(409, `第 ${chapter} 章待检查的正文已不存在，请清除任务后重新选择范围`)
      } else if (saved.content.trim()) {
        throw new MobileBatchError(409, `第 ${chapter} 章已有正文，请选择连续未写章节，避免覆盖`)
      }
    }
  }

  private launch(job: MobileBatchJob, resume: boolean, release: () => void): void {
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.execute(job, resume, controller)).finally(() => {
      release()
      this.runs.delete(job.projectId)
    })
    this.runs.set(job.projectId, { controller, promise })
    // execute 已把运行错误转为任务进度；这里只处理最后一次持久化失败。
    void promise.catch((error: unknown) => console.error('[mobile-batch] final checkpoint failed:', error))
  }

  private async execute(job: MobileBatchJob, resume: boolean, controller: AbortController): Promise<void> {
    const previous = clone(job.progress)!
    const options: BatchGenerateOptions = {
      signal: controller.signal,
      onToken: (token) => {
        job.streamText = (job.streamText + token).slice(-4_000)
        job.updatedAt = Date.now()
      },
      onGenerationStage: (stage, chapter) => {
        job.stage = stage === 'foreshadowRepair' ? 'checking' : stage
        job.progress.currentChapter = chapter
        job.progress.status = 'generating'
        // 下一章开始说明上一章写后处理已完成。
        if (job.progress.pendingPostProcessChapter !== chapter) delete job.progress.pendingPostProcessChapter
        if (stage === 'generating') job.streamText = ''
        delete job.retryWait
        this.checkpoint(job)
      },
      onAutoDeslopResult: (_result, chapter) => {
        job.stage = 'checking'
        job.progress.currentChapter = chapter
        job.progress.status = 'flow'
        this.checkpoint(job)
      },
      onContentSaved: async (chapter) => {
        if (!job.progress.completed.includes(chapter)) job.progress.completed.push(chapter)
        job.progress.completed.sort((a, b) => a - b)
        job.progress.current = job.progress.completed.length
        job.progress.currentChapter = chapter
        job.progress.pendingPostProcessChapter = chapter
        job.progress.status = 'flow'
        job.stage = 'checking'
        await this.save(job)
      }
    }
    try {
      const run = resume ? this.writer.resumeChaptersBatch.bind(this.writer) : this.writer.generateChaptersBatch.bind(this.writer)
      const progress = await run(
        job.projectId, previous.currentChapter, previous.toChapter,
        (chapter, result) => {
          if (!job.progress.completed.includes(chapter)) job.progress.completed.push(chapter)
          job.progress.completed.sort((a, b) => a - b)
          job.progress.current = job.progress.completed.length
          job.progress.currentChapter = chapter
          job.progress.pendingPostProcessChapter = chapter
          const previousSummary = job.summaries.find((summary) => summary.chapter === chapter)
          const deslopFallback = previousSummary?.deslop ?? (resume && previous.pendingPostProcessChapter === chapter
            ? '复用已保存正文，无需再次去 AI 味' : '未返回去 AI 味报告')
          job.summaries = [...job.summaries.filter((summary) => summary.chapter !== chapter), summarize(chapter, result, deslopFallback)]
            .sort((a, b) => a.chapter - b.chapter)
          job.streamText = ''
          delete job.retryWait
          this.checkpoint(job)
        },
        null, options,
        resume ? {
          fromChapter: previous.fromChapter, total: previous.total,
          completed: previous.completed, pendingPostProcessChapter: previous.pendingPostProcessChapter
        } : undefined,
        { autoContinue: true, autoStrength: job.autoStrength },
        (chapter, attempt, maxAttempts, waitMs) => {
          job.progress.currentChapter = chapter
          job.streamText = ''
          job.retryWait = { chapter, attempt, maxAttempts, waitMs, retryAt: Date.now() + waitMs }
          this.checkpoint(job)
        }
      )
      job.progress = progress
      if (controller.signal.aborted && progress.status !== 'completed') {
        job.progress.status = 'paused'
        job.progress.pauseReason = progress.pauseReason || '任务已暂停，可以继续未完成章节'
        delete job.progress.error
      }
      this.cleanProgress(job)
      const pending = job.progress.pendingPostProcessChapter
      for (const summary of job.summaries) {
        summary.checks = summary.chapter === pending ? 'pending' : 'completed'
      }
    } catch (error) {
      // 回调/适配器异常仍核对磁盘，避免下一次生成覆盖已经落盘的正文。
      try {
        await this.recoverInterrupted(job)
      } catch {
        // 暂时无法读取正文时保留最后一个可信检查点，不改成已完成。
        if (job.progress.completed.includes(job.progress.currentChapter)) {
          job.progress.pendingPostProcessChapter = job.progress.currentChapter
        }
      }
      job.progress.status = controller.signal.aborted ? 'paused' : 'failed'
      const message = publicMessage(error)
      if (controller.signal.aborted) job.progress.pauseReason = '任务已暂停，可以继续未完成章节'
      else job.progress.error = message
    } finally {
      job.running = false
      job.stopping = false
      job.streamText = ''
      delete job.stage
      delete job.retryWait
      await this.save(job)
    }
  }

  private async load(projectId: string): Promise<MobileBatchJob | null> {
    if (this.jobs.has(projectId)) return this.jobs.get(projectId) ?? null
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(this.file(projectId), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.jobs.set(projectId, null)
        return null
      }
      throw new MobileBatchError(500, '批量任务记录暂时无法读取，请检查电脑端存储')
    }
    const parsed = savedJobSchema.safeParse(raw)
    if (!parsed.success || parsed.data.job.projectId !== projectId || !validProgress(parsed.data.job.progress)) {
      throw new MobileBatchError(409, '批量任务记录已损坏，请在电脑端检查任务存储')
    }
    const job = parsed.data.job
    if (job.running || job.stopping || ['pending', 'generating', 'flow'].includes(job.progress.status)) {
      await this.recoverInterrupted(job)
      job.running = false
      job.stopping = false
      job.streamText = ''
      delete job.stage
      delete job.retryWait
      job.progress.status = 'paused'
      job.progress.pauseReason = job.progress.pendingPostProcessChapter
        ? `电脑服务已重新启动，第 ${job.progress.currentChapter} 章正文已保存，继续时先补跑检查`
        : `电脑服务已重新启动，可以从第 ${job.progress.currentChapter} 章继续`
      delete job.progress.error
      await this.save(job)
    }
    this.jobs.set(projectId, job)
    return job
  }

  private async recoverInterrupted(job: MobileBatchJob): Promise<void> {
    const chapter = job.progress.currentChapter
    const saved = await this.chapters.getChapter(job.projectId, chapter)
    if (saved.content.trim()) {
      if (!job.progress.completed.includes(chapter)) job.progress.completed.push(chapter)
      job.progress.completed.sort((a, b) => a - b)
      job.progress.pendingPostProcessChapter = chapter
    } else {
      job.progress.completed = job.progress.completed.filter((completed) => completed !== chapter)
      delete job.progress.pendingPostProcessChapter
    }
    job.progress.current = job.progress.completed.length
  }

  private async requireJob(projectId: string, jobId: string): Promise<MobileBatchJob> {
    const job = await this.load(projectId)
    if (!job || !jobId || job.id !== jobId) throw new MobileBatchError(409, '任务已更新，请刷新后再操作')
    return job
  }

  private async projectDir(projectId: string): Promise<string> {
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 255) {
      throw new MobileBatchError(400, '作品编号无效')
    }
    try {
      return await this.projects.resolveDir(projectId)
    } catch {
      throw new MobileBatchError(404, '作品不存在或暂时无法读取')
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MobileBatchError(409, '手机服务正在停止，请稍后再试')
  }

  private lock(projectId: string): () => void {
    try {
      return acquireBatchProject(projectId)
    } catch {
      throw new MobileBatchError(409, '该作品已有电脑端或手机端批量任务，请等待当前任务结束')
    }
  }

  private cleanProgress(job: MobileBatchJob): void {
    if (job.progress.error) job.progress.error = publicMessage(new Error(job.progress.error))
    if (job.progress.pauseReason) job.progress.pauseReason = publicMessage(new Error(job.progress.pauseReason))
  }

  private checkpoint(job: MobileBatchJob): void {
    void this.save(job).catch((error: unknown) => console.error('[mobile-batch] checkpoint failed:', error))
  }

  private save(job: MobileBatchJob): Promise<void> {
    job.updatedAt = Date.now()
    const snapshot = clone(job)
    const previous = this.saveTails.get(job.projectId) ?? Promise.resolve()
    const promise = previous.catch(() => {}).then(() => writeJsonAtomic(this.file(job.projectId), { version: 1, job: snapshot }))
    this.saveTails.set(job.projectId, promise)
    return promise
  }

  private file(projectId: string): string {
    const name = createHash('sha256').update(projectId).digest('hex')
    return join(this.storageDir, `${name}.json`)
  }

  private command<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(projectId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => {}, () => {})
    this.commandTails.set(projectId, tail)
    void tail.finally(() => {
      if (this.commandTails.get(projectId) === tail) this.commandTails.delete(projectId)
    })
    return result
  }
}

function resumeChapter(progress: BatchProgress): number {
  return progress.pendingPostProcessChapter ?? (
    progress.completed.includes(progress.currentChapter) ? progress.currentChapter + 1 : progress.currentChapter
  )
}

function validProgress(progress: BatchProgress): boolean {
  return getBatchRangeError(progress.fromChapter, progress.toChapter) === null &&
    getBatchRangeError(progress.currentChapter, progress.toChapter, progress) === null &&
    progress.currentChapter >= progress.fromChapter &&
    progress.current === new Set(progress.completed).size &&
    progress.completed.length === progress.current
}

function clone<T>(value: T): T {
  return value === null ? value : structuredClone(value)
}

function publicMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s。；，）)]+/g, '[电脑端恢复文件]')
    .slice(0, 1_500)
}

function summarize(chapter: number, result: ChapterFlowResult, deslopFallback: string): MobileBatchSummary {
  const memoryErrors = result.memoryApply?.errors ?? []
  const applied = result.memoryApply?.applied
  const memoryCount = applied ? Object.values(applied).reduce((sum, count) => sum + count, 0) : 0
  const memory = !result.memoryApply ? '记忆同步未返回结果'
    : result.memory.parseError || memoryErrors.length || result.memoryApply?.reviewRequired?.length || result.memoryApply?.superseded
      ? '记忆同步待完成'
      : `记忆已同步${memoryCount ? ` ${memoryCount} 项` : ''}`
  const pending = result.outlineDiff.hasOutline === false || result.outlineDiff.checked === false ||
    result.selfCheck === null || result.selfCheck?.items.some((item) => item.repairKind === 'execution_error' || item.id === 'self_check_error') ||
    memory === '记忆同步待完成' || Boolean(result.settingsApply?.errors.length) ||
    result.deepReview?.some((item) => item.ruleId?.startsWith('review_incomplete:'))
  return {
    chapter, wordCount: countWords(result.content), saved: true,
    checks: pending ? 'pending' : 'completed',
    deslop: result.autoDeslop?.message ? publicMessage(new Error(result.autoDeslop.message)).slice(0, 300) : deslopFallback,
    memory
  }
}
