import type {
  AuditReport,
  AuditViolation,
  ChapterReviewReport,
  ReviewRulesConfig
} from '../../shared/types'

/**
 * 审核报告构建器（对齐「正文审核」技能第 6 步报告模板）。
 * 将 auditChapter 的 AuditReport + LLM findings 聚合为 10 节结构化报告。
 */
export function buildReviewReport(
  chapterNumber: number,
  audit: AuditReport,
  llmViolations: AuditViolation[],
  opts: {
    genre?: string
    reviewRules?: ReviewRulesConfig
    minWords?: number
  } = {}
): ChapterReviewReport {
  const minRequired = opts.minWords ?? opts.reviewRules?.thresholds.minWords ?? 2300
  const allViolations = [...audit.violations, ...llmViolations]

  // 按类别分组
  const toxicPoints = allViolations.filter((v) => v.category === 'toxic')
  const quoteConsistency = allViolations.filter((v) => v.category === 'quote')
  const qualityViolations = allViolations.filter((v) => v.category === 'quality')
  const sensitiveWords = allViolations.filter((v) => v.category === 'sensitive')
  const deAiSuggestions = allViolations.filter(
    (v) => v.category === 'forbidden_word' || v.category === 'rule'
  )
  const hookStrength = allViolations.filter((v) => v.ruleId === 'hook_strength')
  const dialogueTags = allViolations.filter((v) => v.ruleId === 'dialogue_tag')
  const paragraphLength = allViolations.filter((v) => v.ruleId === 'long_paragraph')
  const styleMatchViolations = allViolations.filter((v) => v.ruleId === 'style_match')
  const coolPointViolations = allViolations.filter((v) => v.ruleId === 'cool_point')

  // 成文质量判定
  const qualityErrors = qualityViolations.filter((v) => v.severity === 'error').length
  const manuscriptQualityVerdict: '✅' | '⚠️' | '🚨' =
    qualityErrors > 0 ? '🚨' : qualityViolations.length > 0 ? '⚠️' : '✅'

  // 字数统计
  const current = audit.wordCount
  const passing = current >= minRequired
  const wordSuggestion = !passing
    ? `当前 ${current} 字，不足合格线 ${minRequired} 字。建议：加剧情/加对话/加矛盾冲突/加变数/加细节描写/加伏笔。`
    : current > (opts.reviewRules?.thresholds.maxWords ?? 3500)
      ? `当前 ${current} 字，偏多，检查是否有水字数。`
      : null

  // 爽点分析
  const coolPointApplicable = opts.genre?.includes('爽') ?? false

  // 评分计算（基础 10 分，每个 error 扣 1 分，每个 warn 扣 0.3 分）
  const errorCount = allViolations.filter((v) => v.severity === 'error').length
  const warnCount = allViolations.filter((v) => v.severity === 'warn').length
  const rawScore = 10 - errorCount - warnCount * 0.3
  const score = Math.max(0, Math.min(10, Math.round(rawScore * 10) / 10))

  // 主要问题
  const mainIssues: string[] = []
  if (toxicPoints.length > 0) mainIssues.push(`毒点 ${toxicPoints.length} 处`)
  if (deAiSuggestions.length > 0) mainIssues.push(`AI 味 ${deAiSuggestions.length} 处`)
  if (!passing) mainIssues.push(`字数不足（${current}/${minRequired}）`)
  if (hookStrength.length > 0) mainIssues.push('章末钩子偏弱')
  if (quoteConsistency.length > 0) mainIssues.push(`引文一致性 ${quoteConsistency.length} 处`)

  // 修复优先级
  const fixPriority: string[] = []
  const mustFix = allViolations.filter((v) => v.severity === 'error')
  if (mustFix.length > 0) fixPriority.push(`🚨 必须修复：${mustFix.length} 处（影响阅读/逻辑错误）`)
  const suggestOptimize = allViolations.filter((v) => v.severity === 'warn')
  if (suggestOptimize.length > 0) fixPriority.push(`💡 建议优化：${suggestOptimize.length} 处`)
  if (!passing) fixPriority.push(`📝 字数扩充至 ${minRequired} 字以上`)

  return {
    chapterNumber,
    generatedAt: new Date().toISOString(),
    memoryConsistency: {
      read: true,
      missingFiles: []
    },
    outlineConsistency: {
      hasOutline: true,
      rhythmMatchPercent: null,
      notes: []
    },
    toxicPoints,
    quoteConsistency,
    manuscriptQuality: {
      violations: qualityViolations,
      verdict: manuscriptQualityVerdict
    },
    continuity: {
      plotTransition: null,
      timeline: null,
      spatialTransition: null,
      notes: []
    },
    structure: {
      hookStrength,
      dialogueTags,
      paragraphLength
    },
    sensitiveWords,
    coolPointAnalysis: {
      applicable: coolPointApplicable,
      violations: coolPointViolations,
      notes: coolPointApplicable ? [] : ['非爽文题材，跳过爽点分析']
    },
    wordCount: {
      current,
      passing,
      minRequired,
      suggestion: wordSuggestion
    },
    styleMatch: {
      genre: opts.genre ?? null,
      matchPercent: null,
      violations: styleMatchViolations
    },
    deAiSuggestions,
    overall: {
      score,
      mainIssues,
      fixPriority
    }
  }
}
