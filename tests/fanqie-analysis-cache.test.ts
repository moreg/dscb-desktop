import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChartService } from '../src/main/data/fanqie-chart/service'
import { GOLDEN_THREE_STAGES } from '../src/main/data/fanqie-chart/analysis'
import { writeJsonAtomic } from '../src/main/data/atomic'
import type { FanqieChartAnalysis, FanqieChartBook, FanqieChartRecord, FanqieChapterContent } from '../src/shared/fanqie-chart'
import type { LlmService } from '../src/main/data/llm-service'

const chartType = 'new_book_male:261'
const books: FanqieChartBook[] = ['a', 'b', 'c', 'd'].map((bookId, i) => ({ bookId, rank: i + 1,
  title: `测试书${bookId}`, author: '', cover: '', genre: '都市', wordCount: '', readCount: '',
  intro: '主角撕毁契约', tags: [], url: '', status: '', garbled: false }))
function opening(id: string) {
  return JSON.stringify({ insights: ['opening_patterns', ...Array(3).fill('golden_three_directions')].map((dimension, i) => ({
    dimension, claim: `主角以行动兑现回报${String.fromCharCode(65 + i)}`, confidence: 'sample_supported',
    evidence: [{ bookId: id, field: 'chapter', chapterId: '1', quote: '当场撕毁契约' }]
  })) })
}
function reply(prompt: string) {
  if (prompt.includes('书籍ID：')) return opening(prompt.match(/书籍ID：(\w+)/)![1])
  if (prompt.includes('任务：分类黄金三章汇总')) return JSON.stringify({ directions: GOLDEN_THREE_STAGES.map(stage => ({
    stage, claim: '主角主动推进冲突，并兑现开篇承诺', evidence: ['a', 'b'].map(bookId => ({ bookId, field: 'chapter', chapterId: '1', quote: '当场撕毁契约' }))
  })) })
  return JSON.stringify({ insights: Array.from({ length: 4 }, (_, i) => ({ dimension: 'genre_characteristics',
    claim: `契约让人物面对困境${String.fromCharCode(65 + i)}`, confidence: 'sample_supported',
    evidence: [{ bookId: 'a', field: 'intro', quote: '撕毁契约' }] })) })
}
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-cache-'))
  const record: FanqieChartRecord = { id: chartType, chartType, chartDate: '2026-10-11', books,
    analysis: null, ideas: null, status: 'fetched', targetCount: 30, actualCount: 4, isPartial: true,
    partialReason: '', sourceHash: '', fetchedAt: '', updatedAt: '' }
  await writeJsonAtomic(path.join(dir, 'fanqie-charts', 'new_book_male__261.json'), record)
  const chapters = new Map<string, FanqieChapterContent>(books.map(book => [book.bookId, {
    id: '1', bookId: book.bookId, title: '第一章', bookTitle: book.title, content: '主角当场撕毁契约。'.repeat(10),
    url: '', hasGarbled: false, wordCount: 100, fetchedAt: '' }]))
  const generateStream = vi.fn(async (prompt: string, _options?: { signal?: AbortSignal }) => reply(prompt))
  const create = () => {
    const service = new FanqieChartService(dir, { generateStream } as unknown as LlmService)
    vi.spyOn(service.chapterScraper, 'readCachedOpening').mockImplementation(async id => [chapters.get(id)!])
    return service
  }
  return { dir, chapters, generateStream, create }
}

