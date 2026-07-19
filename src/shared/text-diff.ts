/**
 * 轻量文本 diff：用于去 AI 味结果在 LLM 未输出【改动说明】时兜底展示。
 * 按「空行分段 / 单行」对齐，不依赖第三方 diff 库。
 */

export interface TextDiffHunk {
  /** 原文片段 */
  before: string
  /** 改写后片段 */
  after: string
  /** 在原文中的大致字符偏移 */
  index: number
  /** 1-based 段/行号（用于展示） */
  line: number
}

/**
 * 按空行切段；若几乎没有空行段落，则退化为按单行切。
 * 这样对网文（段间常空行）和紧凑文本都可用。
 */
export function splitUnits(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const paras = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  // 段落太少时按行切，避免整章被当成一两块
  if (paras.length <= 2 && normalized.includes('\n')) {
    return normalized.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  }
  return paras
}

type Op = { type: 'eq' | 'del' | 'add'; before?: string; after?: string; beforeIndex: number }

/**
 * 标准 LCS 回溯，产出 eq / del / add 序列，再合并为改动块。
 */
export function diffUnits(beforeUnits: string[], afterUnits: string[]): TextDiffHunk[] {
  const n = beforeUnits.length
  const m = afterUnits.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (beforeUnits[i] === afterUnits[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeUnits[i] === afterUnits[j]) {
      ops.push({ type: 'eq', before: beforeUnits[i], after: afterUnits[j], beforeIndex: i })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', before: beforeUnits[i], beforeIndex: i })
      i++
    } else {
      ops.push({ type: 'add', after: afterUnits[j], beforeIndex: i })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', before: beforeUnits[i], beforeIndex: i })
    i++
  }
  while (j < m) {
    ops.push({ type: 'add', after: afterUnits[j], beforeIndex: i })
    j++
  }

  // 预计算 before 每段起始偏移
  const offsets: number[] = []
  let acc = 0
  for (const u of beforeUnits) {
    offsets.push(acc)
    acc += u.length + 2
  }

  const hunks: TextDiffHunk[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].type === 'eq') {
      k++
      continue
    }
    const del: string[] = []
    const add: string[] = []
    const startIdx = ops[k].beforeIndex
    while (k < ops.length && ops[k].type !== 'eq') {
      if (ops[k].type === 'del' && ops[k].before) del.push(ops[k].before!)
      if (ops[k].type === 'add' && ops[k].after) add.push(ops[k].after!)
      k++
    }
    hunks.push({
      before: del.join('\n\n'),
      after: add.join('\n\n'),
      index: offsets[startIdx] ?? 0,
      line: startIdx + 1
    })
  }
  return hunks
}

/** 截断过长片段便于 UI 展示 */
function clip(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max) + '…'
}

/**
 * 把 before/after 全文 diff 成可读的 changeSummary 行。
 * @param max 最多条数（默认 30，与 skill 报告约定一致）
 */
export function summarizeTextDiff(before: string, after: string, max = 30): string[] {
  if (before === after) return []
  const hunks = diffUnits(splitUnits(before), splitUnits(after))
  if (hunks.length === 0) {
    return ['- 全文｜原句与改后在段级一致，但标点或空白有差异（已落盘）']
  }
  const lines: string[] = []
  for (const h of hunks) {
    if (lines.length >= max) break
    if (h.before && h.after) {
      lines.push(`- 第${h.line}段｜原句：${clip(h.before)} → 改后：${clip(h.after)} ｜理由：自动对比检出`)
    } else if (h.before && !h.after) {
      lines.push(`- 第${h.line}段｜删除：${clip(h.before)} ｜理由：自动对比检出`)
    } else if (!h.before && h.after) {
      lines.push(`- 第${h.line}段｜新增：${clip(h.after)} ｜理由：自动对比检出`)
    }
  }
  if (hunks.length > max) {
    lines.push(`- …其余 ${hunks.length - max} 处改动已折叠，请点「看全文」或滚动改动块查看`)
  }
  return lines
}

/**
 * 找首个字符差异，返回两侧的窗口切片，避免默认只看前 600 字时「看起来没改」。
 */
export function findFirstDiffWindow(
  before: string,
  after: string,
  windowSize = 600
): { beforeSlice: string; afterSlice: string; offset: number; identical: boolean } {
  if (before === after) {
    return {
      beforeSlice: before.slice(0, windowSize),
      afterSlice: after.slice(0, windowSize),
      offset: 0,
      identical: true
    }
  }
  const len = Math.min(before.length, after.length)
  let i = 0
  while (i < len && before[i] === after[i]) i++
  const start = Math.max(0, i - 40)
  return {
    beforeSlice: before.slice(start, start + windowSize),
    afterSlice: after.slice(start, start + windowSize),
    offset: start,
    identical: false
  }
}

/**
 * 供 UI 展示的改动块列表（限制数量）。
 */
export function listChangeHunks(before: string, after: string, max = 20): TextDiffHunk[] {
  if (before === after) return []
  return diffUnits(splitUnits(before), splitUnits(after)).slice(0, max)
}
