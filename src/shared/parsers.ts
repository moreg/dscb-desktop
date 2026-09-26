import type {
  FigureDraft,
  MemoryExtraction,
  OutlineDiffItem,
  OutlineDiffReport,
  OutlineDiffType,
  RhythmEvaluation
} from './types'
import { defaultResolutionForType, sanitizeOutlinePatch } from './outline-diff-apply'
import { findJsonArray, findJsonObject } from './json-extract'

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
  const resolutions = new Set(['updateOutline', 'updateContent', 'either', 'review'])
  const fail = (error: string): OutlineDiffReport => ({ chapterNumber, diffs: [], passed: false, checked: false, error })
  try {
    // 也接受 {"diffs": [...]} 包装。
    const found = findJsonArray(raw) ?? (() => {
      const obj = findJsonObject(raw)
      return Array.isArray(obj?.diffs) ? obj.diffs : undefined
    })()
    if (!found) return fail('细纲对照未返回可解析的 JSON 数组')
    // 模型常把 type 写成 "1"、priority 写成 "p0"；只做无歧义的规整，越界值仍判失败。
    const arr = found.map((x) => x && typeof x === 'object' && !Array.isArray(x)
      ? {
          ...x,
          type: typeof x.type === 'string' && /^\s*[1-5]\s*$/.test(x.type) ? Number(x.type) : x.type,
          priority: typeof x.priority === 'string' ? x.priority.trim().toUpperCase() : x.priority
        }
      : x)
    if (arr.some((x) => !x || typeof x !== 'object' ||
      ![1, 2, 3, 4, 5].includes(x.type) || !['P0', 'P1', 'P2'].includes(x.priority))) {
      return fail('细纲对照输出的差异项缺少有效的 type/priority')
    }
    const diffs: OutlineDiffItem[] = arr
      .filter((x) => x && typeof x === 'object' && typeof x.type === 'number')
      .map((x) => {
        const type = x.type as OutlineDiffType
        const item: OutlineDiffItem = {
          type,
          typeLabel: labels[type] ?? '细节调整',
          outline: typeof x.outline === 'string' ? x.outline : undefined,
          actual: typeof x.actual === 'string' ? x.actual : undefined,
          suggestion: typeof x.suggestion === 'string' ? x.suggestion : '',
          priority: ['P0', 'P1', 'P2'].includes(x.priority) ? x.priority : 'P2',
          resolution:
            typeof x.resolution === 'string' && resolutions.has(x.resolution)
              ? (x.resolution as OutlineDiffItem['resolution'])
              : defaultResolutionForType(type)
        }
        const outlinePatch = sanitizeOutlinePatch(x.outlinePatch)
        if (outlinePatch) item.outlinePatch = outlinePatch
        return item
      })
    const passed = !diffs.some((d) => d.priority === 'P0' || d.priority === 'P1')
    return { chapterNumber, diffs, passed }
  } catch {
    return fail('细纲对照输出的 JSON 格式错误')
  }
}

