import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChartService } from '../src/main/data/fanqie-chart/service'
import { GOLDEN_THREE_STAGES } from '../src/main/data/fanqie-chart/analysis'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'
import type { FanqieChartAnalysis, FanqieChartBook, FanqieChartRecord, FanqieChapterContent } from '../src/shared/fanqie-chart'
import type { LlmService } from '../src/main/data/llm-service'
import { qualityIdea, relationshipIdea, passingReviews, passingFusionReview } from './helpers/fanqie-idea'

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
  it.each(['invalid', 'cancelled', 'rejected'] as const)('融梗复核 %s 时不覆盖已有结果', async mode => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        if (prompt.includes('你是严格的网文选题终审编辑')) return passingReviews(1)
        return JSON.stringify({ ideas: [qualityIdea()] })
      })
      const previous = await service.generateIdeas(chartType, 1, [])
      expect(previous.ideas?.promptVersion).toBe('chart-ideas-v16-action-and-demand')
      expect(previous.ideas?.ideas[0].pacingPlan).toBe(qualityIdea().pacingPlan)
      const controller = new AbortController()
      let fusionCalls = 0
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) {
          fusionCalls++
          expect(prompt).toContain(books[0].intro)
          if (mode === 'invalid') return '{"reviews":[]}'
          if (mode === 'cancelled') controller.abort()
          const review = JSON.parse(passingFusionReview(prompt))
          if (mode === 'rejected') {
            review.reviews[0].passed = false
            review.reviews[0].issues = [{ kind: 'weak_source_dependency', field: 'power_system',
              quote: qualityIdea().powerSystem, reason: '正常交流就能取得同一信息，指定渠道并非不可替代。' }]
          }
          return JSON.stringify(review)
        }
        if (prompt.includes('你是严格的网文选题终审编辑')) return passingReviews(1)
        return JSON.stringify({ ideas: [qualityIdea('待核查方案', 1)] })
      })
      await expect(service.generateIdeas(chartType, 1, [], undefined, controller.signal)).rejects.toThrow(mode === 'cancelled' ? '已取消' : '旧结果已保留')
      expect(fusionCalls).toBe(mode === 'rejected' ? 3 : 1)
      expect((await service.list())[0].ideas).toEqual(previous.ideas)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('关系换皮或推进过快须补生成，跨轮比较保留方案的实际关系事件', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      const first = relationshipIdea('第一案', 0)
      const rejected = relationshipIdea('失速方案', 1)
      const repaired = relationshipIdea('第三案', 2)
      rejected.trendBasis = rejected.trendBasis.map((ref, i) => ({ ...ref, bookId: ['c', 'd'][i] }))
      repaired.trendBasis = structuredClone(rejected.trendBasis)
      let generations = 0, audits = 0
      fixture.generateStream.mockClear()
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        if (prompt.includes('你是严格的网文选题终审编辑')) {
          audits++
          if (audits === 1) {
            const result = JSON.parse(passingReviews(2, [first, rejected]))
            result.reviews[1].romancePacing = false
            result.reviews[1].relationshipOriginality = false
            result.reviews[1].reasons = [{ item: 'romancePacing', reason: '与第一案相同：首章修复旧情、次章邀约、第三章表白接受多线关系，变化缺乏积累', requiredModification: '改变关系起点和阶段终点' }]
            return JSON.stringify(result)
          }
          expect(prompt).toContain(first.openingChapters![1].payoff)
          return passingReviews(1, [repaired])
        }
        generations++
        if (generations === 2) {
          expect(prompt).toContain('变化缺乏积累')
          expect(prompt).toContain('改变关系起点和阶段终点')
          expect(prompt).toContain(first.openingChapters![0].payoff)
        }
        return JSON.stringify({ ideas: generations === 1 ? [first, rejected] : [repaired] })
      })
      const result = await service.generateIdeas(chartType, 2, ['多女主'])
      expect(result.ideas?.ideas.map(idea => idea.title)).toEqual(['第一案', '第三案'])
      expect(generations).toBe(2)
      expect(audits).toBe(2)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('标签和机制终审拒收后把具体原因带入重试，只保存修正后的方案', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      fixture.generateStream.mockClear()
      let generations = 0, reviews = 0
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        if (prompt.includes('你是严格的网文选题终审编辑')) {
          reviews++
          expect(prompt).toContain('多女主')
          if (reviews === 1) return JSON.stringify({ reviews: [{ index: 0, content: true, originality: false, tags: false, diversity: true,
            reasons: ['折叠道路与历史开门机制重复；多女主仅列职业分工，缺少关系推进事件'] }] })
          return passingReviews(1, [relationshipIdea('修正方案', 1)])
        }
        generations++
        if (generations === 2) expect(prompt).toContain('多女主仅列职业分工，缺少关系推进事件')
        return JSON.stringify({ ideas: [relationshipIdea(generations === 1 ? '待修方案' : '修正方案', generations - 1)] })
      })
      const result = await service.generateIdeas(chartType, 1, ['多女主'])
      expect(result.ideas?.ideas.map(idea => idea.title)).toEqual(['修正方案'])
      expect(generations).toBe(2)
      expect(reviews).toBe(2)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('伪造引用、缺少金手指不能进入终审，失败保留旧结果', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      fixture.generateStream.mockImplementation(async prompt => prompt.startsWith('你是独立的融梗审稿人') ? passingFusionReview(prompt) : prompt.includes('你是严格的网文选题终审编辑')
        ? passingReviews(1) : JSON.stringify({ ideas: [qualityIdea()] }))
      const previous = await service.generateIdeas(chartType, 1, [])
      fixture.generateStream.mockClear()
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        expect(prompt).not.toContain('你是严格的网文选题终审编辑')
        return JSON.stringify({ ideas: [{ ...qualityIdea('坏方案', 1), goldenFinger: '', trendBasis: qualityIdea().trendBasis.map(ref => ({ ...ref, quote: '不存在的原文' })) }] })
      })
      await expect(service.generateIdeas(chartType, 1, [])).rejects.toThrow('goldenFinger')
      expect(fixture.generateStream).toHaveBeenCalledTimes(3)
      expect((await service.list())[0].ideas).toEqual(previous.ideas)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('重启后仍检查历史机制，改名不能重复生成', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      fixture.generateStream.mockImplementation(async prompt => prompt.startsWith('你是独立的融梗审稿人') ? passingFusionReview(prompt) : prompt.includes('你是严格的网文选题终审编辑')
        ? passingReviews(1) : JSON.stringify({ ideas: [qualityIdea()] }))
      await service.generateIdeas(chartType, 1, [])
      const reopened = fixture.create()
      await reopened.analyze(chartType, false)
      fixture.generateStream.mockClear()
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        expect(prompt).toContain('历史方案的机制')
        expect(prompt).toContain(qualityIdea().goldenFinger)
        return JSON.stringify({ ideas: [{ ...qualityIdea('只换书名'), coreConcept: '新背景与新人物' }] })
      })
      await expect(reopened.generateIdeas(chartType, 1, [])).rejects.toThrow('高度相似')
      expect(fixture.generateStream).toHaveBeenCalledTimes(3)
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('终审返回无效JSON时不保存；终审期间取消也不保存', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      const controller = new AbortController()
      let cancel = false
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
        if (!prompt.includes('你是严格的网文选题终审编辑')) return JSON.stringify({ ideas: [qualityIdea()] })
        if (cancel) controller.abort()
        return cancel ? passingReviews(1) : '无法审核'
      })
      await expect(service.generateIdeas(chartType, 1, [])).rejects.toThrow('终审未返回有效')
      expect((await service.list())[0].ideas).toBeNull()
      cancel = true
      await expect(service.generateIdeas(chartType, 1, [], undefined, controller.signal)).rejects.toThrow('已取消')
      expect((await service.list())[0].ideas).toBeNull()
    } finally { await rm(fixture.dir, { recursive: true, force: true }) }
  })

  it('returns an unchanged analysis after metadata checks without rereading opening JSON or calling models', async () => {
    const fixture = await setup()
    try {
      for (const book of books) {
        await writeJsonAtomic(path.join(fixture.dir, 'fanqie-books', book.bookId, 'detail.json'), { chapters: [{ id: '1' }] })
        await writeJsonAtomic(path.join(fixture.dir, 'fanqie-books', book.bookId, 'chapters', '1.json'), fixture.chapters.get(book.bookId))
      }
      const service = new FanqieChartService(fixture.dir, { generateStream: fixture.generateStream } as unknown as LlmService)
      const original = await service.analyze(chartType, false)
      fixture.generateStream.mockClear()
      const reads = vi.spyOn(fs, 'readFile')
      try {
        expect(await service.analyze(chartType, false)).toEqual(original)
        expect(fixture.generateStream).not.toHaveBeenCalled()
        expect(reads.mock.calls.map(([file]) => String(file))).toEqual([path.join(fixture.dir, 'fanqie-charts', 'new_book_male__261.json')])
      } finally {
        reads.mockRestore()
      }
      await writeJsonAtomic(path.join(fixture.dir, 'fanqie-books', 'a', 'chapters', '1.json'), {
        ...fixture.chapters.get('a'), content: fixture.chapters.get('a')!.content + '新的冲突。'
      })
      expect((await service.analyze(chartType, false)).analysis?.sourceHash).not.toBe(original.analysis?.sourceHash)
      expect(fixture.generateStream.mock.calls).toHaveLength(2)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  it('starts opening analysis before the blocked market model finishes', async () => {
    const fixture = await setup()
    let release!: (text: string) => void
    let marketPrompt = ''
    let openingStarted = false
    fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
      if (prompt.includes('书籍ID：')) openingStarted = true
      if (!prompt.includes('书籍ID：') && !prompt.includes('任务：分类黄金三章汇总')) {
        marketPrompt = prompt
        return new Promise<string>(resolve => { release = resolve })
      }
      return reply(prompt)
    })
    const run = fixture.create().analyze(chartType, false)
    try {
      await vi.waitFor(() => expect(openingStarted).toBe(true))
    } finally {
      release(reply(marketPrompt))
      await run
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  it('does not block list reads or a different chart behind a running analysis', async () => {
    const fixture = await setup()
    const controller = new AbortController()
    fixture.generateStream.mockImplementation(async (_prompt, options) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
    }))
    const service = fixture.create()
    const otherChart = 'new_book_male:262'
    const record = await readJson<FanqieChartRecord | null>(path.join(fixture.dir, 'fanqie-charts', 'new_book_male__261.json'), null)
    await writeJsonAtomic(path.join(fixture.dir, 'fanqie-charts', 'new_book_male__262.json'), { ...record, chartType: otherChart })
    const run = service.analyze(chartType, false, undefined, controller.signal)
    const stopped = expect(run).rejects.toThrow('分析已取消')
    let listed = false
    let deleted = false
    let listing: Promise<unknown> | undefined
    let deletion: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(fixture.generateStream.mock.calls.length).toBe(2))
      listing = service.list().then(records => { expect(records.some(record => record.chartType === chartType)).toBe(true); listed = true })
      deletion = service.delete(otherChart).then(() => { deleted = true })
      await vi.waitFor(() => { expect(listed).toBe(true); expect(deleted).toBe(true) })
    } finally {
      controller.abort()
      await stopped
      await Promise.all([listing, deletion])
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  it('limits model calls across simultaneous charts to two', async () => {
    const fixture = await setup()
    const record = await readJson<FanqieChartRecord | null>(path.join(fixture.dir, 'fanqie-charts', 'new_book_male__261.json'), null)
    await writeJsonAtomic(path.join(fixture.dir, 'fanqie-charts', 'new_book_male__262.json'), { ...record, chartType: 'new_book_male:262' })
    let active = 0
    let peak = 0
    fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return reply(prompt)
    })
    try {
      const service = fixture.create()
      await Promise.all([service.analyze(chartType, false), service.analyze('new_book_male:262', false)])
      expect(peak).toBe(2)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  it('keeps valid ideas and asks the retry only for missing nonduplicate ideas', async () => {
    const fixture = await setup()
    try {
      const service = fixture.create()
      await service.analyze(chartType, false)
      fixture.generateStream.mockClear()
      const idea = (title: string) => {
        const variant = ['第一案', '第二案', '第三案'].indexOf(title)
        const result = qualityIdea(title, variant)
        result.trendBasis = result.trendBasis.map((ref, i) => ({ ...ref, bookId: [['a', 'b'], ['c', 'd'], ['a', 'c']][variant][i] }))
        return result
      }
      fixture.generateStream.mockImplementationOnce(async () => JSON.stringify({ ideas: [idea('第一案'), { title: '不完整' }] }))
        .mockImplementationOnce(async () => passingReviews(1))
        .mockImplementationOnce(async prompt => passingFusionReview(prompt))
        .mockImplementationOnce(async prompt => {
          expect(prompt).toContain('写 2 个')
          expect(prompt).toContain('已经保留')
          expect(prompt).toContain('第一案')
          return JSON.stringify({ ideas: [idea('第一案'), idea('第二案'), idea('第三案')] })
        })
        .mockImplementationOnce(async () => passingReviews(2))
        .mockImplementationOnce(async prompt => passingFusionReview(prompt))
      const record = await service.generateIdeas(chartType, 3, [])
      expect(fixture.generateStream).toHaveBeenCalledTimes(6)
      expect(record.ideas?.ideas.map(candidate => candidate.title)).toEqual(['第一案', '第二案', '第三案'])
      expect(record.ideas?.ideas[0].coreConcept).toBe(idea('第一案').coreConcept)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  it('限制两本并发，完成一本立即发布，全部完成才汇总', async () => {
    const fixture = await setup()
    try {
      const pending = new Map<string, () => void>()
      let active = 0
      let peak = 0
      let summaryStarted = false
      fixture.generateStream.mockImplementation(async prompt => {
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
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
        if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
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
