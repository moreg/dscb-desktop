/**
 * 标点兜底（移植自 oh-story-claudecode normalize-punctuation.js）。
 *
 * 去 AI 味 Phase 3.5 的确定性收尾：清理破折号 ——/—/-- 和省略号停顿 ……/…，
 * 改为句号/逗号。这是机械替换（只动标点不动文字），安全可批量执行。
 *
 * 破折号的「按功能改写」（打断→动作/拖长→省略/插入说明→逗号）由 LLM 在 Phase 3 完成，
 * 本函数只兜底 LLM 漏改的机械破折号。
 */

export interface NormalizeResult {
  /** 兜底后的文本 */
  text: string
  /** 替换统计 */
  changes: {
    /** 双破折号 —— 改为逗号/句号 */
    emDash: number
    /** 单破折号 — 改为逗号 */
    dash: number
    /** 双连字符 -- 改为逗号 */
    doubleHyphen: number
    /** 省略号 …… 改为句号 */
    ellipsis: number
    /** 单省略号 … 改为句号 */
    singleEllipsis: number
  }
}

/**
 * 兜底标点。规则：
 * - ——（双破折号）：前后是句子结尾用句号，否则逗号
 * - —（单破折号）：逗号
 * - --（双连字符）：逗号
 * - ……（六点省略号）：句号
 * - …（三点省略号）：句号
 *
 * 盐言「」引号不在此列（对话引号保留）。
 */
export function normalizePunctuation(input: string): NormalizeResult {
  let text = input
  const changes = {
    emDash: 0,
    dash: 0,
    doubleHyphen: 0,
    ellipsis: 0,
    singleEllipsis: 0
  }

  // 六点省略号 ……（两个 U+2026）→ 句号
  text = text.replace(/……/g, () => {
    changes.ellipsis += 1
    return '。'
  })
  // 三点省略号 …（单个 U+2026）→ 句号
  text = text.replace(/…/g, () => {
    changes.singleEllipsis += 1
    return '。'
  })

  // 双破折号 —— → 视上下文用句号或逗号
  text = text.replace(/([。！？!?"'」』）)】])——/g, '$1') // 句尾破折号直接删
  text = text.replace(/——/g, (match, offset) => {
    changes.emDash += 1
    // 后接句号/感叹号/问号 → 删（已是断句）；否则用逗号
    const next = text[offset + match.length]
    if (next && /[。！？!？]/.test(next)) return ''
    return '，'
  })

  // 单破折号 —（U+2014）→ 逗号（避免误伤数字范围，但中文正文里罕见）
  text = text.replace(/(?<![0-9])—(?![0-9])/g, () => {
    changes.dash += 1
    return '，'
  })

  // 双连字符 -- → 逗号
  text = text.replace(/--+/g, () => {
    changes.doubleHyphen += 1
    return '，'
  })

  return { text, changes }
}

/**
 * 统计原文中的标点问题数（不修改，仅 Phase 1 扫描用）。
 */
export function countPunctuationIssues(input: string): number {
  let count = 0
  const ellipsis = input.match(/……/g)
  if (ellipsis) count += ellipsis.length
  const singleEllipsis = input.match(/(?<!…)…(?!…)/g)
  if (singleEllipsis) count += singleEllipsis.length
  const emDash = input.match(/——/g)
  if (emDash) count += emDash.length
  const dash = input.match(/(?<![0-9])—(?!—|[0-9])/g)
  if (dash) count += dash.length
  const hyphen = input.match(/--+/g)
  if (hyphen) count += hyphen.length
  return count
}
