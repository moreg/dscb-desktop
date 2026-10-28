import type { ChapterStatus } from './types'

/** reviewed remains readable for old projects; it is now part of 正文. */
export function normalizeChapterStatus(status: ChapterStatus): ChapterStatus {
  return status === 'reviewed' ? 'draft' : status
}

export const CHAPTER_STATUS_OPTIONS: readonly ChapterStatus[] = ['outline', 'draft', 'published']
export const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  outline: '待写', draft: '正文', reviewed: '正文', published: '定稿'
}
export const CHAPTER_STATUS_CLASSES: Record<ChapterStatus, string> = {
  outline: 'status-outline', draft: 'status-draft', reviewed: 'status-draft', published: 'status-published'
}