/** 解析失败保留显式状态，不能将坏 JSON 当作“本章无变化”清理历史。 */
export function parseMemoryExtractionJson(raw: string, chapterNumber: number): MemoryExtraction {
  const empty: MemoryExtraction = {
    chapterNumber,
    newCharacters: [],
    newLocations: [],
    newItems: [],
    newForeshadowings: [],
    newPlotPoints: [],
    characterStateChanges: [],
    collectedForeshadowings: [],
    settingsPatches: [],
    settingsSuggestions: []
  }
  try {
    const obj = findJsonObject(raw)
    if (!obj) return { ...empty, parseError: '记忆提取未返回有效 JSON，本次未提交' }
    const fields = ['newCharacters', 'newLocations', 'newItems', 'newForeshadowings', 'newPlotPoints', 'characterStateChanges', 'collectedForeshadowings', 'settingsPatches', 'settingsSuggestions']
    if (!obj || typeof obj !== 'object' ||
      ['newPlotPoints', 'characterStateChanges', 'collectedForeshadowings'].some((key) => !Array.isArray(obj[key])) ||
      fields.some((key) => obj[key] !== undefined && (!Array.isArray(obj[key]) ||
        obj[key].some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item))))) {
      return { ...empty, parseError: '记忆提取结构不完整，本次未提交' }
    }
    const required: Record<string, string[]> = {
      newCharacters: ['name'], newLocations: ['name'], newItems: ['name'],
      newForeshadowings: ['content'], newPlotPoints: ['title', 'event'],
      characterStateChanges: ['name', 'field', 'newValue'], collectedForeshadowings: ['content'],
      settingsPatches: ['target', 'fileName', 'op', 'content']
    }
    if (Object.entries(required).some(([key, props]) => (obj[key] ?? []).some((item: Record<string, unknown>) =>
      props.some((prop) => typeof item[prop] !== 'string') ||
      (item.evidence !== undefined && typeof item.evidence !== 'string') ||
      (item.foreshadowingId !== undefined && (typeof item.foreshadowingId !== 'string' || !item.foreshadowingId.trim()))))) {
      return { ...empty, parseError: '记忆条目字段无效，本次未提交' }
    }
    return {
      chapterNumber,
      newCharacters: Array.isArray(obj.newCharacters) ? obj.newCharacters : [],
      newLocations: Array.isArray(obj.newLocations) ? obj.newLocations : [],
      newItems: Array.isArray(obj.newItems) ? obj.newItems : [],
      newForeshadowings: Array.isArray(obj.newForeshadowings) ? obj.newForeshadowings : [],
      newPlotPoints: Array.isArray(obj.newPlotPoints) ? obj.newPlotPoints : [],
      characterStateChanges: Array.isArray(obj.characterStateChanges)
        ? obj.characterStateChanges
        : [],
      collectedForeshadowings: Array.isArray(obj.collectedForeshadowings)
        ? obj.collectedForeshadowings
        : [],
      settingsPatches: Array.isArray(obj.settingsPatches) ? obj.settingsPatches : [],
      settingsSuggestions: Array.isArray(obj.settingsSuggestions)
        ? obj.settingsSuggestions
        : []
    }
  } catch {
    return { ...empty, parseError: '记忆提取 JSON 解析失败，本次未提交' }
  }
}

/**
 * 解析 LLM 输出的节奏评估 JSON。
 * 使用调用方从节奏图谱读取的预期值，模型仅评估实际情绪，不能修改比较基准。
 * 自动计算 diff 与 autoApply（diff ≤ 1 自动回写）。
 * 失败返回 null（调用方应跳过回填）。
 */
