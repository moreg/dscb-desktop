import { z } from 'zod'
import type { FanqieChartBook, FanqieChartIdea } from '../../../shared/fanqie-chart'
import { CHART_FUSION_RULES, FUSION_REVIEW_PROMPT } from './fusion-rules'
import { prepareBooks } from './analysis'

export const EXPANSION_FIELDS = {
  world_setting: 'worldSetting', power_system: 'powerSystem', supporting_characters: 'supportingCharacters',
  core_conflict: 'coreConflict', target_audience: 'targetAudience', pacing_plan: 'pacingPlan'
} as const
const expansionKeys = Object.keys(EXPANSION_FIELDS)
const evidenceKeys = [...expansionKeys, 'golden_finger', 'opening_hook', 'core_concept', 'protagonist']
const stages = ['opening', 'middle', 'late'] as const
const routeKinds = ['communication', 'manual_acquisition', 'existing_team'] as const
const dependencyKinds = ['weak_source_dependency', 'dependency_bypass', 'dependency_missing', 'action_loop_gap']
const detailed = z.string().trim().min(8)
const evidence = z.object({ field: z.string(), quote: z.string() })
const issue = evidence.extend({ kind: z.enum(['weak_source_dependency', 'dependency_bypass', 'dependency_missing', 'mechanism_repeat', 'opening_conflict_repeat', 'action_loop_gap', 'chapter_progression_repeat']), reason: z.string().trim().min(1) })
const route = evidence.extend({ kind: z.enum(routeKinds), route: detailed, reason: detailed,
  outcome: z.enum(['blocked', 'viable', 'unproven', 'not_applicable']),
  payoff_match: z.enum(['equivalent', 'non_equivalent', 'unproven']), payoff_comparison: detailed })
const combination = route.omit({ kind: true }).extend({ preserved_resources: detailed, time_window: detailed })
const execution = evidence.extend({ carrier: detailed, operating_scope: detailed, retained_conditions: detailed,
  evidence_sufficient: z.boolean(), reason: detailed })
const deletion = evidence.extend({ core_operation: detailed, retained_triggers: detailed,
  core_operation_removed: z.boolean(), retained_means_preserved: z.boolean(), activation_conditions_preserved: z.boolean(), reason: detailed,
  dependency_boundary: z.enum(['resolved', 'ambiguous']), input_dependency: detailed, branch_analysis: detailed })
const action = evidence.extend({ stage: z.enum(stages), known_before: detailed, verification_route: detailed,
  activation_sequence: detailed, loop_closed: z.boolean(), reason: detailed })
const stageCheck = evidence.extend({ stage: z.enum(stages), fresh_contribution: detailed, without_source_route: detailed,
  required_now: z.boolean(), required_output: detailed, route_checks: z.array(route).length(3),
  execution_audit: execution, combination_check: combination })
const goal = evidence.extend({ stage: z.enum(stages), required_output: detailed, distinctive_payoff: detailed,
  equivalent_success: detailed, item_or_channel: detailed, necessity_basis: detailed, boundary_valid: z.boolean(), material_substitution_test: detailed,
  new_requirement: detailed, old_stock_test: detailed, need_established: z.boolean() })
const sourceCheck = evidence.extend({ book_id: z.string(), reason: z.string().trim().min(1),
  contribution_type: z.enum(['mechanism', 'relationship_structure', 'attitude_only']),
  removal_effect: detailed, remaining_route: detailed, removed_part: detailed, deletion_audit: deletion,
  retained_means: z.array(evidence.extend({ reason: detailed })).min(1), stage_checks: z.array(stageCheck).length(3) })
const reviewSchema = z.object({ reviews: z.array(z.object({ index: z.number().int().min(1), passed: z.boolean(),
  stage_goals: z.array(goal).length(3), action_checks: z.array(action).length(3), source_checks: z.array(sourceCheck), issues: z.array(issue) })),
opening_comparisons: z.array(z.object({ left_index: z.number().int(), right_index: z.number().int(),
  same_conflict: z.boolean(), left_quote: z.string().min(1), right_quote: z.string().min(1), reason: detailed })),
chapter_comparisons: z.array(z.object({ left_index: z.number().int(), right_index: z.number().int(), same_progression: z.boolean(), reason: detailed,
  left_chain: z.array(z.object({ chapter: z.number().int().min(1).max(3), quote: z.string().min(1), change: detailed })).length(3),
  right_chain: z.array(z.object({ chapter: z.number().int().min(1).max(3), quote: z.string().min(1), change: detailed })).length(3) })) })

function containsQuote(value: unknown, quote: string): boolean {
  if (typeof value === 'string') return value.includes(quote)
  if (value && typeof value === 'object') return Object.values(value).some(item => containsQuote(item, quote))
  return false
}

