import { describe, it, expect } from 'vitest'
import {
  splitUnits,
  diffUnits,
  summarizeTextDiff,
  findFirstDiffWindow,
  listChangeHunks
} from '../src/shared/text-diff'

describe('splitUnits', () => {
  it('按空行切段', () => {
    const units = splitUnits('第一段\n\n第二段\n\n第三段')
    expect(units).toEqual(['第一段', '第二段', '第三段'])
  })

  it('无空行时按行切', () => {
    const units = splitUnits('第一行\n第二行\n第三行')
    expect(units).toEqual(['第一行', '第二行', '第三行'])
  })
})

describe('diffUnits / summarizeTextDiff', () => {
  it('检出替换段落', () => {
    const before = '他眼中闪过一丝悲伤。\n\n她没有说话。'
    const after = '他垂下眼。\n\n她没有说话。'
    const hunks = listChangeHunks(before, after)
    expect(hunks.length).toBeGreaterThanOrEqual(1)
    expect(hunks[0].before).toContain('眼中闪过')
    expect(hunks[0].after).toContain('垂下眼')

    const summary = summarizeTextDiff(before, after)
    expect(summary.length).toBeGreaterThan(0)
    expect(summary[0]).toMatch(/原句|改后/)
  })

  it('相同文本返回空', () => {
    expect(summarizeTextDiff('同一段', '同一段')).toEqual([])
    expect(listChangeHunks('同一段', '同一段')).toEqual([])
  })

  it('检出删除', () => {
    const before = 'A\n\n多余的升华句。\n\nB'
    const after = 'A\n\nB'
    const summary = summarizeTextDiff(before, after)
    expect(summary.some((s) => s.includes('删除') || s.includes('多余'))).toBe(true)
  })
})

describe('findFirstDiffWindow', () => {
  it('identical 时 identical=true', () => {
    const w = findFirstDiffWindow('abc', 'abc', 10)
    expect(w.identical).toBe(true)
    expect(w.offset).toBe(0)
  })

  it('差异在后半段时 offset 跳过相同前缀', () => {
    const prefix = '相同前缀'.repeat(50) // 远超 40
    const before = prefix + '旧内容在这里'
    const after = prefix + '新内容在这里'
    const w = findFirstDiffWindow(before, after, 600)
    expect(w.identical).toBe(false)
    expect(w.offset).toBeGreaterThan(0)
    // 窗口应包含差异，而不是只剩相同前缀
    expect(w.beforeSlice).toContain('旧内容')
    expect(w.afterSlice).toContain('新内容')
  })
})

describe('diffUnits LCS', () => {
  it('中间插入不误伤两侧相等段', () => {
    const before = ['甲', '乙', '丙']
    const after = ['甲', '新', '乙', '丙']
    const hunks = diffUnits(before, after)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].before).toBe('')
    expect(hunks[0].after).toBe('新')
  })
})
