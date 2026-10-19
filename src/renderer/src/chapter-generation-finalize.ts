import { formatChapterProse, joinContinuation } from '../../shared/format-chapter-prose'
import { parseForeshadowReceipt } from '../../shared/parsers'
import type { ChapterStreamResult } from '../../shared/types'
import { isEarlyAgentNarration } from '../../main/data/agent-meta-detect'

/** 中断稿仅保留小说预览；流程旁白和其他错误仍回滚，且不触发写后记忆。 */
export function interruptedChapterDraft(initial: string, preview: string, error: string): string {
  if (!/LLM_TIMEOUT|LLM_ABORTED/.test(error) || isEarlyAgentNarration(preview)) return initial
  const prose = parseForeshadowReceipt(preview).stripped
  return prose.trim() ? formatChapterProse(joinContinuation(initial, prose)) : initial
}

/** 补写整章是权威稿，不能再次拼上已有正文；失败稿暂停自动记忆同步。 */
export function finalizeChapterContinuation(initial: string, preview: string, result: ChapterStreamResult): {
  content: string
  canSyncMemory: boolean
} {
  const delta = parseForeshadowReceipt(result.content ?? preview).stripped
  return {
    content: formatChapterProse(result.fullContent ?? joinContinuation(initial, delta)),
    canSyncMemory: result.foreshadowRepair?.status !== 'failed'
  }
}

/** 无论最终稿是否等于生成前正文，都要覆盖流式预览。 */
export function finalizeChapterRewrite(content: string, commit: (text: string) => void): string {
  const formatted = formatChapterProse(content)
  commit(formatted)
  return formatted
}