export function parseRhythmEvaluationJson(
  raw: string,
  chapterNumber: number,
  expectedEmotion: number
): RhythmEvaluation | null {
  try {
    const obj = findJsonObject(raw)
    if (!obj) return null
    if (typeof obj.actualEmotion !== 'number' || !Number.isFinite(obj.actualEmotion) ||
      !Number.isFinite(expectedEmotion)) return null
    // 钳制到 0-10
    const actual = Math.max(0, Math.min(10, obj.actualEmotion))
    const expected = Math.max(0, Math.min(10, expectedEmotion))
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
    const obj = findJsonObject(raw)
    if (!obj) return empty
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
 * 只定位紧跟标签、位于全文末尾且字段有效的回执 JSON。
 * 正文可能先提及同名标签；逐个尝试，不从该标签跨越正文去寻找后面的 JSON。
 * 与正文守卫的末尾回执口径一致；无效结构原样保留，交给守卫/作者处理。
 */
function findReceiptJson(raw: string): { jsonStr: string; start: number; end: number } | null {
  const tag = '【本章伏笔回执】'
  for (let start = raw.indexOf(tag); start >= 0; start = raw.indexOf(tag, start + tag.length)) {
    const jsonStr = raw.slice(start + tag.length).trim()
    try {
      const parsed: unknown = JSON.parse(jsonStr)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const fields = Object.entries(parsed)
      if (!fields.length || fields.some(([key, value]) =>
        !['planted', 'collected'].includes(key) || !Array.isArray(value) ||
        value.some((item: unknown) => typeof item !== 'string')
      )) continue
      return { jsonStr, start, end: raw.length }
    } catch {
      // 引文里的标签或正文中途的 JSON 不是末尾回执，继续找下一个标签。
    }
  }
  return null
}

/**
 * 解析 LLM 在正文末尾写下的【本章伏笔回执】。
 * - 未找到合法末尾回执 → 返回 { receipt: null, stripped: 原文本 }，不删正文
 * - 找到且字段有效 → 返回 { receipt, stripped: 剥离末尾回执后的纯正文 }
 */
export function parseForeshadowReceipt(raw: string): {
  receipt: ForeshadowReceipt | null
  stripped: string
} {
  const empty = { receipt: null as ForeshadowReceipt | null, stripped: raw }
  const found = findReceiptJson(raw)
  if (!found) return empty
  const jsonStr = found.jsonStr.trim()
  // 只删除已验证的末尾回执，不顺带格式化正文。
  const stripped = raw.slice(0, found.start).trimEnd()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return empty
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

/* =========================================================
   章名命名（ChapterEditor 正文区 AI 起名 / 手动改名）
   解析与清洗工具函数，供 main 与 renderer 共享。
   ========================================================= */

/** 章名最大允许字符数。番茄章名规范 12-20 字，此处放宽到 50 兜底超长输入 */
export const CHAPTER_NAME_MAX_LEN = 50

/**
 * 去掉「第 N 章」/「第N章：」前缀。LLM 经常在 title 里夹带章号前缀，
 * 写回细纲/大纲时会出现「第 5 章：第 5 章：xxx」重复。
 * 支持阿拉伯数字 (1, 2, 3) 与中文数字 (一, 二, 三, 廿…) 两种章号。
 */
export function stripChapterPrefix(input: string): string {
  return input
    .replace(
      /^\s*第\s*(?:\d+|[一二三四五六七八九十百千两]+)\s*章\s*[:：]?\s*/,
      ''
    )
    .trim()
}

/**
 * 清洗候选章名：
 * 1. 去首尾空白 + 引号（"xxx" / "xxx" / 'xxx'）
 * 2. 去掉「第 N 章：」前缀
 * 3. 截断到 CHAPTER_NAME_MAX_LEN
 * 4. 纯空白返回 ''（调用方视为无效）
 */
export function sanitizeChapterName(input: string): string {
  if (!input) return ''
  let s = input.trim()
  // 去包裹引号
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim()
  // 去「第 N 章：」前缀
  s = stripChapterPrefix(s)
  // 二次清引号（多次包裹）
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!s) return ''
  if (s.length > CHAPTER_NAME_MAX_LEN) s = s.slice(0, CHAPTER_NAME_MAX_LEN).trim()
  return s
}

export interface ChapterNameCandidate {
  title: string
  /** LLM 给出的简短理由（可选） */
  reason: string
}

/**
 * 从 LLM 输出中解析章名 JSON。规则：
 * - 优先匹配 ```json ... ``` 代码块，否则匹配第一个 { ... } 块
 * - 必须有 title 字段且为非空字符串
 * - 解析失败 / title 缺失 / 净化后为空 → 返回 null（调用方应区分 ok=false）
 */
export function parseChapterNameJson(raw: string, _chapterNumber: number): ChapterNameCandidate | null {
  if (!raw || typeof raw !== 'string') return null
  let jsonStr: string | null = null
  // 1) 匹配 ```json ... ``` 代码块
  const codeBlock = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  if (codeBlock) jsonStr = codeBlock[1]
  // 2) 退化为第一个 { ... }（用栈式括号平衡，避免字符串内 '}' 误截断）
  if (!jsonStr) {
    const start = raw.indexOf('{')
    if (start < 0) return null
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          jsonStr = raw.slice(start, i + 1)
          break
        }
      }
    }
  }
  if (!jsonStr) return null
  let obj: unknown
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (typeof o.title !== 'string') return null
  const cleanTitle = sanitizeChapterName(o.title)
  if (!cleanTitle) return null
  const reason = typeof o.reason === 'string' ? o.reason.trim() : ''
  return { title: cleanTitle, reason }
}

export interface ChapterNameUserPromptInput {
  chapterNumber: number
  currentTitle: string
  draft: string
  /** user prompt 内草稿正文的最大字符数（避免 prompt 过长） */
  maxDraftChars?: number
}

