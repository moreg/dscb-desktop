import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChartService } from '../src/main/data/fanqie-chart/service'
import { validateInsights, validateGoldenThreeSummary, GOLDEN_THREE_STAGES } from '../src/main/data/fanqie-chart/analysis'
import { writeJsonAtomic } from '../src/main/data/atomic'
import type { LlmService } from '../src/main/data/llm-service'
import type { FanqieChapterContent, FanqieChartBook, FanqieChartRecord } from '../src/shared/fanqie-chart'
import { qualityIdea, passingReviews, passingFusionReview } from './helpers/fanqie-idea'

const books: FanqieChartBook[] = ['a', 'b'].map((bookId, index) => ({
  bookId, rank: index + 1, title: `测试书${bookId}`, author: '', cover: '', genre: '都市',
  wordCount: '', readCount: '', intro: '主角雨夜签下契约。', tags: ['系统'], url: '', status: '', garbled: false
}))
function chapter(bookId: string, id: string): FanqieChapterContent {
  return { bookId, id, title: `第${id}章`, bookTitle: '测试书',
    content: '主角推开大门，当场撕毁契约。'.repeat(8), hasGarbled: false, url: '', wordCount: 100, fetchedAt: '' }
}
function opening(bookId: string, chapterId: string) {
  return { insights: ['opening_patterns', ...Array(3).fill('golden_three_directions')].map((dimension, i) => ({
    dimension, claim: dimension === 'opening_patterns' ? '主角以撕毁契约推动冲突' : `第${i}章让主角主动行动并兑现回报`,
    confidence: 'sample_supported', evidence: [{ bookId, field: 'chapter', chapterId, quote: '当场撕毁契约' }]
  })) }
}

