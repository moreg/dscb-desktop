import { describe, it, expect } from 'vitest'
import {
  countLatinWords,
  isPrimarilyChinese,
  unitHasLanguageLeak,
  guardLanguageLeak
} from '../src/main/data/deslop/language-guard'

describe('language-guard 基础判定', () => {
  it('识别中文主导段落', () => {
    expect(isPrimarilyChinese('他刚才若没喊停车，福特车再往前开几丈。')).toBe(true)
    expect(isPrimarilyChinese('Hello world this is English only text.')).toBe(false)
  })

  it('检出 他→He', () => {
    expect(
      unitHasLanguageLeak(
        '他刚才若没喊停车，福特车再往前开几丈，马车正好撞在后座。',
        'He刚才若没喊停车，福特车再往前开几丈，马车正好撞在后座。'
      )
    ).toBe(true)
  })

  it('检出整句英译', () => {
    expect(
      unitHasLanguageLeak('（直接 说 吧，）', '(Just say it.)')
    ).toBe(true)
  })

  it('正常中文改味不误报', () => {
    expect(
      unitHasLanguageLeak(
        '他眼中闪过一丝悲伤。',
        '他垂下眼。'
      )
    ).toBe(false)
  })

  it('原文已有英文专名时不因保留专名误报', () => {
    expect(
      unitHasLanguageLeak(
        '他买了一台 iPhone。',
        '他掏出那台 iPhone。'
      )
    ).toBe(false)
  })
})

describe('guardLanguageLeak 回退', () => {
  it('段级回退 He 泄漏，保留其它合法改写', () => {
    const original =
      '他刚才若没喊停车。\n\n苏九侧身让开。'
    const rewritten =
      'He刚才若没喊停车。\n\n苏九往旁边一让。'
    const r = guardLanguageLeak(original, rewritten)
    expect(r.revertedUnits).toBe(1)
    expect(r.text).toContain('他刚才若没喊停车')
    expect(r.text).not.toMatch(/\bHe\b/)
    // 第二段合法改写应保留
    expect(r.text).toContain('苏九往旁边一让')
  })

  it('大量英译整篇回退', () => {
    const original = '他走到门口。\n\n她没有说话。\n\n风很大。'
    const rewritten =
      'He walked to the door.\n\nShe said nothing.\n\nThe wind was strong.'
    const r = guardLanguageLeak(original, rewritten)
    expect(r.revertedUnits).toBeGreaterThan(0)
    expect(r.text).toBe(original)
  })

  it('无泄漏时原样返回', () => {
    const original = '他垂下眼。\n\n她没接话。'
    const rewritten = '他垂下眼。\n\n她没接话。'
    const r = guardLanguageLeak(original, rewritten)
    expect(r.revertedUnits).toBe(0)
    expect(r.text).toBe(rewritten)
  })

  it('countLatinWords 统计英文词', () => {
    expect(countLatinWords('He刚才')).toBe(1)
    expect(countLatinWords('Just say it')).toBe(3)
    expect(countLatinWords('他刚才')).toBe(0)
  })
})
