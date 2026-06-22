/**
 * 字数预估（P19-E）。
 *
 * 用途：项目进度总览 → 总字数 + 状态分布。
 * 数据源：chapterProgressMd（章节进度笔记）+ 节奏图谱 rhythmData（章节标题 + wordCount）。
 *
 * 不读 ProseRepo 正文（避免大文件 IO），用元数据快速汇总。
 */

import type { RhythmEntry } from '../../shared/types'

export type ChapterStatus = 'unknown' | 'outline' | 'drafted' | 'finished'

export interface ChapterWordSummary {
  chapterNumber: number
  title: string
  emotion: number
  wordCount: number
  status: ChapterStatus
}

export interface ProjectWordSummary {
  chapters: ChapterWordSummary[]
  totalWords: number
  /** 按 wordCount 估算的预计总字数（如果大纲齐全） */
  estimatedTotal: number
  /** 完成度 0-1 */
  progress: number
  byStatus: Record<ChapterStatus, number>
}

/**
 * 从 rhythmData + 章节进度笔记算字数汇总。
 * 纯函数：便于单测。
 *
 * 状态判定（基于 wordCount 阈值）：
 * - 0 → 'unknown'（节奏图谱有标题但无字）
 * - 1-499 → 'outline'（刚开始写）
 * - 500-1999 → 'drafted'（有初稿）
 * - ≥2000 → 'finished'（完整章节）
 */
export function summarizeProjectWords(
  rhythm: readonly RhythmEntry[],
  progressNotes: readonly { chapterNumber: number; wordCount: number }[] = []
): ProjectWordSummary {
  // 用 Map 合并：rhythm 提供标题 + 情绪，progress 提供字数（最准确）
  const progressMap = new Map(progressNotes.map((p) => [p.chapterNumber, p.wordCount]))
  const chapters: ChapterWordSummary[] = rhythm.map((r) => {
    const wc = progressMap.get(r.chapter) ?? 0
    return {
      chapterNumber: r.chapter,
      title: r.title || `第${r.chapter}章`,
      emotion: r.emotion ?? 5,
      wordCount: wc,
      status: statusOf(wc)
    }
  })
  const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0)
  // 预计总字数：基于章节数 × 平均目标 2500 字（可在 settings 配）
  const TARGET_PER_CHAPTER = 2500
  const estimatedTotal = Math.max(totalWords, chapters.length * TARGET_PER_CHAPTER)
  const progress = estimatedTotal === 0 ? 0 : Math.min(1, totalWords / estimatedTotal)
  const byStatus: Record<ChapterStatus, number> = {
    unknown: 0,
    outline: 0,
    drafted: 0,
    finished: 0
  }
  for (const c of chapters) byStatus[c.status]++
  return { chapters, totalWords, estimatedTotal, progress, byStatus }
}

export function statusOf(wordCount: number): ChapterStatus {
  if (wordCount <= 0) return 'unknown'
  if (wordCount < 500) return 'outline'
  if (wordCount < 2000) return 'drafted'
  return 'finished'
}

/** 格式化进度为 "X%" 或 "X.X%" */
export function formatProgress(progress: number): string {
  const pct = progress * 100
  if (pct >= 10) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}
