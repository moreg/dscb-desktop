export type DetectionStatus = 'pending' | 'waiting_verification' | 'quota_exhausted' | 'failed' | 'completed'

export type DetectionResultInput = {
  status: 'completed'
  ai: number
  suspected: number
  human: number
  detectedAt: string
  evidence: string
} | {
  status: Exclude<DetectionStatus, 'completed'>
  note: string
}

export interface ChapterDetectionRecord {
  schemaVersion: 1
  id: string
  chapterNumber: number
  attempt: number
  provider: '朱雀'
  source: 'manual'
  scope: 'full_chapter'
  content: string
  revision: string
  policyVersion: string
  createdAt: string
  events: Array<DetectionResultInput & { recordedAt: string }>
}

export interface ChapterDetectionHistory {
  currentRevision: string
  records: ChapterDetectionRecord[]
}

export const DETECTION_STATUS_LABELS: Record<DetectionStatus, string> = {
  pending: '待送检', waiting_verification: '等待验证', quota_exhausted: '额度用尽',
  failed: '检测失败', completed: '已登记结果'
}

/** 按最新一次送检显示，不能挑选较早的零分覆盖较新的非零或未完成检测。 */
export function currentChapterDetection(history: ChapterDetectionHistory, draft: string): string {
  const record = history.records[0]
  if (!record) return '未检测'
  if (record.revision !== history.currentRevision || record.content !== draft) return '正文已变化，需复测'
  const result = record.events.at(-1)
  if (!result || result.status !== 'completed') return DETECTION_STATUS_LABELS[result?.status ?? 'pending']
  return result.ai === 0 && result.suspected === 0
    ? '本版双零（人工登记）'
    : `本版 AI ${result.ai}% · 疑似 ${result.suspected}%（人工登记）`
}
