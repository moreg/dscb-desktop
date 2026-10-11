import { describe, expect, it } from 'vitest'
import {
  formatFanqieReadCount,
  formatFanqieWordCount,
  parseFanqieChartType
} from '../src/shared/fanqie-chart'
import { prepareBooks, tagStatistics, validateInsights } from '../src/main/data/fanqie-chart/analysis'
import { decodeGlyphCache, encodeGlyphCache, matchGlyph, renderGlyph } from '../src/main/data/fanqie-chart/glyph-match'
import { formatReadCount, parseRankBooks, restoreText } from '../src/main/data/fanqie-chart/parse'
import type { FanqieChartBook } from '../src/shared/fanqie-chart'
import { Canvas } from 'skia-canvas'

function book(patch: Partial<FanqieChartBook>): FanqieChartBook {
  return {
    rank: 1,
    bookId: '1',
    title: '书名',
    author: '作者',
    cover: '',
    genre: '都市',
    wordCount: '1000',
    readCount: '1.2万',
    intro: '主角在雨夜签下一份不能反悔的契约。',
    tags: ['系统'],
    url: 'https://fanqienovel.com/page/1',
    status: '连载',
    garbled: false,
    ...patch
  }
}

describe('番茄榜单解析', () => {
  it('解析榜单接口并排重', () => {
    const books = parseRankBooks({
      data: {
        book_list: [
          { bookId: '9', bookName: '甲', author: '作者', abstract: '简介', read_count: '254487', wordNumber: 1200, creationStatus: '1', thumbUri: '' },
          { bookId: '9', bookName: '重复', author: '作者' },
          { bookId: '8', bookName: '乙', author: '作者', readCount: '12', creationStatus: '0' }
        ]
      }
    })
    expect(books.map((item) => item.bookId)).toEqual(['9', '8'])
    expect(books[0].readCount).toBe('25.4万')
    expect(books[0].status).toBe('连载')
    expect(books[1].status).toBe('完结')
    expect(books[1].rank).toBe(2)
  })

  it('阅读量不足一万时保留原数', () => {
    expect(formatReadCount(320)).toBe('320')
    expect(formatReadCount('3.5万')).toBe('3.5万')
  })

  it('拒绝不存在的分类', () => {
    expect(() => parseFanqieChartType('new_book_male:1')).toThrow('这个分类不在当前榜单里')
  })

  it('字数与在读人数规范化展示', () => {
    expect(formatFanqieWordCount('145196')).toBe('14.5万字')
    expect(formatFanqieWordCount(219713)).toBe('22.0万字')
    expect(formatFanqieWordCount('2334')).toBe('2334字')
    expect(formatFanqieWordCount('14.5万')).toBe('14.5万字')
    expect(formatFanqieWordCount('14.5万字')).toBe('14.5万字')
    expect(formatFanqieWordCount(undefined)).toBe('')

    expect(formatFanqieReadCount('22.2万')).toBe('22.2万在读')
    expect(formatFanqieReadCount('22.2万在读')).toBe('22.2万在读')
    expect(formatFanqieReadCount('')).toBe('')
  })

  it('书名不允许丢字，简介可以丢掉少量没对上的字', () => {
    const map = new Map<number, string>([[0xe001, '主']])
    expect(restoreText('\uE001角\uE002', map, 0)).toBe('主角□')
    expect(restoreText('\uE001角\uE002', map, 1)).toBe('主角')
  })
})

describe('榜单证据', () => {
  it('残缺书名不进入统计', () => {
    const stats = tagStatistics([
      book({ bookId: '1', tags: ['系统', '都市'] }),
      book({ bookId: '2', rank: 2, title: '另一本', tags: ['系统'], intro: '另一段简介。' }),
      book({ bookId: '3', rank: 3, title: '坏□名', garbled: true, tags: ['系统'] })
    ])
    const system = stats.find((item) => item.tag === '系统')
    expect(system?.count).toBe(2)
    expect(prepareBooks([book({ garbled: true })])).toEqual([])
  })

  it('结论必须摘到原文', () => {
    const books = [book({}), book({ bookId: '2', rank: 2, title: '另一本', intro: '妹妹把契约撕了。', tags: ['重生'] })]
    const ok = validateInsights({
      insights: [{
        dimension: 'hot_elements',
        claim: '开篇把一份不能反悔的约定放到人物面前',
        confidence: 'sample_supported',
        evidence: [
          { bookId: '1', field: 'intro', quote: '不能反悔的契约' },
          { bookId: '2', field: 'intro', quote: '把契约撕了' }
        ]
      }]
    }, books)
    expect(ok.insights).toHaveLength(1)
    expect(ok.issues).toEqual([])

    const bad = validateInsights({
      insights: [{
        dimension: 'hot_elements',
        claim: '前十都在写系统',
        confidence: 'sample_supported',
        evidence: [{ bookId: '1', field: 'intro', quote: '并不存在的句子' }]
      }]
    }, books)
    expect(bad.insights).toEqual([])
    expect(bad.issues.length).toBeGreaterThan(0)
  })
})

describe('字形对照', () => {
  it('同一个字能对上自己，缓存可以来回读写', () => {
    const canvas = new Canvas(128, 128)
    const rendered = renderGlyph(canvas as never, '永', '"Microsoft YaHei"')
    expect(rendered).not.toBeNull()
    const matched = matchGlyph(rendered!, [{
      codepoint: '永'.codePointAt(0)!,
      char: '永',
      vec: rendered!.vec,
      sig: rendered!.sig
    }])
    expect(matched).toBe('永')
    const restored = decodeGlyphCache(encodeGlyphCache([{
      codepoint: '永'.codePointAt(0)!,
      char: '永',
      vec: rendered!.vec,
      sig: rendered!.sig
    }]))
    expect(restored[0].char).toBe('永')
    expect(restored[0].vec[0]).toBeCloseTo(rendered!.vec[0])
  })
})
