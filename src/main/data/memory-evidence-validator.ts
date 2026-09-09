import type { AuditViolation, ChapterSelfCheckReport, Foreshadowing, MemoryExtraction } from '../../shared/types'

/** Remove only a balanced citation wrapper, and only when its contents exist verbatim.
 * Never repair paraphrases or remove punctuation/negation inside the quotation.
 */
export function resolveMemoryEvidence(content: string, evidence: string | undefined): string | undefined {
  if (typeof evidence !== 'string') return undefined
  const quote = evidence.trim()
  if (quote.length < 6) return undefined
  if (content.includes(quote)) return quote
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" }
  if (pairs[quote[0]] !== quote.at(-1)) return undefined
  const inner = quote.slice(1, -1).trim()
  return inner.length >= 6 && content.includes(inner) ? inner : undefined
}

/** Persist actual source quotes so downstream writers use the same evidence as validation. */
export function normalizeMemoryEvidence(content: string, extraction: MemoryExtraction): MemoryExtraction {
  const normalize = <T extends { evidence?: string }>(item: T): T => {
    const evidence = resolveMemoryEvidence(content, item.evidence)
    return evidence === undefined ? item : { ...item, evidence }
  }
  return { ...extraction,
    newPlotPoints: extraction.newPlotPoints.map(normalize),
    characterStateChanges: extraction.characterStateChanges.map(normalize),
    collectedForeshadowings: extraction.collectedForeshadowings.map(normalize),
    settingsPatches: extraction.settingsPatches?.map(normalize)
  }
}

/** Check provenance conservatively. A matching quote is necessary, not proof of semantic truth. */
export function validateMemoryCandidate(
  content: string,
  extraction: MemoryExtraction,
  review: AuditViolation[] = [],
  selfCheck?: ChapterSelfCheckReport | null,
  foreshadowings?: Foreshadowing[]
): string[] {
  const issues: string[] = []
  const inspect = (label: string, evidence: string | undefined): void => {
    evidence = resolveMemoryEvidence(content, evidence)
    if (evidence === undefined) {
      issues.push(`${label}：缺少可定位的正文原文依据`)
      return
    }
    // Missing surrounding context can turn “没有死” into “死”; inspect the entire containing sentence.
    const start = content.indexOf(evidence.trim())
    const left = Math.max(content.lastIndexOf('。', start - 1), content.lastIndexOf('\n', start - 1)) + 1
    const evidenceEnd = start + evidence.trim().length
    const ended = /[。！？!?\n][”’」』"]*$/.test(evidence.trim())
    const endings = ['。', '！', '？', '!', '?', '\n'].map((mark) => content.indexOf(mark, evidenceEnd)).filter((n) => n >= 0)
    let contextEnd = ended ? evidenceEnd : endings.length ? Math.min(...endings) + 1 : content.length
    // “物证相同，……再往下猜，便没有凭据” separates an observed fact
    // from further speculation. Only trim an explicit scope transition AFTER
    // the quote; negation before/inside the evidence must still block it.
    const suffix = content.slice(evidenceEnd, contextEnd)
    const scopeBoundary = /[，,；;]\s*再往下猜/.exec(suffix)
    if (scopeBoundary) contextEnd = evidenceEnd + scopeBoundary.index
    const context = content.slice(left, contextEnd)
    if (/(?:听说|据说|传闻|谣言|据传|猜测|怀疑|误以为|假装|佯装|打算|准备|计划|也许|可能|倘若|如果|假如|梦见|梦中|幻觉|并未|没有|尚未|还未|未曾|不曾)/u.test(context)) {
      issues.push(`${label}：原文含否定、计划或不确定表述，需要核对实际变化`)
    }
  }
  if (extraction.parseError) issues.push(extraction.parseError)
  for (const event of extraction.newPlotPoints) inspect(`情节「${event.title}」`, event.evidence)
  for (const change of extraction.characterStateChanges) inspect(`人物 ${change.name} 的${change.field}`, change.evidence)
  for (const item of extraction.collectedForeshadowings) {
    inspect(`伏笔回收「${item.content}」`, item.evidence)
    if (item.chapter !== extraction.chapterNumber) issues.push(`伏笔「${item.content}」的回收章节与当前章不符`)
    if (foreshadowings && item.foreshadowingId) {
      const matches = foreshadowings.filter((f) => f.id === item.foreshadowingId)
      if (matches.length !== 1 || matches[0].content.replace(/\s+/g, '') !== item.content.replace(/\s+/g, '')) {
        issues.push(`伏笔 ${item.foreshadowingId} 的编号与原问题不一致或存在歧义，需要重新核对`)
      }
    }
  }
  for (const patch of extraction.settingsPatches ?? []) inspect(`设定「${patch.title || patch.sectionTitle || patch.fileName}」`, patch.evidence)
  for (const finding of review) {
    if (finding.ruleId?.startsWith('review_incomplete:') || finding.severity === 'error' ||
      (finding.severity === 'warn' && /logic_hole|character_breakdown|quote_contradiction|low_iq_plot/.test(finding.ruleId ?? ''))) {
      issues.push(`审稿待核对：${finding.message}`)
    }
  }
  for (const item of selfCheck?.items ?? []) {
    if (item.verdict === 'fail') issues.push(`正文自检待核对：${item.label}：${item.detail}`)
  }
  return [...new Set(issues)]
}