/**
 * 章名命名 system prompt。注入：
 * 1. 番茄章名风格规范（TOMATO_CHAPTER_NAME_SPEC）
 * 2. 体裁语感（resolveGenreVoice）
 * 3. 严格 JSON 输出（title + reason）
 * 4. 12-20 字硬性规则
 *
 * 不依赖 Node API，可在 renderer 中使用。
 */
export function buildChapterNameSystemPrompt(
  genre: string | undefined,
  _style?: unknown
): string {
  // 复用与续写一致的体裁定位段落，便于模型语感对齐
  const voiceHeader = genre
    ? `本作品体裁：${genre}。请按对应语感命名。`
    : '本作品体裁未指定，请用通用网文番茄风格命名。'
  return [
    '你是番茄小说风格的资深网文编辑。任务：根据用户提供的章节正文（草稿），为该章起一个高度吸引点击的章名。',
    '',
    voiceHeader,
    '',
    TOMATO_CHAPTER_NAME_SPEC_TEXT,
    '',
    '【输出格式 · 严格 JSON】',
    '只输出一段 JSON，不要任何解释、markdown 代码块包裹、前后缀文字：',
    '{"title":"章名","reason":"一句简短理由（≤30字）"}',
    '',
    '【硬性规则】',
    '- title 仅含章名本体，不允许带「第 N 章」前缀（即使输入草稿里出现也要剥掉）。',
    '- title 必须 12-20 字（含标点），少于 12 字或多于 20 字都会被驳回。',
    '- reason 可选，30 字以内，缺失或非字符串都视为空。',
    '- 不允许标题里包含引号 / 括号 / 冒号 / 破折号 / emoji。'
  ].join('\n')
}

export function buildChapterNameUserPrompt(input: ChapterNameUserPromptInput): string {
  const max = input.maxDraftChars ?? 800
  const draftExcerpt = (input.draft || '').slice(0, max)
  const titleLine = input.currentTitle ? `当前标题：${input.currentTitle}` : '当前标题：（无）'
  return [
    `【任务】为第 ${input.chapterNumber} 章起一个番茄风格的章名。`,
    titleLine,
    '',
    '【本章草稿（节选）】',
    '```',
    draftExcerpt,
    '```',
    '',
    '请根据以上正文内容，输出严格的 JSON：{"title":"章名","reason":"一句简短理由"}',
    '不要输出任何额外文字。'
  ].join('\n')
}

// 复用番茄章名规范（嵌入到 system prompt）。直接嵌入字符串而非 import，
// 避免 shared/parsers.ts 被 main-only 依赖反向引用。
const TOMATO_CHAPTER_NAME_SPEC_TEXT = `
#### 🍅 番茄小说章名风格规范（强制）

**基础规格**：
- 字数 12-20 字（含标点），少于 12 字信息不足，多于 20 字移动端被截断
- 纯中文 + 适当标点（逗号/句号/问号/感叹号），禁用括号、冒号、破折号、井号、省略号、emoji
- 核心关键词在前 15 字内（读者扫读时前 15 字决定点击）

**标题四要素（缺一不可）**：
1. 含高流量关键词（重生/穿越/系统/打脸/逆袭/霸总/退婚/修仙等，按题材选）
2. 交代核心冲突（谁和谁/面对什么困境，不能只写情绪状态）
3. 含未完成信息点（悬念/反转/即将发生的危险，让读者产生"然后呢"）
4. 传递情绪基调（爽/虐/甜/惊/怒/悬，强烈不平淡）

**8 大爆款结构（按点击率排序）**：
1. 反差/反转型：\`A 以为 X，结果 Y\`
2. 打脸/反杀型：动作 + 对象 + 反差
3. 网梗/代入型：当下梗 + 关键意象
4. 悬念/钩子型：两个矛盾事实并列
5. 关系推进型：人物关系变化
6. 数字悬念型：数字 + 反差事件
7. 身份反差型：表面 vs 真实身份
8. 道具/场景型：具体物件 + 动作

**七禁七必自检**：
- 禁：>20字 / 抽象词（觉醒/突破/转折/启程/新生）/ 剧透 / 平铺 / 空洞 / 零信息 / 不带梗
- 必：12-20字 / 含具体人事物 / 至少2个对立元素 / 1个明确疑问 / 1种情绪色彩 / 匹配8大结构之一
`
