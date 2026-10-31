/** 已有完整正文，但后续处理失败；待复核稿不能视为审核通过。 */
export class ChapterWriteReviewError extends Error {
  constructor(readonly retainedContent: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ChapterWriteReviewError'
  }
}

export class ChapterRewriteReviewError extends ChapterWriteReviewError {
  constructor(retainedContent: string, cause: unknown) {
    super(retainedContent, cause)
    this.name = 'ChapterRewriteReviewError'
  }
}

/** A verified, broader repair is a proposal; it must never be saved implicitly. */
export class ChapterRepairReviewRequiredError extends Error {
  constructor(readonly original: string, readonly candidate: string, readonly scope: 'scene' | 'structure') {
    super('本章需要较大范围修复，候选稿已通过自动核对，请对照原稿后决定是否采用。')
    this.name = 'ChapterRepairReviewRequiredError'
  }
}
