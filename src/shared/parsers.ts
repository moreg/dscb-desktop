import type {
  FigureDraft,
  MemoryExtraction,
  OutlineDiffItem,
  OutlineDiffReport,
  OutlineDiffType,
  RhythmEvaluation
} from './types'

/**
 * 纯解析函数集合（main 与 renderer 共享）。
 * 不依赖 Node API，可安全在 renderer 中引用。
 */

/** 解析 LLM 输出的细纲对照差异 JSON 数组 */
export function parseOutlineDiffJson(raw: string, chapterNumber: number): OutlineDiffReport {
  const labels: Record<number, OutlineDiffItem['typeLabel']> = {
    1: '漏写',
    2: '超纲增量',
    3: '细节调整',
    4: '核心事件改',
    5: '结构性偏离'
  }
  try {
    const m = raw.match(/\[[\s\S]*\]/)
    if (!m) return { chapterNumber, diffs: [], passed: true }
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return { chapterNumber, diffs: [], passed: true }
    const diffs: OutlineDiffItem[] = arr
      .filter((x) => x && typeof x === 'object' && typeof x.type === 'number')
      .map((x) => ({
        type: x.type as OutlineDiffType,
        typeLabel: labels[x.type] ?? '细节调整',
        outline: typeof x.outline === 'string' ? x.outline : undefined,
        actual: typeof x.actual === 'string' ? x.actual : undefined,
        suggestion: typeof x.suggestion === 'string' ? x.suggestion : '',
        priority: ['P0', 'P1', 'P2'].includes(x.priority) ? x.priority : 'P2'
      }))
    const passed = !diffs.some((d) => d.priority === 'P0' || d.priority === 'P1')
    return { chapterNumber, diffs, passed }
  } catch {
    return { chapterNumber, diffs: [], passed: true }
  }
}

/** 解析 LLM 输出的记忆提取 JSON，失败返回空提取 */
export function parseMemoryExtractionJson(raw: string, chapterNumber: number): MemoryExtraction {
  const empty: MemoryExtraction = {
    chapterNumber,
    newCharacters: [],
    newLocations: [],
    newForeshadowings: [],
    newPlotPoints: [],
    characterStateChanges: [],
    collectedForeshadowings: []
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return empty
    const obj = JSON.parse(m[0])
    return {
      chapterNumber,
      newCharacters: Array.isArray(obj.newCharacters) ? obj.newCharacters : [],
      newLocations: Array.isArray(obj.newLocations) ? obj.newLocations : [],
      newForeshadowings: Array.isArray(obj.newForeshadowings) ? obj.newForeshadowings : [],
      newPlotPoints: Array.isArray(obj.newPlotPoints) ? obj.newPlotPoints : [],
      characterStateChanges: Array.isArray(obj.characterStateChanges)
        ? obj.characterStateChanges
        : [],
      collectedForeshadowings: Array.isArray(obj.collectedForeshadowings)
        ? obj.collectedForeshadowings
        : []
    }
  } catch {
    return empty
  }
}

/**
 * 解析 LLM 输出的节奏评估 JSON。
 * 优先用 LLM 输出的 expectedEmotion（透传字段），否则用参数 fallback。
 * 自动计算 diff 与 autoApply（diff ≤ 1 自动回写）。
 * 失败返回 null（调用方应跳过回填）。
 */
export function parseRhythmEvaluationJson(
  raw: string,
  chapterNumber: number,
  expectedFallback: number
): RhythmEvaluation | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    const obj = JSON.parse(m[0])
    if (typeof obj.actualEmotion !== 'number') return null
    // 钳制到 0-10
    const actual = Math.max(0, Math.min(10, obj.actualEmotion))
    const expected =
      typeof obj.expectedEmotion === 'number'
        ? Math.max(0, Math.min(10, obj.expectedEmotion))
        : expectedFallback
    const diff = Math.abs(actual - expected)
    return {
      chapterNumber,
      actualEmotion: actual,
      expectedEmotion: expected,
      diff,
      autoApply: diff <= 1,
      reason: typeof obj.reason === 'string' ? obj.reason : ''
    }
  } catch {
    return null
  }
}

/**
 * 解析 LLM 输出的图解草稿 JSON。
 * shouldGenerate=false 时返回空 draft（调用方应跳过保存）。
 * 失败兜底返回 shouldGenerate=false。
 */
