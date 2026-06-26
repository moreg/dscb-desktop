import type { AuditViolation, CustomReviewCheck } from '../../shared/types'

/** 单条自定义项命中上限（沿用现有审稿约定）。 */
const MAX_HITS_PER_CHECK = 5

/**
 * 跑自定义算法类检查项（keyword / regex）。llm 类被跳过（由 review-flow-service 跑）。
 * 单项失败（如非法正则）只跳过不抛错，不阻断整体。
 * 结果 push 进 out，ruleId = check.id，category = check.group。
 *
 * 开关语义：与内置 isCheckOn 一致——checkToggles[id] !== false 才跑。
 * UI 的复选框写 checks[custom_id]，故必须读此表，不能只看 check.enabled。
 *
 * @param checkToggles 即 rules.checks；为 undefined 时按全开处理（向后兼容）
 */
export function runCustomAlgorithmChecks(
  content: string,
  checks: CustomReviewCheck[] | undefined,
  out: AuditViolation[],
  checkToggles?: Partial<Record<string, boolean>>
): void {
  if (!checks || !content) return
  for (const check of checks) {
    if (!check.enabled) continue
    // 用户开关：checks[id] === false 表示关闭（与 isCheckOn 同构）
    if (checkToggles && checkToggles[check.id] === false) continue
    if (check.type === 'keyword') {
      runKeywordCheck(content, check, out)
    } else if (check.type === 'regex') {
      runRegexCheck(content, check, out)
    }
    // type === 'llm' 不在此跑
  }
}

function runKeywordCheck(
  content: string,
  check: CustomReviewCheck,
  out: AuditViolation[]
): void {
  const words = check.keywords ?? []
  let reported = 0
  for (const word of words) {
    if (reported >= MAX_HITS_PER_CHECK) break
    let from = 0
    while (reported < MAX_HITS_PER_CHECK) {
      const idx = content.indexOf(word, from)
      if (idx < 0) break
      out.push({
        category: check.group,
        severity: check.severity,
        message: `${check.label}：命中「${word}」`,
        snippet: extractContext(content, idx, word.length),
        offset: idx,
        ruleId: check.id,
        word,
        suggestion: check.hint || undefined
      })
      reported++
      from = idx + word.length
    }
  }
}

function runRegexCheck(
  content: string,
  check: CustomReviewCheck,
  out: AuditViolation[]
): void {
  const src = check.pattern ?? ''
  if (!src) return
  let re: RegExp
  try {
    re = new RegExp(src, 'g')
  } catch (err) {
    console.warn(`[customCheck] ${check.id} 非法正则「${src}」:`, err)
    return
  }
  let reported = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null && reported < MAX_HITS_PER_CHECK) {
    out.push({
      category: check.group,
      severity: check.severity,
      message: `${check.label}：命中「${m[0]}」`,
      snippet: extractContext(content, m.index, m[0].length),
      offset: m.index,
      ruleId: check.id,
      word: m[0],
      suggestion: check.hint || undefined
    })
    reported++
    if (m.index === re.lastIndex) re.lastIndex++ // 防零宽死循环
  }
}

/** 上下文截取（与 chapter-audit.extractContext 同构，复制以保持文件独立）。 */
function extractContext(content: string, idx: number, wordLen: number): string {
  const radius = 12
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + wordLen + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return prefix + content.slice(start, end).replace(/\s+/g, ' ') + suffix
}
