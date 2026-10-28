import type { ChapterFlowResult } from './types'

export type BatchQuality = 'passed' | 'expression_pending' | 'review_pending' | 'unverified'
export const BATCH_QUALITY_LABELS: Record<BatchQuality, string> = {
  passed: '自动验收通过', expression_pending: '表达待修订', review_pending: '检查仍有问题', unverified: '验收未完成'
}

/** Execution completion is not a manuscript quality verdict. */
export function batchQuality(result: ChapterFlowResult): BatchQuality {
  const polish = result.autoDeslop
  if (polish?.status === 'failed' || polish?.status === 'review_required' || polish?.dialogueQuality?.passed === false) return 'expression_pending'
  if (!polish || !result.memoryApply || result.chapterSummary?.stale !== false || !result.selfCheck || result.outlineDiff.checked !== true || result.outlineDiff.hasOutline !== true) return 'unverified'
  if (result.audit.counts.error > 0 || !result.selfCheck.ok || result.outlineDiff.passed === false ||
      result.deepReview?.some(item => item.severity === 'error' || item.ruleId?.startsWith('review_incomplete:')) ||
      result.memory.parseError || result.memoryApply?.errors.length || result.memoryApply?.superseded ||
      result.memoryApply?.reviewRequired?.length || result.settingsApply?.errors.length) return 'review_pending'
  return 'passed'
}
