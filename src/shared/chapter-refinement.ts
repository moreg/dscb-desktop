export const REFINEMENT_GOALS = {
  expression: { label: '表达更自然', description: '减少重复解释和生硬表达，保留原有语气与细节。' },
  dialogue: { label: '对白更有张力', description: '改善接话、潜台词与人物声音，保留说话人的意图和结果。' },
  pacing: { label: '节奏更紧凑', description: '压缩空转，改善段落推进，不删关键事件或伏笔。' },
  scene: { label: '场景更清晰', description: '理顺动作、空间与情绪变化，先确认修改方案。' },
  custom: { label: '按我的要求', description: '写下具体改进目标；精修仍保留剧情事实和结局。' }
} as const
export type RefinementGoal = keyof typeof REFINEMENT_GOALS
export interface RefinementInput {
  projectId: string
  chapterNumber: number
  content: string
  goal: RefinementGoal
  instruction: string
  selection?: { start: number; end: number }
  plan?: string
  styleProfileId?: string | null
}
export interface RefinementVerdict {
  passed: boolean
  assessment: string
  factsPreserved: boolean
  goalMet: boolean
  evidence: Array<{ before: string; after: string; reason: string }>
  issues: string[]
}
export interface RefinementCandidate {
  version: 1
  id: string
  input: RefinementInput
  baseRevision: string
  contextHash: string
  candidate: string
  changes: string[]
  verdict?: RefinementVerdict
  attempts: number
  status: 'generating' | 'verifying' | 'ready' | 'rejected' | 'cancelled' | 'failed' | 'applying' | 'accepted' | 'undone'
  error?: string
  applyingUndo?: boolean
  /** 已单条采用后的当前正文；未单条采用时为空。 */
  adoptedContent?: string
  /** adoptedContent 的修订哈希，供后续采用核对磁盘。 */
  adoptedRevision?: string
  /** 正在写入的目标正文，供崩溃恢复。 */
  applyingContent?: string
  updatedAt: string
}
export type RefinementStage = 'planning' | 'generating' | 'verifying' | 'repairing'
export interface RefinementResult { ok: boolean; candidate?: RefinementCandidate; plan?: string; error?: string }
export interface RefinementCommit { content: string; warning?: string; candidate?: RefinementCandidate }
