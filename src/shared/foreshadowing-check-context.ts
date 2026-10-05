export interface ForeshadowCheckContext {
  partialChapter: boolean
  tempContext?: string
}

export interface ChapterForeshadowContextSnapshot {
  projectId: string
  chapterNumber: number
  content: string
  foreshadowContext?: ForeshadowCheckContext
}

export function normalizeForeshadowCheckContext(raw: unknown): ForeshadowCheckContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.partialChapter !== 'boolean') return undefined
  if (value.tempContext !== undefined && typeof value.tempContext !== 'string') return undefined
  return { partialChapter: value.partialChapter,
    ...(typeof value.tempContext === 'string' ? { tempContext: value.tempContext.slice(0, 10000) } : {}) }
}

/** A retry inherits only the context bound to the same project, chapter and draft. */
export function resolveForeshadowCheckContext(
  source: Pick<ChapterForeshadowContextSnapshot, 'projectId' | 'chapterNumber' | 'content'>,
  ...snapshots: (ChapterForeshadowContextSnapshot | null | undefined)[]
): ForeshadowCheckContext {
  for (const snapshot of snapshots) {
    if (snapshot?.projectId !== source.projectId || snapshot.chapterNumber !== source.chapterNumber || snapshot.content !== source.content) continue
    const context = normalizeForeshadowCheckContext(snapshot.foreshadowContext)
    if (context) return context
  }
  // Legacy tasks have no scope metadata; never silently downgrade a complete check.
  return { partialChapter: false }
}
