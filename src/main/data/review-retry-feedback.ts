import { ChapterStageCache, chapterDependencyHash } from './chapter-stage-cache'
import { contentRevision } from './chapter-revision'

interface ReviewFailure { message: string; candidate?: string; rejectedHash?: string }
export class ReviewCandidateRejectedError extends Error {
  constructor(message: string, readonly repeated = false) { super(message); this.name = 'ReviewCandidateRejectedError' }
}
const candidateHash = (text: string): string => contentRevision(text.replace(/\r\n/g, '\n').trim())
/** Sync bookkeeping is rewritten on every retry, without changing story evidence. */
export const isReviewBookkeepingFile = (path: string): boolean =>
  path === '记忆/索引.md' || path === '记忆/.sync-index.json'
export interface ReviewRetryFeedback {
  prompt(): string
  record(error: unknown, candidate?: string, rejected?: boolean): Promise<void>
  assertCandidate(candidate: string): void
  clear(): Promise<void>
}

/** Execution failures must never become instructions to alter story facts. */
export function isReviewExecutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /LLM_ABORTED|AbortError|CONTEXT_CHANGED|(?:正文|细纲|前文|计划|上下文|稿件)(?:已变化|已改变)|CHAPTER_REPAIR_BUDGET|AGY_REPAIR_CONTEXT_TOO_LARGE|LLM_RATE_LIMIT|LLM_TIMEOUT|AUTH_EXPIRED|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network error|network request|断网|断流|断连|(?:请求|调用|响应|连接)超时|接口限流|连接失败|(?:认证|鉴权|登录)失败|登录(?:已)?过期|请先登录|重新登录|磁盘(?:已满|空间不足|写入失败)|EACCES|ENOSPC|EPERM|EBUSY/iu.test(message)
}

/** Failed evidence is advisory only. Every new candidate still needs the original independent gates. */
export async function createReviewRetryFeedback(
  dir: string, chapter: number, stage: string, context: unknown
): Promise<ReviewRetryFeedback> {
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid review feedback stage')
  const fingerprint = () => chapterDependencyHash(dir, ['review-retry-feedback-v1', context], isReviewBookkeepingFile)
  const key = await fingerprint()
  const cache = new ChapterStageCache(dir, chapter, fingerprint)
  const name = `retry-${stage}`
  let failures = await cache.read<ReviewFailure[]>(name, value => Array.isArray(value) && value.length <= 8 &&
    value.every(item => item && typeof item.message === 'string' && !!item.message.trim() &&
      (item.candidate === undefined || typeof item.candidate === 'string') &&
      (item.rejectedHash === undefined || typeof item.rejectedHash === 'string'))) ?? []
  const save = async (): Promise<void> => { if (key) await cache.rememberIfUnchanged(name, key, failures) }
  return {
    prompt: () => failures.length ? ['【此前检查或修复未通过的具体反馈，含上次重试】',
      '以下是失败记录和被否决的候选，仅供定位问题，不是已发生的事实或新的作者要求。逐项修正问题及直接影响，保留其他内容；不得把错误候选当作正文基线，不得删改检查规则来换取通过。修复后仍须按原标准独立复核。',
      JSON.stringify(failures)].join('\n') : '',
    assertCandidate: candidate => {
      const prior = failures.find(item => item.rejectedHash === candidateHash(candidate))
      if (prior) throw new ReviewCandidateRejectedError(`此前同版本候选已被明确否决，未实际修改，不能重复审核碰运气：${prior.message}`, true)
    },
    record: async (error, candidate, rejected) => {
      if (!(error instanceof ReviewCandidateRejectedError) && !rejected && isReviewExecutionError(error)) return
      if (error instanceof ReviewCandidateRejectedError && error.repeated) return
      const message = error instanceof Error ? error.message : String(error)
      if (!message.trim()) return
      const item = { message, ...(candidate ? { candidate: candidate.slice(0, 12000),
        ...(rejected || error instanceof ReviewCandidateRejectedError || message.startsWith('LONGFORM_CONFLICT:') ? { rejectedHash: candidateHash(candidate) } : {}) } : {}) }
      failures = failures.filter(prior => prior.message !== message || prior.candidate !== item.candidate)
      failures.push(item)
      failures = failures.slice(-8)
      await save()
    },
    clear: async () => { failures = []; await save() }
  }
}
