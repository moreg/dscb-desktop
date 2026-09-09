import type { ChapterMeta, Foreshadowing, ForeshadowingStatus, UpdateForeshadowingInput } from '../../shared/types'
import { isOpenForeshadowing } from '../../shared/foreshadowing-state'
export { isOpenForeshadowing } from '../../shared/foreshadowing-state'

export const FORESHADOWING_STATUS_LABELS: Record<ForeshadowingStatus, string> = {
  pending: '待埋设', planted: '已埋设', reinforced: '已强化', partial: '部分回收',
  collected: '已回收', deferred: '暂缓', missed: '遗漏'
}

export type ForeshadowingStageAction = 'plant' | 'collect' | 'reinforce' | 'partial' | 'defer'

export function writtenChapters(chapters: ChapterMeta[]): ChapterMeta[] {
  return chapters.filter((chapter) => Number.isSafeInteger(chapter.chapterNumber) && chapter.chapterNumber > 0 &&
    Number.isFinite(chapter.wordCount) && chapter.wordCount > 0)
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export function latestWrittenChapter(chapters: ChapterMeta[]): number {
  return writtenChapters(chapters).at(-1)?.chapterNumber ?? 0
}

export function isForeshadowingOverdue(foreshadowing: Foreshadowing, progress: number): boolean {
  return isOpenForeshadowing(foreshadowing) && foreshadowing.expectedCollect != null &&
    progress > 0 && foreshadowing.expectedCollect < progress
}

/** Explicit choice only: a planned deadline cannot establish where an event actually happened. */
export function validateForeshadowingEventChapter(
  foreshadowing: Foreshadowing,
  action: ForeshadowingStageAction,
  selected: string,
  chapters: ChapterMeta[]
): number {
  if (!/^\d+$/.test(selected.trim())) throw new Error(action === 'defer' ? '请选择暂缓后的计划章节' : '请选择实际发生章节')
  const chapter = Number(selected)
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('章节号必须是正整数')
  if (action !== 'defer' && !writtenChapters(chapters).some((item) => item.chapterNumber === chapter)) throw new Error('实际发生章节需要已有正文')
  if (action !== 'plant' && action !== 'defer' && !foreshadowing.plantChapter) throw new Error('请先记录实际埋设章节')
  if (foreshadowing.plantChapter && chapter < foreshadowing.plantChapter) throw new Error('章节不能早于实际埋设章节')
  if (action === 'defer' && chapter <= latestWrittenChapter(chapters)) throw new Error('暂缓后的计划章节应晚于当前写作进度')
  return chapter
}

export function buildForeshadowingStagePatch(
  foreshadowing: Foreshadowing,
  action: 'reinforce' | 'partial' | 'defer',
  chapter: number
): UpdateForeshadowingInput {
  if (action === 'defer') return { status: 'deferred', expectedCollect: chapter }
  const key = action === 'reinforce' ? 'reinforcementChapters' : 'partialCollectChapters'
  return { status: action === 'reinforce' ? 'reinforced' : 'partial',
    [key]: [...new Set([...(foreshadowing[key] ?? []), chapter])].sort((a, b) => a - b) }
}

export function buildForeshadowingEditPatch(content: string, expectedCollect: string, note: string): UpdateForeshadowingInput {
  const raw = expectedCollect.trim()
  if (raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) throw new Error('预期回收章节必须是正整数')
  return { content: content.trim(), expectedCollect: raw ? Number(raw) : null, note: note.trim() || null }
}
