import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChapterDetectionRepository } from '../src/main/data/chapter-detection-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { currentChapterDetection } from '../src/shared/chapter-detection'
import { contentRevision } from '../src/main/data/chapter-revision'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import type { ChapterDetectionRecord, DetectionResultInput } from '../src/shared/chapter-detection'

const TEXT = '“等等。”她抬手拦住他，“已付八百，余款两百。”\n\n她翻到昨天的收条。日期没错，钱是交给了谁？'
const completed = (record: ChapterDetectionRecord, ai = 0): DetectionResultInput => ({
  status: 'completed', ai, suspected: 0, human: 100 - ai, detectedAt: record.createdAt,
  evidence: '人工抄录报告，截图路径：本地归档/第四章.png。'
})

describe('逐章检测快照与版本绑定', () => {
  let dir: string
  let repo: ChapterDetectionRepository
  let prose: ProseRepo
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-detection-'))
    repo = new ChapterDetectionRepository(dir)
    prose = new ProseRepo(dir)
    await prose.write(4, TEXT, '收条')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('逐字保存完整正文，格式化不改合法段落，持久化后仍能核验', async () => {
    expect(formatChapterProse(TEXT)).toBe(TEXT)
    const record = await repo.capture(4, TEXT)
    expect(record.content).toBe(TEXT)
    expect(record.revision).toBe(contentRevision(TEXT))
    expect(record.scope).toBe('full_chapter')
    expect(currentChapterDetection(await repo.list(4), TEXT)).toBe('待送检')
    await repo.recordResult(4, record.id, completed(record))
    const reopened = new ChapterDetectionRepository(dir)
    expect(currentChapterDetection(await reopened.list(4), TEXT)).toBe('本版双零（人工登记）')
    expect(await prose.read(4)).toBe(TEXT)
  })

  it.each(['。', '\n', ' ', '！'])('任何保存变动都使旧结果失效：%j', async change => {
    const record = await repo.capture(4, TEXT)
    await repo.recordResult(4, record.id, completed(record))
    const modified = TEXT + change
    await prose.write(4, modified, '收条')
    const history = await repo.list(4)
    expect(currentChapterDetection(history, modified)).toBe('正文已变化，需复测')
    expect(history.records[0].content).toBe(TEXT)
    await prose.write(4, TEXT, '收条')
    expect(currentChapterDetection(await repo.list(4), TEXT)).toBe('本版双零（人工登记）')
  })

  it('未保存草稿不能沿用绿标，保存冲突和空正文不能建快照', async () => {
    const record = await repo.capture(4, TEXT)
    await repo.recordResult(4, record.id, completed(record))
    expect(currentChapterDetection(await repo.list(4), TEXT + '改')).toBe('正文已变化，需复测')
    await expect(repo.capture(4, TEXT + '改')).rejects.toThrow('CHAPTER_REVISION_CONFLICT')
    await expect(repo.capture(5, '')).rejects.toThrow('非空')
  })

  it.each(['waiting_verification', 'quota_exhausted', 'failed'] as const)('异常状态没有分数，允许稍后完成：%s', async status => {
    const record = await repo.capture(4, TEXT)
    const waiting = await repo.recordResult(4, record.id, { status, note: '等待处理。' })
    expect(waiting.events.at(-1)).not.toHaveProperty('ai')
    expect(currentChapterDetection(await repo.list(4), TEXT)).not.toContain('双零')
    await repo.recordResult(4, record.id, completed(record))
    expect((await repo.list(4)).records[0].events).toHaveLength(3)
  })

  it('后来非零或待检结果不会被较早的绿标覆盖，章节互不串用', async () => {
    const a = await repo.capture(4, TEXT)
    await repo.recordResult(4, a.id, completed(a))
    const b = await repo.capture(4, TEXT)
    expect(currentChapterDetection(await repo.list(4), TEXT)).toBe('待送检')
    await repo.recordResult(4, b.id, completed(b, 12.5))
    expect(currentChapterDetection(await repo.list(4), TEXT)).toContain('AI 12.5%')
    expect(currentChapterDetection(await repo.list(5), TEXT)).toBe('未检测')
    await expect(repo.recordResult(5, a.id, completed(a))).rejects.toThrow()
  })

  it('并发创建和登记不丢记录，已完成结果不能覆盖', async () => {
    const records = await Promise.all([repo.capture(4, TEXT), repo.capture(4, TEXT)])
    expect(records.map(record => record.attempt)).toEqual([1, 2])
    const record = records[1]
    const outcomes = await Promise.allSettled([
      repo.recordResult(4, record.id, completed(record)), repo.recordResult(4, record.id, completed(record, 20))
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect((await repo.list(4)).records).toHaveLength(2)
  })

  it('拒绝空分数、越界、错误合计、无证据、伪造范围和时间', async () => {
    const record = await repo.capture(4, TEXT)
    const valid = completed(record)
    for (const patch of [
      { ai: undefined }, { ai: NaN }, { ai: -1 }, { ai: 101 }, { human: 90 }, { evidence: ' ' },
      { scope: 'paragraph' }, { detectedAt: '2000-01-01T00:00:00.000Z' },
      { detectedAt: '2099-01-01T00:00:00.000Z' }
    ]) await expect(repo.recordResult(4, record.id, { ...valid, ...patch } as DetectionResultInput)).rejects.toThrow()
    await expect(repo.recordResult(4, record.id, { status: 'failed', note: '', ai: 0 } as unknown as DetectionResultInput)).rejects.toThrow()
    expect((await repo.list(4)).records[0].events).toHaveLength(1)
  })

  it('拒绝路径遍历及损坏的快照，不把错误当作未检测或零分', async () => {
    await expect(repo.capture(-1, TEXT)).rejects.toThrow()
    await expect(repo.recordResult(4, '../other', { status: 'failed', note: '' })).rejects.toThrow()
    const record = await repo.capture(4, TEXT)
    const file = join(dir, '正文', '.detections', '004', record.id + '.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.content += '偷偷改动。'
    await writeFile(file, JSON.stringify(stored), 'utf8')
    await expect(repo.list(4)).rejects.toThrow('校验失败')
  })
})
