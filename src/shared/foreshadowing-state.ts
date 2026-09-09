import type { Foreshadowing } from './types'

export function isOpenForeshadowing(f: Pick<Foreshadowing, 'status'>): boolean {
  return f.status === 'planted' || f.status === 'reinforced' || f.status === 'partial'
}

/** Reconstruct only events before the chapter being written; planned dates are never evidence. */
export function foreshadowingsBeforeChapter(items: Foreshadowing[], chapter: number): Foreshadowing[] {
  return items.filter((f) => f.plantChapter == null || f.plantChapter <= chapter).map((f): Foreshadowing => {
    const reinforcementChapters = (f.reinforcementChapters ?? []).filter((n) => n < chapter)
    const partialCollectChapters = (f.partialCollectChapters ?? []).filter((n) => n < chapter)
    const base = { ...f, reinforcementChapters, partialCollectChapters }
    if (f.plantChapter != null && f.plantChapter >= chapter) {
      return { ...base, status: 'pending', plantChapter: undefined, actualCollect: undefined }
    }
    if ((f.actualCollect != null && f.actualCollect >= chapter) ||
        f.status === 'reinforced' || f.status === 'partial') {
      const status = partialCollectChapters.length ? 'partial'
        : reinforcementChapters.length ? 'reinforced' : f.plantChapter != null ? 'planted' : 'pending'
      return { ...base, status, actualCollect: undefined }
    }
    // Deferred/missed are current author planning flags, not dated events in the story.
    return base
  })
}
