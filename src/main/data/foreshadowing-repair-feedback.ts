import { ChapterStageCache, chapterDependencyHash } from './chapter-stage-cache'
import type { ForeshadowingRejection, ForeshadowingRepairFeedback } from './foreshadowing-repair'
import { isReviewBookkeepingFile } from './review-retry-feedback'

/** Bind rejected evidence to the original draft and requirements, across restarts. */
export async function createForeshadowingRepairFeedback(
  dir: string, chapter: number, context: unknown
): Promise<ForeshadowingRepairFeedback> {
  const fingerprint = () => chapterDependencyHash(dir, ['foreshadowing-rejection-v1', context], isReviewBookkeepingFile)
  const key = await fingerprint()
  const cache = new ChapterStageCache(dir, chapter, fingerprint)
  return {
    read: () => cache.read<ForeshadowingRejection[]>('foreshadowing-rejections', value =>
      Array.isArray(value) && value.length <= 8 && value.every(item => item &&
        typeof item.candidateHash === 'string' && /^[a-f0-9]{64}$/.test(item.candidateHash) &&
        Array.isArray(item.issues) && item.issues.length > 0 && item.issues.every(issue => issue &&
          typeof issue.message === 'string' && !!issue.message.trim() &&
          typeof issue.evidence === 'string' && !!issue.evidence.trim()))),
    write: async value => { if (key) await cache.rememberIfUnchanged('foreshadowing-rejections', key, value) }
  }
}
