import { describe, it, expect } from 'vitest'
import {
  parseAdjustPlanItems,
  parseListItemLines,
  extractMarkdownSection,
  buildConfirmedPlanFromSelection,
  selectedPlanTexts
} from '../src/shared/adjust-plan-items'

describe('parseListItemLines', () => {
  it('parses -, *, numbered, and Chinese顿号 items', () => {
    const block = `
- 删旁白
* 加动作
1. 改结尾
2) 压短铺垫
3、加强女主反击
（4）收束伏笔
`
    expect(parseListItemLines(block)).toEqual([
      '删旁白',
      '加动作',
      '改结尾',
      '压短铺垫',
      '加强女主反击',
      '收束伏笔'
    ])
  })

  it('dedupes identical lines', () => {
    expect(parseListItemLines('1. 同一条\n2. 同一条')).toEqual(['同一条'])
  })
})

describe('extractMarkdownSection', () => {
  it('cuts until next heading', () => {
    const plan = `## 理解
一段话
## 落笔要点
1. A
2. B
## 其他
C`
    const sec = extractMarkdownSection(plan, (l) => /^##\s*落笔要点/.test(l))
    expect(sec).toContain('1. A')
    expect(sec).toContain('2. B')
    expect(sec).not.toContain('## 其他')
  })
})

describe('parseAdjustPlanItems', () => {
  it('prefers 落笔要点 section', () => {
    const plan = `## 理解你的要求
想加强冲突。
## 修改建议
1. 这条不要（在修改建议里）
## 落笔要点
1. 删掉旁白解释
2. 加入女主动作反击
3. 结尾改成对话钩子
`
    const items = parseAdjustPlanItems(plan)
    expect(items.map((x) => x.text)).toEqual([
      '删掉旁白解释',
      '加入女主动作反击',
      '结尾改成对话钩子'
    ])
    expect(items[0].id).toBe('item-0')
  })

  it('falls back to 修改建议 when no 落笔要点 list', () => {
    const plan = `## 修改建议
- 压缩开篇
- 加强对峙
## 风险与取舍
可能偏短
`
    expect(parseAdjustPlanItems(plan).map((x) => x.text)).toEqual(['压缩开篇', '加强对峙'])
  })

  it('returns empty for blank or prose-only plan', () => {
    expect(parseAdjustPlanItems('')).toEqual([])
    expect(parseAdjustPlanItems('只是一段没有列表的意见。')).toEqual([])
  })
})

describe('buildConfirmedPlanFromSelection / selectedPlanTexts', () => {
  it('builds plan that only keeps checked items', () => {
    const full = '## 落笔要点\n1. A\n2. B\n3. C'
    const confirmed = buildConfirmedPlanFromSelection(full, ['A', 'C'])
    expect(confirmed).toContain('用户勾选的落笔要点')
    expect(confirmed).toContain('1. A')
    expect(confirmed).toContain('2. C')
    expect(confirmed).toContain('仅执行以下条目')
    expect(confirmed).toContain(full)
    // 编号只反映勾选顺序，不应把未勾选的 B 放进要点区顶部编号
    const top = confirmed.split('## 完整修改建议')[0]
    expect(top).not.toMatch(/^\d+\.\s*B$/m)
  })

  it('selectedPlanTexts filters unchecked', () => {
    expect(
      selectedPlanTexts([
        { text: 'A', checked: true },
        { text: 'B', checked: false },
        { text: 'C', checked: true }
      ])
    ).toEqual(['A', 'C'])
  })

  it('empty selection yields empty confirmed plan', () => {
    expect(buildConfirmedPlanFromSelection('full', [])).toBe('')
  })
})
