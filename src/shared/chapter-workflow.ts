import type { ChapterContent, ChapterSummaryView, OutlineDiffReport, MemoryExtraction, MemoryApplyResult,
  SettingsApplyResult, ChapterSelfCheckReport, AuditViolation, RhythmEvaluation, FigureDraft } from './types'

export type ChapterSyncStepId = 'index' | 'outline' | 'memory' | 'summary' | 'rhythm' | 'figure'
export interface ChapterSyncStep {
  id: ChapterSyncStepId
  status: 'pending' | 'running' | 'preview' | 'handled' | 'written' | 'reused' | 'failed'
  elapsedMs: number
  error?: string
}
export interface ChapterSyncOptions {
  requestId: string
  force?: boolean
  skipMemory?: boolean
  extras?: boolean
}
export interface ChapterSyncResult {
  saved?: ChapterContent
  outline?: OutlineDiffReport
  summary?: ChapterSummaryView
  memory?: { extraction: MemoryExtraction; memory: MemoryApplyResult; settings: SettingsApplyResult;
    selfCheck?: ChapterSelfCheckReport | null; deepReview?: AuditViolation[] }
  rhythm?: RhythmEvaluation
  figure?: FigureDraft
  steps: ChapterSyncStep[]
  error?: string
}
