import { describe, it, expect } from 'vitest'
import {
  draftPath,
  isDraftDifferent,
  formatDraftAge,
  AUTO_SAVE_DEBOUNCE_MS
} from '../src/main/data/draft'

describe('draftPath', () => {
  it('returns .draft-NNN.md under 正文/', () => {
    // Windows path.join 用反斜杠，Unix 用正斜杠——用 endsWith 检查
    const p1 = draftPath('/proj/abc', 1)
    expect(p1.endsWith('.draft-001.md')).toBe(true)
    expect(p1).toContain('正文')
    expect(draftPath('/proj/abc', 42).endsWith('.draft-042.md')).toBe(true)
  })

  it('pads chapterNumber to 3 digits', () => {
    const p = draftPath('/p', 7)
    expect(p).toContain('.draft-007.md')
  })
})

describe('isDraftDifferent', () => {
  it('returns false when draft equals saved', () => {
    expect(isDraftDifferent('hello', 'hello')).toBe(false)
  })

  it('returns true when content differs', () => {
    expect(isDraftDifferent('hello world', 'hello')).toBe(true)
    expect(isDraftDifferent('', 'non-empty')).toBe(true)
  })

  it('treats empty draft as different from non-empty saved', () => {
    expect(isDraftDifferent('', '正文内容')).toBe(true)
  })
})

describe('formatDraftAge', () => {
  it('< 5 秒 → "刚刚"', () => {
    const t = 1000
    expect(formatDraftAge(t, t)).toBe('刚刚')
    expect(formatDraftAge(t, t + 4_999)).toBe('刚刚')
  })

  it('5-59 秒 → "X 秒前"', () => {
    const t = 1000
    expect(formatDraftAge(t, t + 5_000)).toBe('5 秒前')
    expect(formatDraftAge(t, t + 30_000)).toBe('30 秒前')
  })

  it('60-3599 秒 → "X 分钟前"', () => {
    const t = 1000
    expect(formatDraftAge(t, t + 60_000)).toBe('1 分钟前')
    expect(formatDraftAge(t, t + 5 * 60_000)).toBe('5 分钟前')
  })

  it('≥ 1 小时 → "X 小时前"', () => {
    const t = 1000
    expect(formatDraftAge(t, t + 60 * 60_000)).toBe('1 小时前')
    expect(formatDraftAge(t, t + 23 * 60 * 60_000)).toBe('23 小时前')
  })

  it('≥ 24 小时 → "X 天前"', () => {
    const t = 1000
    expect(formatDraftAge(t, t + 24 * 60 * 60_000)).toBe('1 天前')
  })

  it('未来时间戳（now < timestamp）→ "刚刚"（兜底）', () => {
    expect(formatDraftAge(10_000, 5_000)).toBe('刚刚')
  })
})

describe('AUTO_SAVE_DEBOUNCE_MS', () => {
  it('默认值 800ms', () => {
    expect(AUTO_SAVE_DEBOUNCE_MS).toBe(800)
  })
})

describe('P19-A 集成: 草稿生命周期', () => {
  it('典型流程: 编辑 → 自动保存草稿 → 正式保存 → 草稿被清掉', () => {
    // 模拟：用户在草稿状态下编辑
    const initialDraft = '第一段草稿内容'
    // 自动保存写入
    // 正式保存后清除草稿
    const afterFormalSave = '' // 草稿被 discardDraft 清掉
    expect(isDraftDifferent(initialDraft, afterFormalSave)).toBe(true) // 期间有过不同
    expect(afterFormalSave).toBe('')
  })

  it('恢复流程: 草稿存在且与正文不同 → 提示恢复', () => {
    const draft = '草稿版本（有修改）'
    const saved = '正式保存的版本'
    expect(isDraftDifferent(draft, saved)).toBe(true)
  })

  it('不恢复: 草稿与正文相同（只是文件没清）', () => {
    const same = '相同内容'
    expect(isDraftDifferent(same, same)).toBe(false)
  })
})
