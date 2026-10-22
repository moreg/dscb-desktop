/** 仅在完整重写稿生成后使用；待复核稿不能视为审核通过。 */
export class ChapterRewriteReviewError extends Error {
  constructor(readonly retainedContent: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ChapterRewriteReviewError'
  }
}