export function parseFigureDraftJson(raw: string, chapterNumber: number): FigureDraft {
  const empty: FigureDraft = {
    chapterNumber,
    shouldGenerate: false,
    type: '',
    topic: '',
    fileName: '',
    html: '',
    reason: '解析失败'
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return empty
    const obj = JSON.parse(m[0])
    const shouldGenerate = !!obj.shouldGenerate
    const type = typeof obj.type === 'string' ? obj.type : ''
    const topic = typeof obj.topic === 'string' ? obj.topic : ''
    // 文件名：清理非法字符
    const safeType = type.replace(/[\\/:*?"<>|]/g, '_').trim()
    const safeTopic = topic.replace(/[\\/:*?"<>|]/g, '_').trim()
    const fileName =
      shouldGenerate && safeType && safeTopic ? `${safeType}_${safeTopic}.html` : ''
    return {
      chapterNumber,
      shouldGenerate,
      type,
      topic,
      fileName,
      html: shouldGenerate ? buildFigureHtml(type, topic, obj.mermaid || '') : '',
      reason: typeof obj.reason === 'string' ? obj.reason : ''
    }
  } catch {
    return empty
  }
}

/** 按 SKILL.md 模板构造 Mermaid HTML 文档 */
export function buildFigureHtml(type: string, topic: string, mermaid: string): string {
  const safeType = type.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
  const safeTopic = topic.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>关键情节图解：${safeType}_${safeTopic}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body { font-family: 'Microsoft YaHei', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        .section { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; }
    </style>
</head>
<body>
    <h1>关键情节图解：${safeType}_${safeTopic}</h1>
    <div class="section">
        <h2>转折过程</h2>
        <div class="mermaid">
${mermaid}
        </div>
    </div>
    <script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`
}

/* =========================================================
   伏笔回执（foreshadow receipt）
   续写 prompt 要求 LLM 在正文末尾另起一段写一行 JSON：
   【本章伏笔回执】{"planted":["..."],"collected":["..."]}
   renderer 端解析后调 IPC 同步到伏笔库。
   ========================================================= */

export interface ForeshadowReceipt {
  planted: string[]
  collected: string[]
  raw: string
}

/**
 * 在文本中定位"【本章伏笔回执】"标签后的 JSON。
 * 用栈式大括号平衡匹配，**不依赖**非贪婪正则，规避 LLM 在字符串值里出现 "}" 时的截断 bug。
 * 失败返回 null（不抛）。
 */
function findReceiptJson(raw: string): { jsonStr: string; start: number; end: number } | null {
  const tag = '【本章伏笔回执】'
  const tagIdx = raw.indexOf(tag)
  if (tagIdx < 0) return null
  // 从标签后第一个 '{' 开始
  const startSearch = raw.indexOf('{', tagIdx + tag.length)
  if (startSearch < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = startSearch; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return { jsonStr: raw.slice(startSearch, i + 1), start: tagIdx, end: i + 1 }
      }
    }
  }
  return null
}

/**
 * 解析 LLM 在正文末尾写下的【本章伏笔回执】。
 * - 没找到标签 → 返回 { receipt: null, stripped: 原文本 }
 * - 找到但 JSON 解析失败 → 返回 { receipt: { planted: [], collected: [], raw }, stripped }
 * - 找到且解析成功 → 返回 { receipt, stripped: 剥离回执后的纯正文 }
 */
export function parseForeshadowReceipt(raw: string): {
  receipt: ForeshadowReceipt | null
  stripped: string
} {
  const empty = { receipt: null as ForeshadowReceipt | null, stripped: raw }
  const found = findReceiptJson(raw)
  if (!found) return empty
  const jsonStr = found.jsonStr.trim()
  // 剥离：标签到 JSON 结束 + 收尾换行整理
  const stripped = raw
    .slice(0, found.start)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { receipt: { planted: [], collected: [], raw: jsonStr }, stripped }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { receipt: { planted: [], collected: [], raw: jsonStr }, stripped }
  }
  const obj = parsed as Record<string, unknown>
  const sanitize = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : []
  return {
    receipt: {
      planted: sanitize(obj.planted),
      collected: sanitize(obj.collected),
      raw: jsonStr
    },
    stripped
  }
}

/**
 * 严格匹配两个伏笔文本是否指同一件事。
 * 用于 applyForeshadowReceipt 的"模糊匹配"：LLM 在回执里可能改写了原文。
 *
 * 规则（全部满足才视为匹配）：
 * - 长度过滤：两边都 ≥ 2 字符
 * - 长度比：较短串 / 较长串 ≥ 0.5（防止"图" 命中"图书"）
 * - 包含关系：a.includes(b) 或 b.includes(a)
 *
 * 例：
 *   "旧钥匙" vs "那把生锈的旧钥匙" → 长度比 0.5 ✓ "旧钥匙".includes("旧钥匙") → 匹配
 *   "图" vs "图书" → 长度比 0.25 ✗ 不匹配
 *   "眼睛" vs "她的眼睛闪着光" → 长度比 0.5 ✓ 匹配
 */
export function isForeshadowMatch(a: string, b: string): boolean {
  const sa = a.trim()
  const sb = b.trim()
  if (sa.length < 2 || sb.length < 2) return false
  const shorter = Math.min(sa.length, sb.length)
  const longer = Math.max(sa.length, sb.length)
  if (longer === 0) return false
  if (shorter / longer < 0.5) return false
  return sa.includes(sb) || sb.includes(sa)
}
