import { describe, expect, it } from 'vitest'
import {
  buildForeshadowingReminders,
  parseForeshadowReceipt
} from '../src/renderer/src/foreshadowingReminders'
import { isForeshadowMatch } from '../src/shared/parsers'
import type { DetailedOutlineItem, Foreshadowing } from '../src/shared/types'

const baseForeshadowing = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('buildForeshadowingReminders', () => {
  const f = (id: string, patch: Partial<Foreshadowing> = {}): Foreshadowing => ({
    ...baseForeshadowing, id, content: id, status: 'planted', plantChapter: 1, ...patch
  })

  it('distinguishes a new planting plan, a mentioned existing thread, and a collection reminder', () => {
    const outline: DetailedOutlineItem = { chapterNumber: 12, foreshadowings: ['窗外黑影', '旧钥匙'] }
    const result = buildForeshadowingReminders(12, outline, [
      f('FB-001', { content: '旧钥匙', plantChapter: 3 }),
      f('FB-002', { content: '铃声三响', expectedCollect: 12 }),
      f('FB-003', { content: '下卷才回收', plantChapter: 10, expectedCollect: 30 })
    ])
    expect(result.plant.map((item) => item.content)).toEqual(['窗外黑影'])
    expect(result.reinforce.map((item) => item.id)).toEqual(['FB-001'])
    expect(result.collect.map((item) => item.id)).toEqual(['FB-002'])
    expect(result.collect[0].overdue).toBe(false)
  })

  it('puts pending plans in plant and does not pretend an unplanted thread can be reinforced', () => {
    const result = buildForeshadowingReminders(5, null, [
      f('本章计划', { status: 'pending', plantChapter: 5 }),
      f('他章计划', { status: 'pending', plantChapter: 10 }),
      f('未安排', { status: 'pending', plantChapter: undefined })
    ])
    expect(result.plant.map((item) => item.id)).toEqual(['本章计划'])
    expect(result.reinforce).toEqual([])
  })

  it('deduplicates the same library record without merging distinct IDs with identical wording', () => {
    const result = buildForeshadowingReminders(3, { chapterNumber: 3, foreshadowings: [' 铜镜 ', '', '铜镜'] }, [
      f('one', { content: ' 铜镜 ', status: 'pending', plantChapter: 3 })
    ])
    expect(result.plant).toHaveLength(1)
    expect(result.plant[0]).toMatchObject({ id: 'one', content: '铜镜' })
    const due = buildForeshadowingReminders(3, null, [
      f('one', { content: '铜镜', expectedCollect: 3 }), f('two', { content: '铜镜', expectedCollect: 3 })
    ])
    expect(due.collect.map((item) => item.id)).toEqual(['one', 'two'])
  })

  it('keeps overdue threads visible, including partial/reinforced, but leaves deferred threads paused', () => {
    const result = buildForeshadowingReminders(20, null, [
      f('overdue', { status: 'partial', expectedCollect: 15, partialCollectChapters: [12] }),
      f('due', { status: 'reinforced', expectedCollect: 20, reinforcementChapters: [14] }),
      f('paused', { status: 'deferred', expectedCollect: 10 }),
      f('closed', { status: 'collected', expectedCollect: 20, actualCollect: 19 })
    ])
    expect(result.collect.map((item) => item.id)).toEqual(['overdue', 'due'])
    expect(result.collect[0].overdue).toBe(true)
    expect(result.reinforce).toEqual([])
  })

  it('restores a later collection when viewing an earlier chapter and excludes future planting', () => {
    const result = buildForeshadowingReminders(10, null, [
      f('futureCollected', { status: 'collected', expectedCollect: 10, actualCollect: 30, reinforcementChapters: [7, 22] }),
      f('futurePlanted', { status: 'planted', plantChapter: 20, expectedCollect: 10 })
    ])
    expect(result.collect.map((item) => item.id)).toEqual(['futureCollected'])
    expect(result.reinforce).toEqual([])
  })

  it('reminds about long-silent planted threads, respects recent progress, and caps background suggestions', () => {
    const result = buildForeshadowingReminders(30, { chapterNumber: 30, foreshadowings: ['本章相关'] }, [
      ...Array.from({ length: 10 }, (_, index) => f(`old-${index}`, { plantChapter: index + 1 })),
      f('relevant', { content: '本章相关', plantChapter: 28 }),
      f('recent', { reinforcementChapters: [27] }),
      f('partialRecent', { status: 'partial', partialCollectChapters: [25] })
    ])
    expect(result.reinforce).toHaveLength(8)
    expect(result.reinforce[0].id).toBe('relevant')
    expect(result.reinforce.some((item) => item.id === 'recent' || item.id === 'partialRecent')).toBe(false)
    expect(result.reinforce[1].id).toBe('old-0')
    const required = Array.from({ length: 10 }, (_, index) => f(`required-${index}`, { plantChapter: 20 }))
    expect(buildForeshadowingReminders(30, { chapterNumber: 30, foreshadowings: required.map((item) => item.content) }, required).reinforce)
      .toHaveLength(10)
  })
})