/** 复核材料使用 snake_case；桌面端存储与 UI 仍使用 camelCase。 */
export function fusionMaterial(idea: FanqieChartIdea) {
  return {
    title: idea.title, strategy: idea.strategy, genre: idea.genre, hook_line: idea.hookLine,
    golden_finger: idea.goldenFinger, core_concept: idea.coreConcept, fusion: idea.fusion,
    protagonist: idea.protagonist, opening_hook: idea.openingHook, selling_point: idea.sellingPoint,
    reader_fit: idea.readerFit, risk_notes: idea.riskNotes, opening_chapters: idea.openingChapters,
    trend_basis: idea.trendBasis.map(basis => ({ book_id: basis.bookId, title: basis.title, field: basis.field, quote: basis.quote, mechanism: basis.mechanism })),
    ...Object.fromEntries(Object.entries(EXPANSION_FIELDS).map(([key, value]) => [key, idea[value] ?? '']))
  }
}

export function buildFusionReviewPrompt(ideas: FanqieChartIdea[], books: FanqieChartBook[] = []): string {
  const sources = prepareBooks(books)
  return FUSION_REVIEW_PROMPT.replace('待审材料：\n',
    CHART_FUSION_RULES + '\n桌面版补充：source_books 提供所选来源的完整简介，核查辨识细节及来源增量，不把本案新增规则追认成源书规则。concept.opening_chapters 是实际采用的前三章方向，须与 opening_hook 及展开六字段一起核查；若章节新增能力绕过来源，同样判失败，证据引用展开中对应规则，不得忽略章节中的剩余解法。\n待审材料：\n') +
    JSON.stringify(ideas.map((idea, index) => ({ index: index + 1, concept: fusionMaterial(idea), opening_hook: idea.openingHook,
      source_books: sources.filter(book => idea.trendBasis.some(ref => ref.bookId === book.id)).map(book => ({ book_id: book.id, title: book.title, intro: book.intro })),
      expanded: Object.fromEntries(Object.entries(EXPANSION_FIELDS).map(([key, value]) => [key, idea[value]])) })))
}

export function chartSourceUsageLimit(ideaCount: number, sourceCount: number): number {
  return Math.max(1, Math.ceil(2 * ideaCount / Math.max(2, sourceCount)))
}

export function sourceReuseIssues(ideas: FanqieChartIdea[], ideaCount: number, sourceCount: number): string[] {
  const usage = new Map<string, number>()
  for (const idea of ideas) for (const id of new Set(idea.trendBasis.map(basis => basis.bookId))) usage.set(id, (usage.get(id) ?? 0) + 1)
  const limit = chartSourceUsageLimit(ideaCount, sourceCount)
  return [...usage].filter(([, count]) => count > limit).map(([id]) => `来源 ${id} 在同批使用超过 ${limit} 次，须换源重构。`)
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`融梗复核无效，旧结果已保留：${message}。`)
}

