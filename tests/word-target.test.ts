import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TARGET_WORDS,
  MAX_TARGET_WORDS,
  MIN_TARGET_WORDS,
  countProseWords,
  describeDeslopShortfall,
  describeWordShortfall,
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

/**
 * 写完之后的字数达标提示。
 * 回归：此前全链路没有任何地方核对实际字数（审稿的 word_count 已废、自检也没这项），
 * 模型写少了既没提示也没人补。
 */
describe('describeWordShortfall', () => {
  const budget = {
    targetWords: 3000,
    chapterTargetWords: 3000,
    writtenWords: 0,
    fromOutline: true
  }

  it('从零写整章且达标时不打扰', () => {
    expect(describeWordShortfall(budget, '甲'.repeat(3000))).toBeNull()
    // 差 5% 以内不算短
    expect(describeWordShortfall(budget, '甲'.repeat(2900))).toBeNull()
  })

  it('从零写整章写不够时报出缺口', () => {
    const msg = describeWordShortfall(budget, '甲'.repeat(2000))
    expect(msg).toContain('2000')
    expect(msg).toContain('3000')
    expect(msg).toContain('少 1000 字')
  })

  it('续写：本次增量不够时同时报本次与整章进度', () => {
    const msg = describeWordShortfall(
      { targetWords: 1500, chapterTargetWords: 3000, writtenWords: 1500, fromOutline: true },
      '甲'.repeat(2000)
    )
    expect(msg).toContain('本次只写了 500 字')
    expect(msg).toContain('全章 2000/3000 字')
    expect(msg).toContain('还差 1000 字')
  })

  it('续写：本次达标但整章仍差时只报整章进度', () => {
    const msg = describeWordShortfall(
      { targetWords: 500, chapterTargetWords: 3000, writtenWords: 1500, fromOutline: true },
      '甲'.repeat(2100)
    )
    expect(msg).not.toContain('本次只写了')
    expect(msg).toContain('全章 2100/3000 字')
  })

  it('续写全部达标时不打扰', () => {
    expect(
      describeWordShortfall(
        { targetWords: 1500, chapterTargetWords: 3000, writtenWords: 1500, fromOutline: true },
        '甲'.repeat(3000)
      )
    ).toBeNull()
  })

  it('兜底目标要说明来源，避免用户以为细纲生效了', () => {
    const msg = describeWordShortfall({ ...budget, fromOutline: false }, '甲'.repeat(1000))
    expect(msg).toContain('细纲未填字数预估')
  })

  it('空白不计入字数', () => {
    // 3000 个"甲"配 3000 个换行：按字符数会误判达标
    const msg = describeWordShortfall(budget, '甲\n'.repeat(1500))
    expect(msg).toContain('1500')
  })

  it('无 budget 时返回 null（旧版主进程回包没有这个字段）', () => {
    expect(describeWordShortfall(undefined, '甲'.repeat(10))).toBeNull()
  })
})

/**
 * 去 AI 味后的篇幅提示。
 * 回归：删除比例上限（最高 35%）是相对原文算的，与细纲目标无关——
 * 3000 字改完剩 2000 字会照常"通过"，成品就此短了却没有任何地方提示。
 */
describe('describeDeslopShortfall', () => {
  const target = { targetWords: 3000, fromOutline: true }

  it('删到目标以下时报出缺口与前后字数', () => {
    const msg = describeDeslopShortfall(2000, target, 3000)
    expect(msg).toContain('3000 → 2000 字')
    expect(msg).toContain('细纲目标 3000 字')
    expect(msg).toContain('还差 1000 字')
  })

  it('仍达标时不打扰（含 5% 容差）', () => {
    expect(describeDeslopShortfall(3000, target, 3200)).toBeNull()
    expect(describeDeslopShortfall(2900, target, 3000)).toBeNull()
  })

  it('原文本就短于目标时也会提示（改写没让它变好）', () => {
    expect(describeDeslopShortfall(2000, target, 2000)).toContain('还差 1000 字')
  })

  it('兜底目标要说明来源', () => {
    expect(describeDeslopShortfall(2000, { targetWords: 3000, fromOutline: false }, 3000)).toContain(
      '默认目标'
    )
  })
})
