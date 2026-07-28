import { describe, expect, it } from 'vitest'
import {
  formatChapterProse,
  joinContinuation,
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

describe('joinContinuation', () => {
  it('原文停在句末时补换行，避免续写内容焊进原文最后一段', () => {
    // 回归：模型被要求「开头不需要承接词」，首 token 不是换行；裸拼会粘连
    expect(joinContinuation('他推开门。', '屋里没人。')).toBe('他推开门。\n屋里没人。')
    expect(joinContinuation('「你是谁？」', '没人应声。')).toBe('「你是谁？」\n没人应声。')
    expect(joinContinuation('他愣住了……', '风停了。')).toBe('他愣住了……\n风停了。')
  })

  it('原文停在句子中间时直接拼接——补换行会把一句话劈成两段', () => {
    // 回归：早先无条件补换行，「他推开」+「门，屋里没人。」会变成两段
    expect(joinContinuation('他推开', '门，屋里没人。')).toBe('他推开门，屋里没人。')
    expect(joinContinuation('他说这件事', '恐怕没那么简单。')).toBe(
      '他说这件事恐怕没那么简单。'
    )
  })

  it('原文本就以换行结尾时，尊重作者已分好的段', () => {
    // 末行停在句中，但作者显式换了行 → 仍然分段
    expect(joinContinuation('他推开\n', '门，屋里没人。')).toBe('他推开\n门，屋里没人。')
  })

  it('接缝两侧已有的换行/空白归一成单个换行', () => {
    expect(joinContinuation('他推开门。\n\n', '\n\n屋里没人。')).toBe('他推开门。\n屋里没人。')
    expect(joinContinuation('他推开门。\n', '屋里没人。')).toBe('他推开门。\n屋里没人。')
  })

  it('原文为空时直接返回续写内容，不留空行', () => {
    expect(joinContinuation('', '屋里没人。')).toBe('屋里没人。')
    expect(joinContinuation('   \n', '屋里没人。')).toBe('屋里没人。')
  })

  it('续写内容还没出实字时保持原文不变（流式首帧只有空白）', () => {
    expect(joinContinuation('他推开门。', '')).toBe('他推开门。')
    expect(joinContinuation('他推开门。', '\n')).toBe('他推开门。')
  })

  it('逐 token 累积时结果稳定（流式重算不会抖）', () => {
    const base = '他推开门。'
    const full = '屋里没人。'
    const frames = [1, 2, 3, 4, 5].map((n) => joinContinuation(base, full.slice(0, n)))
    expect(frames[frames.length - 1]).toBe('他推开门。\n屋里没人。')
    for (const f of frames) expect(f.startsWith('他推开门。\n')).toBe(true)
  })
})
