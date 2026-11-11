import { formatChapterProse, joinContinuation } from '../../shared/format-chapter-prose'
import { parseForeshadowReceipt } from '../../shared/parsers'
import type { ChapterStreamResult } from '../../shared/types'
import { isEarlyAgentNarration } from '../../main/data/agent-meta-detect'

/** A completed draft awaiting review must be repaired, not extended again. */
export function shouldRepairChapterOnRetry(result: ChapterStreamResult, retained: string): boolean {
  return !result.ok && !!retained.trim() && (!!result.retainedContent?.trim() ||
    /LONGFORM_CONFLICT|LONGFORM_REVIEW_INCOMPLETE|CHAPTER_REPAIR_BUDGET/.test(result.error ?? ''))
}

/** 外层检查错误优先，不能被内部 LLM_TIMEOUT 吞成「生成超时」。 */
export function chapterReviewFailureMessage(error: string): string | undefined {
  if (error.includes('LONGFORM_REVIEW_INCOMPLETE')) {
    if (error.includes('CODEX_MODEL_CAPACITY')) return '长篇一致性检查尚未完成，Codex 模型当前繁忙。请稍后补检或更换核对模型。'
    return error.includes('LLM_TIMEOUT')
      ? '长篇一致性检查超时，尚未完成长期记忆、人物知情与主线核对。'
      : '长篇一致性检查未完成：' + error.split('LONGFORM_REVIEW_INCOMPLETE:').pop()?.trim()
  }
  if (error.includes('LONGFORM_CONFLICT')) return error
  return undefined
}

/** 仅使用后端确认完整的重写稿，不能用流式半稿覆盖旧稿。 */
export function failedChapterRewriteDraft(initial: string, result: ChapterStreamResult): string {
  return !result.ok && result.retainedContent?.trim()
    ? formatChapterProse(result.retainedContent) : initial
}

/** 失败回包中的整章稿优先于流式原稿，不能再次拼接前缀或回滚成空稿。 */
export function failedChapterContinuationDraft(initial: string, preview: string, result: ChapterStreamResult): string {
  return !result.ok && result.retainedContent?.trim()
    ? result.retainedContent
    : interruptedChapterDraft(initial, preview, result.error ?? '')
}

/** 中断稿仅保留小说预览；流程旁白和其他错误仍回滚，且不触发写后记忆。 */
export function interruptedChapterDraft(initial: string, preview: string, error: string): string {
  if (!/LLM_TIMEOUT|LLM_ABORTED|LLM_OUTPUT_TRUNCATED|CODEX_MODEL_CAPACITY|LONGFORM_|CHAPTER_REPAIR_BUDGET/.test(error) || isEarlyAgentNarration(preview)) return initial
  const prose = parseForeshadowReceipt(preview).stripped
  return prose.trim() ? joinContinuation(initial, formatChapterProse(prose)) : initial
}

export function interruptedChapterRetryMessage(error: string, hasRetainedProse: boolean): string | undefined {
  const reviewError = chapterReviewFailureMessage(error)
  if (reviewError) return reviewError + (hasRetainedProse ? ' 已生成的正文已保留，待核对通过后再同步记忆。' : '')
  if (error.includes('CODEX_MODEL_CAPACITY')) {
    return 'Codex 模型当前繁忙。' + (hasRetainedProse ? '已保留本次收到的正文。' : '原有草稿已保留。') + '可以稍后重试，或更换本章模型后再续写。'
  }
  if (error.includes('CODEX_FIRST_TOKEN_TIMEOUT')) {
    return '等待 Codex 返回正文首字超时，原有草稿已保留。可以重试，或更换本章模型后再续写。'
  }
  if (/LLM_OUTPUT_TRUNCATED/.test(error)) {
    return hasRetainedProse
      ? '模型输出中断，已生成的正文已保留。重试将从当前草稿继续写。'
      : '模型输出中断，未保留新的正文。原有草稿已保留，可以重试。'
  }
  if (/LLM_TIMEOUT/.test(error)) {
    return hasRetainedProse
      ? '生成超时，已有草稿已保留。重试将从当前草稿继续写。'
      : '生成超时，未保留新的正文。原有草稿已保留，可以重试。'
  }
  return undefined
}

/** 补写整章是权威稿，不能再次拼上已有正文；失败稿暂停自动记忆同步。 */
export function finalizeChapterContinuation(initial: string, preview: string, result: ChapterStreamResult): {
  content: string
  canSyncMemory: boolean
} {
  const delta = parseForeshadowReceipt(result.content ?? preview).stripped
  return {
    content: result.fullContent ?? joinContinuation(initial, formatChapterProse(delta)),
    canSyncMemory: result.foreshadowRepair?.status !== 'failed'
  }
}

/** A saved receipt only applies to the exact final body and chapter, never to a preview or failed operation. */
export function savedChapterContinuation(result: ChapterStreamResult, content: string, chapter: number) {
  return result.ok && result.saved?.content === content && result.saved.meta.chapterNumber === chapter ? result.saved : undefined
}

/** 无论最终稿是否等于生成前正文，都要覆盖流式预览。 */
export function finalizeChapterRewrite(content: string, commit: (text: string) => void): string {
  const formatted = formatChapterProse(content)
  commit(formatted)
  return formatted
}