describe('parseForeshadowReceipt', () => {
  it('parses a valid receipt and strips it from the original text', () => {
    const input = `正文内容到这里结束。
【本章伏笔回执】{"planted":["伏笔 A"],"collected":["伏笔 B"]}`
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).not.toBeNull()
    expect(receipt!.planted).toEqual(['伏笔 A'])
    expect(receipt!.collected).toEqual(['伏笔 B'])
    expect(stripped).toBe('正文内容到这里结束。')
  })

  it('returns null receipt when no receipt tag is present', () => {
    const input = '纯正文，没有回执'
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).toBeNull()
    expect(stripped).toBe(input)
  })

  it('preserves the original text when the receipt JSON is invalid', () => {
    const input = '正文【本章伏笔回执】{invalid json}'
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).toBeNull()
    expect(stripped).toBe(input)
  })

  it('does not silently accept malformed receipt fields', () => {
    const input = '正文【本章伏笔回执】{"planted":["a", 123, null],"collected":[456]}'
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).toBeNull()
    expect(stripped).toBe(input)
  })

  it('preserves all prose following an embedded receipt-like JSON', () => {
    const input = `前段
【本章伏笔回执】{"planted":["伏笔"]}
后段`
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).toBeNull()
    expect(stripped).toBe(input)
  })

  it('does not truncate prose that mentions the tag before the real terminal receipt', () => {
    const body = '信封上写着“【本章伏笔回执】”。林舟把它塞进口袋。\n\n\n门外有人喊他的名字。'
    const input = body + '\n【本章伏笔回执】' + JSON.stringify({
      planted: ['信封上印着【本章伏笔回执】', '符号 } 与引号 " 都在信上'], collected: []
    })
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(stripped).toBe(body)
    expect(receipt?.planted).toEqual(['信封上印着【本章伏笔回执】', '符号 } 与引号 " 都在信上'])
  })

  it.each(['{}', '[]', '{"other":[]}', '{"planted":"正文"}'])('preserves invalid receipt shape %s', (json) => {
    const input = '正文。\n【本章伏笔回执】' + json
    expect(parseForeshadowReceipt(input)).toEqual({ receipt: null, stripped: input })
  })
})

describe('isForeshadowMatch', () => {
  it('matches when one string is a substring and length ratio is ≥ 0.5', () => {
    // "旧钥匙"(3) vs "那把旧钥匙"(5): ratio = 3/5 = 0.6 ≥ 0.5 → 匹配
    expect(isForeshadowMatch('旧钥匙', '那把旧钥匙')).toBe(true)
    expect(isForeshadowMatch('旧钥匙', '旧钥匙')).toBe(true)
    // "眼睛"(2) vs "她的眼睛"(4): ratio = 0.5 → 边界匹配
    expect(isForeshadowMatch('眼睛', '她的眼睛')).toBe(true)
  })

  it('rejects when length ratio is too small', () => {
    // "图"(1) vs "图书"(2): 长度<2 直接拒绝
    expect(isForeshadowMatch('图', '图书')).toBe(false)
    // "图"(1) vs "图书馆"(3): ratio = 0.33 → 拒绝
    expect(isForeshadowMatch('图', '图书馆')).toBe(false)
    // "旧钥匙"(3) vs "那把生锈的旧钥匙"(9): ratio = 0.33 → 拒绝
    expect(isForeshadowMatch('旧钥匙', '那把生锈的旧钥匙')).toBe(false)
  })

  it('rejects when either string is shorter than 2 chars', () => {
    expect(isForeshadowMatch('a', 'abc')).toBe(false)
    expect(isForeshadowMatch('', 'anything')).toBe(false)
    expect(isForeshadowMatch('x', 'xy')).toBe(false)
  })

  it('rejects when neither string contains the other', () => {
    expect(isForeshadowMatch('钥匙', '铃声')).toBe(false)
    expect(isForeshadowMatch('眼睛', '耳朵')).toBe(false)
  })
})
