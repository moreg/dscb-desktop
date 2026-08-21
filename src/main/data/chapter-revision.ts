import { createHash } from 'node:crypto'

export const CHAPTER_REVISION_CONFLICT = 'CHAPTER_REVISION_CONFLICT'

export class ChapterRevisionConflictError extends Error {
  readonly code = CHAPTER_REVISION_CONFLICT

  constructor() {
    super(CHAPTER_REVISION_CONFLICT)
    this.name = 'ChapterRevisionConflictError'
  }
}

export function contentRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function isChapterRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ChapterRevisionConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === CHAPTER_REVISION_CONFLICT)
  )
}