describe('逐本分析缓存与并发', () => {
  it('限制两本并发，完成一本立即发布，全部完成才汇总', async () => {
    const fixture = await setup()
    try {
      const pending = new Map<string, () => void>()
      let active = 0
      let peak = 0
      let summaryStarted = false
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.includes('书籍ID：')) {
          const id = prompt.match(/书籍ID：(\w+)/)![1]
          active += 1; peak = Math.max(peak, active)
          await new Promise<void>(resolve => pending.set(id, resolve))
          active -= 1
        }
        if (prompt.includes('任务：分类黄金三章汇总')) summaryStarted = true
        return reply(prompt)
      })
      const snapshots: FanqieChartAnalysis[] = []
      const run = fixture.create().analyze(chartType, false, (_message, analysis) => { if (analysis) snapshots.push(analysis) })
      await vi.waitFor(() => expect(pending.size).toBe(2))
      expect(peak).toBe(2)
      pending.get('b')!()
      await vi.waitFor(() => expect(pending.has('c')).toBe(true))
      expect(summaryStarted).toBe(false)
      const partial = snapshots.find(a => a.insights.some(i => i.evidence.some(e => e.bookId === 'b' && e.field === 'chapter')))
      expect(partial?.inProgress).toBe(true)
      expect(partial?.insights.some(i => i.evidence.some(e => e.bookId === 'a' && e.field === 'chapter'))).toBe(false)
      pending.get('a')!()
      await vi.waitFor(() => expect(pending.has('d')).toBe(true))
      pending.get('c')!(); pending.get('d')!()
      const final = await run
      expect(peak).toBe(2)
      expect(summaryStarted).toBe(true)
      expect(final.analysis?.inProgress).toBe(false)
      expect(final.analysis?.goldenThreeSummary?.bookCount).toBe(4)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('重启后只分析正文变化的书，刷新不重算未变化的书', async () => {
    const fixture = await setup()
    try {
      await fixture.create().analyze(chartType, false)
      fixture.generateStream.mockClear()
      fixture.chapters.get('a')!.content += '新的冲突发生了。'
      await fixture.create().analyze(chartType, false)
      expect(fixture.generateStream.mock.calls).toHaveLength(2)
      expect(fixture.generateStream.mock.calls[0][0]).toContain('书籍ID：a')
      expect(fixture.generateStream.mock.calls[1][0]).toContain('分类黄金三章汇总')
      fixture.generateStream.mockClear()
      await fixture.create().analyze(chartType, true)
      expect(fixture.generateStream).not.toHaveBeenCalled()
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('单本失败可重试，已成功的其他书复用缓存', async () => {
    const fixture = await setup()
    try {
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.includes('书籍ID：d')) throw new Error('临时模型故障')
        return reply(prompt)
      })
      const first = await fixture.create().analyze(chartType, false)
      expect(first.analysis?.retryRequired).toBe(true)
      fixture.generateStream.mockClear().mockImplementation(async prompt => reply(prompt))
      const next = await fixture.create().analyze(chartType, false)
      const openingCalls = fixture.generateStream.mock.calls.filter(([prompt]) => prompt.includes('书籍ID：'))
      expect(openingCalls).toHaveLength(1)
      expect(openingCalls[0][0]).toContain('书籍ID：d')
      expect(next.analysis?.retryRequired).toBe(false)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('取消保留已完成单本缓存，继续时不重算它', async () => {
    const fixture = await setup()
    try {
      const controller = new AbortController()
      fixture.generateStream.mockImplementation(async (prompt, options) => {
        if (prompt.includes('书籍ID：') && !prompt.includes('书籍ID：a')) {
          await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('已取消')), { once: true }))
        }
        return reply(prompt)
      })
      const run = fixture.create().analyze(chartType, false, (_message, analysis) => {
        if (analysis?.insights.some(i => i.evidence.some(ref => ref.field === 'chapter' && ref.bookId === 'a'))) controller.abort()
      }, controller.signal)
      await expect(run).rejects.toThrow('分析已取消')
      fixture.generateStream.mockClear().mockImplementation(async prompt => reply(prompt))
      await fixture.create().analyze(chartType, false)
      const calls = fixture.generateStream.mock.calls.filter(([prompt]) => prompt.includes('书籍ID：'))
      expect(calls).toHaveLength(3)
      expect(calls.some(([prompt]) => prompt.includes('书籍ID：a'))).toBe(false)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })
})