describe('正文分析与黄金三章方向', () => {
  it('汇总拒绝单本依据、伪造引用与不完整章节方向', () => {
    const chapters = [chapter('a', '1'), chapter('b', '1')]
    const insights = ['a', 'b'].flatMap(id => validateInsights(opening(id, '1'), books, chapters).insights)
    const directions = GOLDEN_THREE_STAGES.map(stage => ({ stage, claim: '让主角主动推动冲突并兑现回报',
      evidence: ['a', 'b'].map(bookId => ({ bookId, field: 'chapter', chapterId: '1', quote: '当场撕毁契约' })) }))
    expect(validateGoldenThreeSummary({ directions }, books, chapters, insights).issues).toEqual([])
    const singleBook = directions.map(d => ({ ...d, evidence: d.evidence.slice(0, 1) }))
    expect(validateGoldenThreeSummary({ directions: singleBook }, books, chapters, insights).directions).toEqual([])
    const newQuotes = directions.map(d => ({ ...d, evidence: d.evidence.map(e => ({ ...e, quote: '主角推开大门' })) }))
    expect(validateGoldenThreeSummary({ directions: newQuotes }, books, chapters, insights).directions).toEqual([])
    expect(validateGoldenThreeSummary({ directions: directions.slice(0, 3) }, books, chapters, insights).issues.join('')).toContain('chapter_three')
  })

  it('核验到具体书籍章节，拒绝伪造摘引并将建议标为推测', () => {
    const chapters = [chapter('a', '1')]
    const valid = validateInsights(opening('a', '1'), books, chapters)
    expect(valid.insights).toHaveLength(4)
    expect(valid.insights[1].confidence).toBe('hypothesis')
    expect(valid.insights[0].evidence[0].chapterTitle).toBe('第1章')
    expect(validateInsights(opening('a', '2'), books, chapters).insights).toEqual([])
    expect(validateInsights(opening('b', '1'), books, chapters).insights).toEqual([])
    chapters[0].hasGarbled = true
    expect(validateInsights(opening('a', '1'), books, chapters).insights).toEqual([])
  })

  it.each([false, true])('传入完整缓存正文，综合多本书并保留逐本分析，分类汇总=%s', async (withSummary) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-analysis-'))
    try {
      const record: FanqieChartRecord = { id: 'new_book_male:261', chartType: 'new_book_male:261',
        chartDate: '2026-10-11', books, analysis: null, ideas: null, status: 'fetched', targetCount: 30,
        actualCount: 2, isPartial: true, partialReason: '', sourceHash: '', fetchedAt: '', updatedAt: '' }
      await writeJsonAtomic(path.join(dir, 'fanqie-charts', 'new_book_male__261.json'), record)
      const generateStream = vi.fn(async (prompt: string) => {
        if (prompt.includes('任务：分类黄金三章汇总')) {
          expect(prompt).toContain('测试书a')
          expect(prompt).toContain('测试书b')
          expect(prompt).toContain('当场撕毁契约')
          return JSON.stringify({ directions: GOLDEN_THREE_STAGES.map(stage => ({
            stage, claim: `${stage}让主角主动推进，阶段性兑现回报`,
            evidence: ['a', 'b'].map(bookId => ({ bookId, field: 'chapter', chapterId: '1', quote: '当场撕毁契约' }))
          })) })
        }
        if (prompt.includes('书籍ID：')) return JSON.stringify(opening(prompt.includes('书籍ID：b') ? 'b' : 'a', '1'))
        return JSON.stringify({ insights: Array.from({ length: 4 }, (_, i) => ({
          dimension: 'genre_characteristics', claim: `契约让人物面对困境${String.fromCharCode(65 + i)}`,
          confidence: 'sample_supported', evidence: [{ bookId: 'a', field: 'intro', quote: '雨夜签下契约' }]
        })) })
      })
      const service = new FanqieChartService(dir, { generateStream } as unknown as LlmService)
      let chapters = [chapter('a', '1')]
      vi.spyOn(service.chapterScraper, 'readCachedOpening').mockImplementation(async id => id === 'a' ? chapters : withSummary ? [chapter('b', '1')] : [])
      const first = await service.analyze(record.chartType, false)
      expect(first.analysis?.openingBookCount).toBe(withSummary ? 2 : 1)
      expect(first.analysis?.openingChapterCount).toBe(withSummary ? 2 : 1)
      expect(first.analysis?.insights.filter(i => i.dimension === 'golden_three_directions')).toHaveLength(withSummary ? 6 : 3)
      if (withSummary) {
        expect(first.analysis?.goldenThreeSummary?.bookCount).toBe(2)
        expect(first.analysis?.goldenThreeSummary?.directions).toHaveLength(6)
      } else {
        expect(first.analysis?.limitations.join('')).toContain('1 本没有有效正文')
        expect(first.analysis?.goldenThreeSummary).toBeNull()
      }
      expect(generateStream.mock.calls[1][0]).toContain(chapters[0].content)
      expect((await service.list())[0].analysis).toEqual(first.analysis)
      await service.analyze(record.chartType, false)
      expect(generateStream).toHaveBeenCalledTimes(withSummary ? 4 : 2)
      chapters = [...chapters, chapter('a', '2')]
      const second = await service.analyze(record.chartType, false)
      expect(second.analysis?.sourceHash).not.toBe(first.analysis?.sourceHash)
      expect(second.analysis?.openingChapterCount).toBe(withSummary ? 3 : 2)
      expect(generateStream).toHaveBeenCalledTimes(withSummary ? 6 : 3)
      if (withSummary) {
        let ideaAttempts = 0
        const idea = { ...qualityIdea('原创脑洞'),
          openingChapters: [1, 2, 3].map(chapter => ({ chapter,
            openingEvent: `债主带来第${chapter}次危机`, protagonistAction: '主角利用契约规则反制',
            conflict: '债主试图更改规则', payoff: '主角保住自己的店铺',
            endHook: '新债主找上门', summaryApplication: '主动推动冲突并兑现回报' })) }
        generateStream.mockImplementation(async prompt => {
          if (prompt.startsWith('你是独立的融梗审稿人')) return passingFusionReview(prompt)
          if (prompt.includes('你是严格的网文选题终审编辑')) return passingReviews(1)
          expect(prompt).toContain('本分类黄金三章总体写作方向')
          expect(prompt).toContain(second.analysis!.goldenThreeSummary!.directions[0].claim)
          ideaAttempts += 1
          return JSON.stringify({ ideas: [{ ...idea, openingChapters: idea.openingChapters.slice(0, ideaAttempts === 1 ? 2 : 3) }] })
        })
        const generated = await service.generateIdeas(record.chartType, 1, [])
        expect(ideaAttempts).toBe(2)
        expect(generated.ideas?.ideas[0].openingChapters).toEqual(idea.openingChapters)
        expect(generated.ideas?.analysisSourceHash).toBe(second.analysis?.sourceHash)
        expect((await service.list())[0].ideas).toEqual(generated.ideas)
        generateStream.mockResolvedValue(JSON.stringify({ ideas: [{ title: '缺章脑洞', coreConcept: '只有概念' }] }))
        await expect(service.generateIdeas(record.chartType, 1, [])).rejects.toThrow('缺少完整的前三章')
        expect((await service.list())[0].ideas).toEqual(generated.ideas)
      } else {
        await expect(service.generateIdeas(record.chartType, 1, [])).rejects.toThrow('还没有可用的黄金三章汇总')
        expect(generateStream).toHaveBeenCalledTimes(3)
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
