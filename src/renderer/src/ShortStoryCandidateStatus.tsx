import type { ReactElement } from 'react'
import { shortStoryWordCount } from '../../shared/short-story'
import type { ShortStoryCandidate } from './short-story-candidate'

interface Props {
  candidate: ShortStoryCandidate
  retryDisabled: boolean
  preparing?: boolean
  preparationError?: string
  retryBlockedReason?: string
  onRetry: () => void
}

export function friendlyShortStoryGenerationError(raw: string): string {
  if (!raw.trim()) return '未记录具体失败原因，请重试。'
  if (/未知中短篇写作任务|IPC_INPUT_INVALID[\s\S]*\btask\b[\s\S]*Invalid option/i.test(raw)) {
    return '当前运行版本不支持此任务，请关闭并重新打开应用后重试。'
  }
  const messages: Record<string, string> = {
    LLM_NOT_CONFIGURED: '尚未配置模型服务，请到设置中配置后重试。',
    LLM_AUTH_FAILED: '模型服务认证失败，请到设置中检查 API Key 后重试。',
    LLM_RATE_LIMIT: '请求过于频繁，请稍后重试。',
    LLM_TIMEOUT: '模型响应超时，请重试。',
    LLM_OUTPUT_TRUNCATED: '模型输出不完整，请重新生成。',
    LLM_ABORTED: '生成已停止，原稿仍保留。',
    LLM_REQUEST_FAILED: '模型请求失败，请检查网络连接后重试。'
  }
  for (const [code, message] of Object.entries(messages)) {
    if (raw.includes(code)) return message
  }
  return raw
}

function retryLabel(candidate: ShortStoryCandidate): string {
  if (candidate.task === 'revise') return `重新修订第 ${candidate.sectionNumber} 节`
  if (candidate.task === 'section') return `重新生成第 ${candidate.sectionNumber} 节`
  return candidate.task === 'review' ? '重新检查全文' : '重新生成大纲'
}

export default function ShortStoryCandidateStatus({ candidate, retryDisabled, preparing = false, preparationError, retryBlockedReason, onRetry }: Props): ReactElement {
  const action = candidate.task === 'revise' ? '修订' : '生成'
  const content = candidate.task === 'revise' || candidate.task === 'section' ? '正文' : '内容'
  const words = shortStoryWordCount(candidate.text)
  const hasText = !!candidate.text.trim()
  const received = `已收到 ${words.toLocaleString()} 字`
  let title: string
  let detail: string
  if (preparing) {
    title = '正在保存作品，准备生成…'
    detail = '保存完成后会立即发起请求，原稿仍保留。'
  } else if (candidate.status === 'generating') {
    title = `正在${action} · ${hasText ? `${received}，仍在生成` : `等待模型返回${content}`}`
    detail = '当前任务正在进行，原稿仍保留。'
  } else if (candidate.status === 'completed') {
    title = `${action}完成，待采用`
    detail = '候选可编辑，检查并采用后请保存作品。'
  } else if (candidate.status === 'failed') {
    title = `${action}失败`
    detail = hasText
      ? `${received}，当前没有生成任务在运行。原稿与收到的文本仍保留。`
      : `本次未收到${content}，当前没有生成任务在运行。原稿仍保留。`
  } else {
    title = `已停止${action}`
    detail = hasText
      ? `${received}，当前没有生成任务在运行。原稿与收到的文本仍保留。`
      : `本次未收到${content}，当前没有生成任务在运行。原稿仍保留。`
  }
  const canRetry = !preparing && (candidate.status === 'failed' || candidate.status === 'stopped')
  const error = preparing || preparationError ? '' : candidate.status === 'failed' ? friendlyShortStoryGenerationError(candidate.error ?? '')
    : candidate.status === 'stopped' && candidate.error ? friendlyShortStoryGenerationError(candidate.error) : ''

  return <div className="ss-candidate-status">
    <p className={`ss-candidate-state ss-candidate-state-${preparing ? 'generating' : candidate.status}`} role="status" aria-live="polite">{title}</p>
    <p className="muted">{detail}</p>
    {error && <p className="ss-error ss-notice" role="alert">{error}</p>}
    {!preparing && preparationError && <p className="ss-error ss-notice" role="alert">{preparationError}</p>}
    {canRetry && <button type="button" className="btn btn-sm" disabled={retryDisabled} onClick={onRetry}>{retryLabel(candidate)}</button>}
    {canRetry && retryBlockedReason && <p className="muted">{retryBlockedReason}</p>}
  </div>
}
