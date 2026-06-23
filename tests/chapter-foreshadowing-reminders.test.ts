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
  it('groups plant/reinforce/collect reminders with new schema', () => {
    const outline: DetailedOutlineItem = {
      chapterNumber: 12,
      foreshadowings: ['窗外黑影', '旧钥匙']
    }
    const foreshadowings: Foreshadowing[] = [
      {
        ...baseForeshadowing,
        id: 'FB-001',
        content: '旧钥匙',
        status: 'pending'
      },
      {
        ...baseForeshadowing,
        id: 'FB-002',
        content: '铃声三响',
        status: 'planted',
        expectedCollect: 12
      },
      {
        ...baseForeshadowing,
        id: 'FB-003',
        content: '下卷才回收',
        status: 'planted',
        expectedCollect: 30
      }
    ]

    const result = buildForeshadowingReminders(12, outline, foreshadowings)
    expect(result.plant).toHaveLength(2)
    expect(result.plant.map((r) => r.content)).toEqual(['窗外黑影', '旧钥匙'])
    expect(result.reinforce).toHaveLength(1)
    expect(result.reinforce[0].id).toBe('FB-001')
    expect(result.collect).toHaveLength(1)
    expect(result.collect[0].id).toBe('FB-002')
  })

  it('deduplicates blank and repeated reminders', () => {
    const outline: DetailedOutlineItem = {
      chapterNumber: 3,
      foreshadowings: ['  铜镜  ', '', '铜镜']
    }
    const foreshadowings: Foreshadowing[] = [
      {
        ...baseForeshadowing,
        id: 'FB-001',
        content: ' 铜镜 ',
        status: 'pending'
      }
    ]

    const result = buildForeshadowingReminders(3, outline, foreshadowings)
    // outline + pending 都含"铜镜"，但 plant 段去重
    expect(result.plant).toHaveLength(1)
    expect(result.plant[0].content).toBe('铜镜')
    expect(result.reinforce).toHaveLength(1)
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

  it('returns empty arrays when JSON is invalid but tag exists', () => {
    const input = '正文【本章伏笔回执】{invalid json}'
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).not.toBeNull()
    expect(receipt!.planted).toEqual([])
    expect(receipt!.collected).toEqual([])
    expect(stripped).toBe('正文')
  })

  it('filters out non-string items in planted/collected', () => {
    const input = '正文【本章伏笔回执】{"planted":["a", 123, null],"collected":[456]}'
    const { receipt } = parseForeshadowReceipt(input)
    expect(receipt).not.toBeNull()
    expect(receipt!.planted).toEqual(['a'])
    expect(receipt!.collected).toEqual([])
  })

  it('handles receipt tag embedded in the middle of text', () => {
    const input = `前段
【本章伏笔回执】{"planted":["伏笔"]}
后段`
    const { receipt, stripped } = parseForeshadowReceipt(input)
    expect(receipt).not.toBeNull()
    expect(receipt!.planted).toEqual(['伏笔'])
    // 后段应被保留（strip 只从标签开始截断）
    expect(stripped).toBe('前段')
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
