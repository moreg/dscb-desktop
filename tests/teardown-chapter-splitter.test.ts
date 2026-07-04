import { describe, it, expect } from 'vitest'
import {
  splitChapters,
  extractChapterText,
  chineseToNumber
} from '../src/main/data/teardown/teardown-chapter-splitter'

describe('chineseToNumber 中文数字解析', () => {
  it('阿拉伯数字', () => {
    expect(chineseToNumber('1')).toBe(1)
    expect(chineseToNumber('001')).toBe(1)
    expect(chineseToNumber('99')).toBe(99)
  })

  it('简单中文数字', () => {
    expect(chineseToNumber('一')).toBe(1)
    expect(chineseToNumber('九')).toBe(9)
  })

  it('十位中文数字', () => {
    expect(chineseToNumber('十')).toBe(10)
    expect(chineseToNumber('十一')).toBe(11)
    expect(chineseToNumber('二十')).toBe(20)
    expect(chineseToNumber('二十一')).toBe(21)
    expect(chineseToNumber('九十九')).toBe(99)
  })

  it('百位中文数字', () => {
    expect(chineseToNumber('一百')).toBe(100)
    expect(chineseToNumber('一百零一')).toBe(101)
    expect(chineseToNumber('一百二十三')).toBe(123)
  })

  it('非法输入返回 null', () => {
    expect(chineseToNumber('')).toBeNull()
    expect(chineseToNumber('abc')).toBeNull()
  })
})

describe('splitChapters 章节切片', () => {
  it('识别「第N章：标题」格式', () => {
    const raw =
      '引子内容\n' +
      '第一章 开端\n第一章的内容\n' +
      '第二章：发展\n第二章的内容\n' +
      '第三章 高潮\n第三章的内容\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(3)
    expect(boundaries[0].chapter).toBe(1)
    expect(boundaries[1].chapter).toBe(2)
    expect(boundaries[2].chapter).toBe(3)
  })

  it('支持中文数字章节号', () => {
    const raw =
      '第一章 开端\n内容一\n' +
      '第二章 发展\n内容二\n' +
      '第十节 中段\n内容十\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(3)
    expect(boundaries[0].chapter).toBe(1)
    expect(boundaries[1].chapter).toBe(2)
    expect(boundaries[2].chapter).toBe(10)
  })

  it('支持回/卷后缀', () => {
    const raw = '第一回 楔子\n内容\n第二回 入世\n内容\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(2)
    expect(boundaries[1].chapter).toBe(2)
  })

  it('边界 start/end 正确切到下一章标题', () => {
    const raw = '第一章 A\naaa\n第二章 B\nbbb\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(2)
    expect(raw.slice(boundaries[0].start, boundaries[0].end)).toContain('aaa')
    expect(raw.slice(boundaries[0].start, boundaries[0].end)).not.toContain('第二章 B')
    expect(raw.slice(boundaries[1].start, boundaries[1].end)).toContain('bbb')
  })

  it('末章 end 为文本末尾', () => {
    const raw = '第一章 A\n内容内容\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0].end).toBe(raw.length)
  })

  it('无章节标题返回空数组', () => {
    expect(splitChapters('纯文本内容无章节标记')).toEqual([])
  })

  it('去重：同章号取首次出现', () => {
    const raw = '第一章 A\n内容\n第一章 B\n内容2\n第二章 C\n内容3\n'
    const boundaries = splitChapters(raw)
    expect(boundaries).toHaveLength(2)
    expect(boundaries[0].title).toBe('A')
  })

  it('提取标题去前缀分隔符', () => {
    const raw = '第一章：开端\n内容\n'
    const boundaries = splitChapters(raw)
    expect(boundaries[0].title).toBe('开端')
  })
})

describe('extractChapterText 按边界取章节', () => {
  it('返回指定边界范围内的文本', () => {
    const raw = '第一章 A\naaa\n第二章 B\nbbb\n'
    const boundaries = splitChapters(raw)
    const ch1 = extractChapterText(raw, boundaries[0])
    expect(ch1).toContain('aaa')
    expect(ch1).not.toContain('bbb')
  })

  it('空标题时兜底为「第N章」', () => {
    const raw = '第一章\n内容\n'
    const boundaries = splitChapters(raw)
    expect(boundaries[0].title).toBe('第1章')
  })
})
