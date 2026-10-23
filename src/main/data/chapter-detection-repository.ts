import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from './atomic'
import { contentRevision, ChapterRevisionConflictError } from './chapter-revision'
import { ProseRepo } from './skill-format/prose-repo'
import { PROSE_POLICY_VERSION } from '../../shared/prose-policy'
import type { ChapterDetectionHistory, ChapterDetectionRecord, DetectionResultInput } from '../../shared/chapter-detection'

const percentage = z.number().finite().min(0).max(100)
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), ai: percentage, suspected: percentage, human: percentage,
    detectedAt: z.string().datetime(), evidence: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ status: z.enum(['pending', 'waiting_verification', 'quota_exhausted', 'failed']),
    note: z.string().max(2000) }).strict()
]).superRefine((result, ctx) => {
  if (result.status !== 'completed') return
  if (Math.abs(result.ai + result.suspected + result.human - 100) > 0.11) {
    ctx.addIssue({ code: 'custom', message: '三项百分比合计应为 100%（允许显示舍入误差）。' })
  }
  if (Date.parse(result.detectedAt) > Date.now() + 300_000) {
    ctx.addIssue({ code: 'custom', message: '检测时间不能晚于当前时间。' })
  }
})

const recordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), chapterNumber: z.number().int().positive(),
  attempt: z.number().int().positive(), provider: z.literal('朱雀'), source: z.literal('manual'), scope: z.literal('full_chapter'),
  content: z.string().min(1).max(500_000), revision: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.string().min(1), createdAt: z.string().datetime(),
  events: z.array(z.record(z.string(), z.unknown())).min(1)
})

// Serialize updates to the same record across IPC calls, without serializing unrelated chapters.
const queues = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(action)
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}

/** 检测记录是项目证据，不放入可清理缓存，也不受“只留五版”的滚动上限影响。 */
export class ChapterDetectionRepository {
  constructor(private readonly projectDir: string) {}

  private folder(n: number): string {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('无效章节号。')
    return join(this.projectDir, '正文', '.detections', String(n).padStart(3, '0'))
  }

  private file(n: number, id: string): string {
    return join(this.folder(n), `${z.string().uuid().parse(id)}.json`)
  }

  private async read(n: number, id: string): Promise<ChapterDetectionRecord> {
    const parsed = recordSchema.parse(JSON.parse(await fs.readFile(this.file(n, id), 'utf8')))
    if (parsed.id !== id || parsed.chapterNumber !== n || contentRevision(parsed.content) !== parsed.revision) {
      throw new Error('检测快照校验失败，不能使用这份结果。')
    }
    const events = parsed.events.map(event => {
      const { recordedAt, ...input } = event
      return { ...resultSchema.parse(input), recordedAt: z.string().datetime().parse(recordedAt) }
    })
    return { ...parsed, events }
  }

  async list(n: number): Promise<ChapterDetectionHistory> {
    let names: string[]
    try { names = await fs.readdir(this.folder(n)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      names = []
    }
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.read(n, name.slice(0, -5))))
    records.sort((a, b) => b.attempt - a.attempt)
    return { currentRevision: contentRevision(await new ProseRepo(this.projectDir).read(n)), records }
  }

  async capture(n: number, expectedContent: string): Promise<ChapterDetectionRecord> {
    return serialized(this.folder(n) + ':capture', async () => {
      const history = await this.list(n)
      const content = await new ProseRepo(this.projectDir).read(n)
      if (content !== expectedContent) throw new ChapterRevisionConflictError()
      if (!content.trim() || content.length > 500_000) throw new Error('请先保存非空的完整章节正文。')
      const createdAt = new Date().toISOString()
      const record: ChapterDetectionRecord = {
        schemaVersion: 1, id: randomUUID(), chapterNumber: n, attempt: (history.records[0]?.attempt ?? 0) + 1,
        provider: '朱雀', source: 'manual', scope: 'full_chapter', content,
        revision: contentRevision(content), policyVersion: PROSE_POLICY_VERSION,
        createdAt, events: [{ status: 'pending', note: '', recordedAt: createdAt }]
      }
      await writeJsonAtomic(this.file(n, record.id), record)
      return record
    })
  }

  async recordResult(n: number, id: string, input: DetectionResultInput): Promise<ChapterDetectionRecord> {
    const result = resultSchema.parse(input)
    return serialized(this.file(n, id), async () => {
      const record = await this.read(n, id)
      if (record.events.at(-1)?.status === 'completed') throw new Error('已完成的检测结果不可覆盖；复测请新建快照。')
      if (result.status === 'completed' && Date.parse(result.detectedAt) < Date.parse(record.createdAt)) {
        throw new Error('检测时间不能早于这次快照的创建时间。')
      }
      record.events.push({ ...result, recordedAt: new Date().toISOString() })
      await writeJsonAtomic(this.file(n, id), record)
      return record
    })
  }
}
