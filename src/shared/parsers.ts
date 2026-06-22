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
