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
    /** 台词说话中间的句号改为逗号 */
    dialoguePeriod?: number
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
    singleEllipsis: 0,
    dialoguePeriod: 0
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
  // 句尾破折号直接删（也要计数：不计的话 totalNormChanges 会是 0，日志报"没改"但正文已变）
  text = text.replace(/([。！？!?"'」』）)】])——/g, (_m, keep: string) => {
    changes.emDash += 1
    return keep
  })
  text = text.replace(/——/g, (match, offset) => {
    changes.emDash += 1
    // 后接句号/感叹号/问号 → 删（已是断句）；否则用逗号
    const next = text[offset + match.length]
    if (next && /[。！？!？]/.test(next)) return ''
    // 若后接闭合引号/括号或换行/句末（例如被打断台词“你——”），属于句末断句，转为句号，严禁转成逗号导致闭合引号前挂逗号
    if (!next || /[”"」』’'）)】\r\n]/.test(next)) return '。'
    return '，'
  })

  // 单破折号 —（U+2014）→ 句末用句号，句中用逗号（避免误伤数字范围，但中文正文里罕见）
  text = text.replace(/(?<![0-9])—(?![0-9])/g, (match, offset) => {
    changes.dash += 1
    const next = text[offset + match.length]
    if (next && /[。！？!？]/.test(next)) return ''
    if (!next || /[”"」』’'）)】\r\n]/.test(next)) return '。'
    return '，'
  })

  // 双连字符 -- → 逗号。整行分割线（--- / *** / ___）豁免：
  // 扫描器的 isDivider() 就跳过这类行，兜底若照改会把场景分割线变成一个孤零零的「，」。
  text = text
    .split('\n')
    .map((line) =>
      isDividerLine(line)
        ? line
        : line.replace(/--+/g, (match, offset) => {
            changes.doubleHyphen += 1
            const next = line[offset + match.length]
            if (next && /[。！？!？]/.test(next)) return ''
            if (!next || /[”"」』’'）)】]/.test(next)) return '。'
            return '，'
          })
    )
    .join('\n')

  // 引号内台词说话中间的句号 → 逗号（说话中间不落句号，保持口语连贯）
  text = text.replace(/([“"「])([^”"」\n]+?)([”"」])/g, (_match, open, content, close) => {
    let subChanged = 0
    const replaced = content.replace(/。(?!\s*$)/g, () => {
      subChanged += 1
      return '，'
    })
    if (subChanged > 0) {
      changes.dialoguePeriod = (changes.dialoguePeriod ?? 0) + subChanged
    }
    return open + replaced + close
  })

  // 清理闭合引号前的非法悬空逗号（台词闭合前严禁以逗号收尾，如被打断台词误转成的 "你，" 统一校正为 "你。"）
  text = text.replace(/，(?=[”"」』’'])/g, () => {
    changes.dialoguePeriod = (changes.dialoguePeriod ?? 0) + 1
    return '。'
  })

  return { text, changes }
}

/** 整行分割线（与 check-ai-patterns 的 isDivider 同口径，多带一个 \r 容错） */
function isDividerLine(line: string): boolean {
  const trimmed = line.trim()
  return /^-{3,}$/.test(trimmed) || /^[*_]{3,}$/.test(trimmed)
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
  // 与 normalizePunctuation 同口径：整行分割线不算标点问题
  for (const line of input.split('\n')) {
    if (isDividerLine(line)) continue
    const hyphen = line.match(/--+/g)
    if (hyphen) count += hyphen.length
  }
  return count
}
