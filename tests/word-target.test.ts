import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TARGET_WORDS,
  MAX_TARGET_WORDS,
  MIN_TARGET_WORDS,
  countProseWords,
  parseWordEstimate,
  resolveChapterTargetWords
} from '../src/shared/word-target'

/**
 * 细纲「字数预估」的解析。
 * 回归：旧实现只认 3-5 位半角数字，「3千字」「1.2万字」「３０００」这类写法
 * 会静默掉回兜底 2500——用户填了字数却完全不生效，且没有任何提示。
 */
describe('parseWordEstimate', () => {
  it('半角数字与常见前后缀', () => {
    expect(parseWordEstimate('约3000字')).toBe(3000)
    expect(parseWordEstimate('3000')).toBe(3000)
    expect(parseWordEstimate('不少于 2800 字')).toBe(2800)
  })

  it('区间取上限，兼容全角波浪号与「至」「到」', () => {
    expect(parseWordEstimate('3000-3500')).toBe(3500)
    expect(parseWordEstimate('3000~3500')).toBe(3500)
    expect(parseWordEstimate('3000～3500')).toBe(3500)
    expect(parseWordEstimate('3000至3500字')).toBe(3500)
    expect(parseWordEstimate('3000到3500字')).toBe(3500)
  })

  it('千/万量词写法', () => {
    expect(parseWordEstimate('3千字')).toBe(3000)
    expect(parseWordEstimate('1.2万字')).toBe(12000)
    expect(parseWordEstimate('三千字')).toBe(3000)
    expect(parseWordEstimate('两千五')).toBe(2500)
    expect(parseWordEstimate('一万二')).toBe(12000)
  })

  it('全角数字', () => {
    expect(parseWordEstimate('约３０００字')).toBe(3000)
  })

  it('无数字时返回 undefined，不静默编一个值', () => {
    expect(parseWordEstimate('适中')).toBeUndefined()
    expect(parseWordEstimate('')).toBeUndefined()
    expect(parseWordEstimate(undefined)).toBeUndefined()
  })
})

describe('resolveChapterTargetWords', () => {
  it('解析成功时标明来自细纲', () => {
    const r = resolveChapterTargetWords('约 3000 字')
    expect(r.targetWords).toBe(3000)
    expect(r.fromOutline).toBe(true)
    expect(r.clampedFrom).toBeUndefined()
    expect(r.bound).toBe('min')
  })

  it('解析不出时兜底，并明确标记 fromOutline=false（供 UI 提示补细纲）', () => {
    const r = resolveChapterTargetWords('适中即可')
    expect(r.targetWords).toBe(DEFAULT_TARGET_WORDS)
    expect(r.fromOutline).toBe(false)
  })

  it('极端值被夹取，且回报夹取前原值', () => {
    const low = resolveChapterTargetWords('300 字')
    expect(low.targetWords).toBe(MIN_TARGET_WORDS)
    expect(low.clampedFrom).toBe(300)

    const high = resolveChapterTargetWords('2万字')
    expect(high.targetWords).toBe(MAX_TARGET_WORDS)
    expect(high.clampedFrom).toBe(20000)
  })

  it('上限口径不能当硬性下限：「不超过 3000 字」标为 about', () => {
    expect(resolveChapterTargetWords('不超过3000字').bound).toBe('about')
    expect(resolveChapterTargetWords('3000字以内').bound).toBe('about')
    expect(resolveChapterTargetWords('最多3000字').bound).toBe('about')
    expect(resolveChapterTargetWords('约3000字').bound).toBe('min')
  })
})

describe('countProseWords', () => {
  it('剥掉换行与空格，与 main/data/words.ts 同口径', () => {
    expect(countProseWords('甲乙\n丙 丁\n\n戊')).toBe(5)
  })
})