/** 仅验证协议完整性与引文；具体因果判断由独立模型完成，不能把格式合格当作语义证明。 */
export function validateFusionReview(payload: unknown, ideas: FanqieChartIdea[]) {
  const parsed = reviewSchema.safeParse(payload)
  ensure(parsed.success, '缺少完整的逐来源、逐阶段、替代路径或目标等效性核查')
  const { reviews, opening_comparisons: pairs, chapter_comparisons: chapterPairs } = parsed.data
  ensure(reviews.length === ideas.length && new Set(reviews.map(row => row.index)).size === ideas.length && reviews.every(row => row.index <= ideas.length), '方案索引缺失或重复')
  for (const row of reviews) {
    const idea = fusionMaterial(ideas[row.index - 1]) as Record<string, unknown>
    const checkEvidence = (item: {field: string; quote: string}, allowed: string[], required = true) => {
      ensure(allowed.includes(item.field) && (!required || item.quote.trim()) && (!item.quote || containsQuote(idea[item.field], item.quote)), '引用不是对应字段的连续原文')
    }
    const expected = new Set(ideas[row.index - 1].trendBasis.map(basis => basis.bookId))
    ensure(row.source_checks.length === expected.size && new Set(row.source_checks.map(check => check.book_id)).size === expected.size && row.source_checks.every(check => expected.has(check.book_id)), '未逐一覆盖全部来源')
    ensure(row.passed === (row.issues.length === 0), '通过结论与问题不一致')
    ensure(new Set(row.stage_goals.map(goal => goal.stage)).size === 3, '阶段目标重复或缺失')
    const hasWeak = row.issues.some(issue => issue.kind === 'weak_source_dependency')
    const hasDependency = row.issues.some(issue => dependencyKinds.includes(issue.kind))
    for (const goal of row.stage_goals) {
      checkEvidence(goal, evidenceKeys, goal.boundary_valid)
      ensure(goal.boundary_valid || hasWeak, '目标边界未证实不能通过')
      ensure(goal.need_established || hasWeak, '新批次不能冒充未证实的新需求')
    }
    ensure(new Set(row.action_checks.map(action => action.stage)).size === 3, '行动闭环未覆盖三个阶段')
    for (const action of row.action_checks) {
      checkEvidence(action, [...evidenceKeys, 'opening_chapters'], action.loop_closed)
      ensure(action.loop_closed || row.issues.some(issue => issue.kind === 'action_loop_gap'), '行动核验闭环不成立不能通过')
    }
    for (const check of row.source_checks) {
      checkEvidence(check, expansionKeys, row.passed)
      checkEvidence(check.deletion_audit, evidenceKeys)
      ensure(check.deletion_audit.core_operation_removed && check.deletion_audit.retained_means_preserved && check.deletion_audit.activation_conditions_preserved,
        '反事实删除范围不合法，不能只删限制保留核心能力、没收既得手段或取消触发条件')
      ensure(check.contribution_type !== 'attitude_only' || hasWeak, '态度逆转不能冒充不可替代贡献')
      ensure(check.deletion_audit.dependency_boundary !== 'ambiguous' || hasWeak, '新增检测边界不明须报告未证实')
      for (const retained of check.retained_means) checkEvidence(retained, evidenceKeys)
      ensure(new Set(check.stage_checks.map(stage => stage.stage)).size === 3, '开篇中段后段未全部核查')
      for (const stage of check.stage_checks) {
        checkEvidence(stage, expansionKeys, stage.required_now)
        const goal = row.stage_goals.find(goal => goal.stage === stage.stage)!
        const action = row.action_checks.find(action => action.stage === stage.stage)!
        ensure(!stage.required_now || (action.loop_closed && goal.need_established && check.deletion_audit.dependency_boundary === 'resolved'),
          '行动闭环、新需求或检测依赖未证实不能判来源必需')
        ensure(stage.required_output === goal.required_output, '删除不同来源时偷换了实际目标')
        checkEvidence(stage.execution_audit, evidenceKeys, stage.execution_audit.evidence_sufficient)
        ensure(!stage.required_now || stage.execution_audit.evidence_sufficient, '设备场域或执行条件未证实不能判来源必需')
        ensure(!stage.required_now || goal.boundary_valid, '目标边界未证实不能判来源必需')
        ensure(stage.required_now || hasDependency, '历史贡献或阶段可替代不能通过')
        ensure(new Set(stage.route_checks.map(route => route.kind)).size === 3, '未逐一核查交流、人工取物、既有队伍')
        for (const route of [...stage.route_checks, stage.combination_check]) {
          checkEvidence(route, evidenceKeys, ['blocked', 'not_applicable'].includes(route.outcome))
          ensure(route.outcome !== 'viable' || route.payoff_match === 'equivalent', '替代路线丢失独特回报不能视为可行')
          ensure(!stage.required_now || (!['viable', 'unproven'].includes(route.outcome) && route.payoff_match !== 'unproven'), '可行或未排除的替代路径不能判来源必需')
        }
      }
    }
    for (const issue of row.issues) checkEvidence(issue,
      issue.kind === 'opening_conflict_repeat' ? [...expansionKeys, 'opening_hook'] :
        ['action_loop_gap', 'chapter_progression_repeat'].includes(issue.kind) ? [...evidenceKeys, 'opening_chapters'] : expansionKeys, false)
  }
  ensure(pairs.length === ideas.length * (ideas.length - 1) / 2, '开场冲突未覆盖全部方案对')
  const seen = new Set<string>()
  for (const pair of pairs) {
    const { left_index: a, right_index: b } = pair
    const key = `${a}-${b}`
    ensure(a >= 1 && a < b && b <= ideas.length && !seen.has(key), '开场冲突对比编号无效或重复')
    seen.add(key)
    ensure(pair.left_quote.trim() && ideas[a - 1].openingHook.includes(pair.left_quote) && pair.right_quote.trim() && ideas[b - 1].openingHook.includes(pair.right_quote), '开场对比缺少真实引文')
    ensure(!pair.same_conflict || reviews.find(row => row.index === a)!.issues.some(issue => issue.kind === 'opening_conflict_repeat'), '重复开场不能通过')
  }
  ensure(chapterPairs.length === pairs.length, '前三章推进未覆盖全部方案对')
  const chapterSeen = new Set<string>()
  for (const pair of chapterPairs) {
    const { left_index: a, right_index: b } = pair
    const key = `${a}-${b}`
    ensure(seen.has(key) && !chapterSeen.has(key), '前三章推进对比编号无效或重复')
    chapterSeen.add(key)
    for (const [index, chain] of [[a, pair.left_chain], [b, pair.right_chain]] as const) {
      ensure(new Set(chain.map(item => item.chapter)).size === 3, '前三章推进链漏章或重复')
      for (const item of chain) {
        const chapter = ideas[index - 1].openingChapters?.find(chapter => chapter.chapter === item.chapter)
        ensure(item.quote.trim() && containsQuote(chapter, item.quote), '前三章推进引文不属于对应章节')
      }
    }
    ensure(!pair.same_progression || reviews.find(row => row.index === a)!.issues.some(issue => issue.kind === 'chapter_progression_repeat'), '重复的前三章推进不能通过')
  }
  return reviews.sort((a, b) => a.index - b.index)
}
