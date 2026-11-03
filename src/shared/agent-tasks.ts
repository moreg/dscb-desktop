import type { FeatureCategory } from './types'

export type AgentRole = 'writer' | 'planner' | 'reviewer' | 'extractor' | 'editor' | 'assistant'
export type AgentMutation = 'none' | 'prose_candidate' | 'plan_candidate' | 'memory_candidate'
export interface AgentTask {
  role: AgentRole
  category: FeatureCategory
  mutation: AgentMutation
  repairBudget?: 'content' | 'expression'
  acceptance: 'evidence' | 'facts_and_expression' | 'author' | 'structured'
}
const task = (role: AgentRole, category: FeatureCategory, mutation: AgentMutation = 'none',
  acceptance: AgentTask['acceptance'] = 'structured', repairBudget?: AgentTask['repairBudget']): AgentTask =>
  ({ role, category, mutation, acceptance, ...(repairBudget ? { repairBudget } : {}) })

/** The model only proposes changes. Repository writes and adoption belong to the workflow. */
export const AGENT_TASKS: Readonly<Record<string, AgentTask>> = {
  chapter: task('writer', 'chapter', 'prose_candidate', 'author'),
  'chapter-adjust': task('writer', 'chapter', 'prose_candidate', 'author'),
  'chapter-adjust-plan': task('planner', 'chapter', 'plan_candidate', 'author'),
  continuityRepair: task('editor', 'chapter', 'prose_candidate', 'evidence', 'content'),
  outlineLocalRepair: task('editor', 'chapter', 'prose_candidate', 'evidence', 'content'),
  'char-position-fix': task('editor', 'chapter', 'prose_candidate', 'evidence', 'content'),
  batchForeshadowRepair: task('writer', 'chapter', 'prose_candidate', 'evidence', 'content'),
  chapterForeshadowRepair: task('writer', 'chapter', 'prose_candidate', 'evidence', 'content'),
  'chapter-scene-repair': task('editor', 'chapter', 'prose_candidate', 'facts_and_expression', 'expression'),
  'chapter-refine': task('editor', 'refine', 'prose_candidate', 'facts_and_expression'),
  'chapter-refine-plan': task('planner', 'refine', 'plan_candidate', 'author'),
  'chapter-refine-repair': task('editor', 'refine', 'prose_candidate', 'facts_and_expression', 'expression'),
  'chapter-refine-verify': task('reviewer', 'refineReview', 'none', 'evidence'),
  review: task('reviewer', 'review', 'none', 'evidence'),
  deepReview: task('reviewer', 'review', 'none', 'evidence'),
  batchDeepReview: task('reviewer', 'review', 'none', 'evidence'),
  continuityRepairPlan: task('planner', 'review', 'plan_candidate'),
  continuityRepairVerify: task('reviewer', 'review', 'none', 'evidence'),
  outlineLocalRepairVerify: task('reviewer', 'review', 'none', 'evidence'),
  outlineSyncDecision: task('reviewer', 'review', 'none', 'evidence'),
  outlineSyncVerify: task('reviewer', 'review', 'none', 'evidence'),
  outlineConflictDecision: task('reviewer', 'review', 'plan_candidate', 'evidence'),
  outlineConflictVerify: task('reviewer', 'review', 'none', 'evidence'),
  foreshadowPlantEvidence: task('extractor', 'review', 'memory_candidate', 'evidence'),
  foreshadowRepairVerify: task('reviewer', 'review', 'none', 'evidence'),
  foreshadowRepairReview: task('reviewer', 'review', 'none', 'evidence'),
  'adjust-plan-compliance': task('reviewer', 'review', 'none', 'evidence'),
  longformGuard: task('reviewer', 'auxiliary', 'none', 'evidence'),
  outlineCheck: task('reviewer', 'auxiliary', 'none', 'evidence'),
  batchOutline: task('reviewer', 'auxiliary', 'none', 'evidence'),
  proseOutlineRewrite: task('planner', 'auxiliary', 'plan_candidate', 'evidence'),
  downstreamOutlineSync: task('planner', 'auxiliary', 'plan_candidate', 'evidence'),
  memoryEvidenceRepair: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  endingState: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  chapterSummary: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  memoryExtract: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  autoMemorySync: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  batchMemory: task('extractor', 'auxiliary', 'memory_candidate', 'evidence'),
  humanize: task('editor', 'humanize', 'prose_candidate', 'facts_and_expression'),
  deslop: task('editor', 'humanize', 'prose_candidate', 'facts_and_expression'),
  'deslop:verify': task('reviewer', 'humanize', 'none', 'evidence'),
  'deslop:dialogue-review': task('reviewer', 'humanize', 'none', 'evidence'),
  'deslop:scene-dialogue-review': task('reviewer', 'review', 'none', 'evidence'),
  'deslop:narrative-flow': task('reviewer', 'humanize', 'none', 'evidence'),
  'deslop:judgeStructure': task('reviewer', 'humanize', 'none', 'evidence'),
  'deslop:repair-plan': task('extractor', 'humanize', 'memory_candidate', 'evidence'),
  ...Object.fromEntries(['scene-repair', 'repair', 'dialogue-repair', 'narrative-repair', 'cleanup'].map(name =>
    [`deslop:${name}`, task('editor', 'humanize', 'prose_candidate', 'facts_and_expression', 'expression')])),
  opening: task('planner', 'opening', 'plan_candidate', 'author'),
  'outline-generate': task('planner', 'opening', 'plan_candidate', 'author'),
  cast: task('extractor', 'opening', 'memory_candidate', 'author'),
  relationship: task('extractor', 'opening', 'memory_candidate', 'author'),
  styleExtract: task('extractor', 'opening', 'memory_candidate', 'author'),
  'chapter-name': task('assistant', 'opening', 'plan_candidate', 'author'),
  ...Object.fromEntries(['rhythmEval', 'figureGen', 'batchRhythm', 'batchFigure', 'teardown', 'scan',
    'fanqieChart', 'coverPrompt', 'book-test'].map(name => [name, task('assistant', 'auxiliary', 'none', 'author')])),
  coverLearn: task('extractor', 'library', 'memory_candidate', 'author'),
  ask: task('assistant', 'ask', 'none', 'author')
}

export function agentTaskOf(feature?: string): AgentTask | undefined {
  if (!feature) return undefined
  const parts = feature.split(':')
  return AGENT_TASKS[feature] ?? AGENT_TASKS[parts.slice(0, 2).join(':')] ?? AGENT_TASKS[parts[0]]
}
export function featureCategoryOf(feature?: string): FeatureCategory | undefined {
  return agentTaskOf(feature)?.category
}
