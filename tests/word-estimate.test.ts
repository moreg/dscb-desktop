import { describe, it, expect } from 'vitest'
import {
  summarizeProjectWords,
  statusOf,
  formatProgress,
  type ChapterStatus
} from '../src/main/data/word-estimate'
import type { RhythmEntry } from '../src/shared/types'

const rhythm: RhythmEntry[] = [
  { chapter: 1, title: '开局', emotion: 5, climax: 1, volume: 1, actualized: true },
  { chapter: 2, title: '初遇', emotion: 6, climax: 2, volume: 1, actualized: false },
  { chapter: 3, title: '转折', emotion: 8, climax: 3, volume: 1, actualized: false }
]

describe('statusOf', () => {
  it('wordCount=0 → unknown', () => {
    expect(statusOf(0)).toBe('unknown')
  })

  it('1-499 → outline', () => {
    expect(statusOf(1)).toBe('outline')
    expect(statusOf(499)).toBe('outline')
  })

  it('500-1999 → drafted', () => {
    expect(statusOf(500)).toBe('drafted')
    expect(statusOf(1500)).toBe('drafted')
    expect(statusOf(1999)).toBe('drafted')
  })

  it('2000+ → finished', () => {
    expect(statusOf(2000)).toBe('finished')
    expect(statusOf(5000)).toBe('finished')
  })
})

describe('summarizeProjectWords', () => {
  it('空 rhythm + 空 progress → 全 0', () => {
    const s = summarizeProjectWords([], [])
    expect(s.totalWords).toBe(0)
    expect(s.chapters).toEqual([])
    expect(s.byStatus).toEqual({ unknown: 0, outline: 0, drafted: 0, finished: 0 })
    expect(s.progress).toBe(0)
  })

  it('rhythm 没 wordCount → 默认 0（从 progress 取）', () => {
    const r: RhythmEntry[] = [
      { chapter: 1, title: '第1章', emotion: 5, climax: 1, volume: 1, actualized: true }
    ]
    const s = summarizeProjectWords(r, [])
    expect(s.chapters[0].wordCount).toBe(0)
    expect(s.chapters[0].status).toBe('unknown')
  })

  it('progress 提供字数 → 使用 progress', () => {
    const r: RhythmEntry[] = [
      { chapter: 1, title: '第1章', emotion: 5, climax: 1, volume: 1, actualized: true }
    ]
    const s = summarizeProjectWords(r, [{ chapterNumber: 1, wordCount: 2500 }])
    expect(s.chapters[0].wordCount).toBe(2500)
    expect(s.chapters[0].status).toBe('finished')
  })

  it('混合状态分布', () => {
    const progress = [
      { chapterNumber: 1, wordCount: 0 }, // unknown
      { chapterNumber: 2, wordCount: 100 }, // outline
      { chapterNumber: 3, wordCount: 1500 }, // drafted
      { chapterNumber: 4, wordCount: 3000 } // finished
    ]
    const r: RhythmEntry[] = progress.map((p) => ({
      chapter: p.chapterNumber,
      title: `第${p.chapterNumber}章`,
      emotion: 5,
      climax: 1,
      volume: 1,
      actualized: p.wordCount > 0
    }))
    const s = summarizeProjectWords(r, progress)
    expect(s.chapters).toHaveLength(4)
    expect(s.byStatus).toEqual({
      unknown: 1, // chapter 1
      outline: 1, // chapter 2
      drafted: 1, // chapter 3
      finished: 1 // chapter 4
    })
    expect(s.totalWords).toBe(4600)
  })

  it('estimatedTotal = max(实际总字数, 章节数 × 2500)', () => {
    // 3 章 × 2500 = 7500
    const s = summarizeProjectWords(rhythm, [])
    expect(s.estimatedTotal).toBe(7500)
    // 总字数 0 但 estimatedTotal 仍按 7500 计算
    expect(s.progress).toBe(0)
  })

  it('progress = totalWords / estimatedTotal（≤1）', () => {
    const s = summarizeProjectWords(rhythm, [
      { chapterNumber: 1, wordCount: 5000 }, // 已超目标
      { chapterNumber: 2, wordCount: 0 },
      { chapterNumber: 3, wordCount: 0 }
    ])
    // total = 5000, estimated = 7500 → 5000/7500 = 0.667
    expect(s.progress).toBeCloseTo(0.667, 2)
  })

  it('uses rhythm title when present', () => {
    const r: RhythmEntry[] = [
      { chapter: 1, title: '风起云涌', emotion: 5, climax: 1, volume: 1, actualized: true }
    ]
    const s = summarizeProjectWords(r, [])
    expect(s.chapters[0].title).toBe('风起云涌')
  })

  it('uses fallback title when rhythm title empty', () => {
    const r: RhythmEntry[] = [
      { chapter: 5, title: '', emotion: 5, climax: 1, volume: 1, actualized: false }
    ]
    const s = summarizeProjectWords(r, [])
    expect(s.chapters[0].title).toBe('第5章')
  })

  it('does not mutate input arrays (immutability)', () => {
    const r = [...rhythm]
    const p = [{ chapterNumber: 1, wordCount: 100 }]
    const rSnapshot = JSON.stringify(r)
    const pSnapshot = JSON.stringify(p)
    summarizeProjectWords(r, p)
    expect(JSON.stringify(r)).toBe(rSnapshot)
    expect(JSON.stringify(p)).toBe(pSnapshot)
  })
})

describe('formatProgress', () => {
  it('≥10% → 取整', () => {
    expect(formatProgress(0.1)).toBe('10%')
    expect(formatProgress(0.5)).toBe('50%')
    expect(formatProgress(1.0)).toBe('100%')
  })

  it('<10% → 一位小数', () => {
    expect(formatProgress(0.05)).toBe('5.0%')
    expect(formatProgress(0.001)).toBe('0.1%')
  })
})

describe('P19-E 集成: 用户场景', () => {
  it('长篇小说: 20 章 5 万字', () => {
    const r: RhythmEntry[] = Array.from({ length: 20 }, (_, i) => ({
      chapter: i + 1,
      title: `第${i + 1}章`,
      emotion: 5 + (i % 4),
      climax: i % 4 === 3 ? 3 : 1,
      volume: 1,
      actualized: false
    }))
    const progress = Array.from({ length: 20 }, (_, i) => ({
      chapterNumber: i + 1,
      wordCount: i < 10 ? 2500 : 0 // 前 10 章写完，后 10 章未写
    }))
    const s = summarizeProjectWords(r, progress)
    expect(s.totalWords).toBe(25000)
    expect(s.chapters).toHaveLength(20)
    expect(s.byStatus.finished).toBe(10)
    expect(s.byStatus.unknown).toBe(10)
    // progress = 25000 / 50000 = 0.5
    expect(s.progress).toBe(0.5)
  })
})

// 防止 ChapterStatus unused 警告
const _STATUS: ChapterStatus | undefined = undefined
void _STATUS
