import { describe, expect, it } from 'vitest'
import {
  formatChapterProse,
  needsChapterProseFormat
} from '../src/shared/format-chapter-prose'

describe('formatChapterProse', () => {
  it('removes half-width spaces but keeps single newlines', () => {
    expect(formatChapterProse('沈 渡 皱 眉\n他走了。')).toBe('沈渡皱眉\n他走了。')
  })

  it('removes full-width spaces and normalizes CRLF', () => {
    expect(formatChapterProse('沈渡　皱眉\r\n他走了。')).toBe('沈渡皱眉\n他走了。')
  })

  it('collapses blank lines into a single newline', () => {
    expect(formatChapterProse('甲\n\n\n乙\n\n丙')).toBe('甲\n乙\n丙')
  })

  it('removes tabs and spaces on blank lines before collapsing', () => {
    expect(formatChapterProse('甲\n  \n\t\n乙')).toBe('甲\n乙')
  })

  it('trims leading and trailing blank lines', () => {
    expect(formatChapterProse('\n\n开头\n结尾\n\n')).toBe('开头\n结尾')
  })

  it('returns empty / unchanged when already clean', () => {
    expect(formatChapterProse('')).toBe('')
    expect(formatChapterProse('无空白\n两行')).toBe('无空白\n两行')
  })

  it('documents aggressive policy: Latin word spaces are also removed', () => {
    // 产品选择：激进去空格；混排/英文词间空格不保留
    expect(formatChapterProse('Hello World')).toBe('HelloWorld')
    expect(formatChapterProse('用 iPhone 拍照')).toBe('用iPhone拍照')
  })

  it('needsChapterProseFormat detects residual issues', () => {
    expect(needsChapterProseFormat('有 空格')).toBe(true)
    expect(needsChapterProseFormat('有\n\n空行')).toBe(true)
    expect(needsChapterProseFormat('有\r\n回车')).toBe(true)
    expect(needsChapterProseFormat('尾部空行\n')).toBe(true)
    expect(needsChapterProseFormat('紧凑\n两行')).toBe(false)
  })
})
