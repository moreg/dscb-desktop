export interface ReviewSuggestion {
  quote: string
  /** 可直接替换 quote 的成品写法（来自「改写」标签）。缺失时回退到 advice 走校验。 */
  rewrite?: string
  /** 来自「建议」标签的内容（旧格式或 LLM 未遵守「改写」时）。可能是成品也可能是描述说明。 */
  advice: string
  why: string
}

const LABELS = ['原文', '改写', '建议', '理由'] as const

/** 行首标签：可选中英文括号包裹的「原文/改写/建议/理由」+ 全/半角冒号。
 *  用 (?:^|\n) 锚定，只认每段行首的标签，避免把建议正文里出现的"建议""原文"等词误判为新字段。 */
const LABEL_RE = /(?:^|\n)[ \t]*[【\[]?\s*(原文|改写|建议|理由)\s*[】\]]?[ \t]*[：:][ \t]*/g

/** 去掉值首尾成对的引号/括号（LLM 常把"改写：「xxx」"里的值也包一层），避免面板出现重复书名号。
 *  仅当这对引号确实是整体包裹（内部不再出现同类闭括号）时才剥离，否则保留原样——
 *  否则会把「（补一句）（结尾）」误剥成「补一句）（结尾」，破坏正文。 */
function unwrapQuotes(s: string): string {
  const t = s.trim()
  const pairs: [string, string][] = [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['‘', '’'],
    ['（', '）'],
    ['(', ')']
  ]
  for (const [a, b] of pairs) {
    if (t.length < a.length + b.length || !t.startsWith(a) || !t.endsWith(b)) continue
    // 内部不应再出现同一个闭括号，否则首尾的开/闭并不属于同一对。
    if (t.slice(a.length, t.length - b.length).includes(b)) continue
    return t.slice(a.length, t.length - b.length).trim()
  }
  return t
}

/** 把 LLM 输出的"原文：… 改写：… 理由：…"标签格式解析成结构化建议。
 *  兼容旧格式（只有「建议」没有「改写」）。流式友好：先按标签分词再按「原文」边界归组——
 *  这样即使 LLM 在两条建议之间没留空行、或字段顺序打乱，也不会把多条合并成一条导致字段错位。 */
export function parseSuggestions(text: string): ReviewSuggestion[] {
  if (!text) return []
  // 1) 扫描所有行首标签及其取值区间（取值 = 标签冒号后到下一个标签之前）。
  const tokens: { label: string; index: number; valueStart: number; valueEnd: number }[] = []
  let m: RegExpExecArray | null
  LABEL_RE.lastIndex = 0
  while ((m = LABEL_RE.exec(text)) !== null) {
    tokens.push({
      label: m[1],
      index: m.index,
      valueStart: m.index + m[0].length,
      valueEnd: text.length
    })
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    // 取值截至下一个标签（含其前导换行/空白），保证不串进下一条建议。
    tokens[i].valueEnd = tokens[i + 1].index
  }

  // 2) 第一个标签之前的文本（前言/总结）作为一条不可应用的建议保留，避免丢失内容。
  const out: ReviewSuggestion[] = []
  if (tokens.length > 0 && tokens[0].index > 0) {
    const intro = text.slice(0, tokens[0].index).trim()
    if (intro) out.push({ quote: '', rewrite: undefined, advice: '', why: intro })
  }

  // 3) 按「原文」边界归组：遇到一个新的「原文」就开一条新建议，
  //    同一组内的 改写/建议/理由 填到当前建议上；字段重复或缺失时也不会错位。
  let cur: ReviewSuggestion | null = null
  const flush = () => {
    if (cur && (cur.quote || cur.rewrite || cur.advice || cur.why)) out.push(cur)
    cur = null
  }
  for (const tk of tokens) {
    const raw = unwrapQuotes(text.slice(tk.valueStart, tk.valueEnd))
    if (tk.label === '原文') {
      flush()
      cur = { quote: raw, advice: '', why: '' }
    } else {
      if (!cur) cur = { quote: '', advice: '', why: '' }
      if (tk.label === '改写') cur.rewrite = raw || undefined
      else if (tk.label === '建议') cur.advice = raw
      else if (tk.label === '理由') cur.why = raw
    }
  }
  flush()

  // 4) 完全无标签的整段（只有前言/总结）：归到 why 当说明，不进入 advice，避免被当成可应用建议。
  if (out.length === 0) {
    const intro = text.trim()
    if (intro) out.push({ quote: '', rewrite: undefined, advice: '', why: intro })
  }
  return out
}

/** 元语言措辞：成品替换句几乎不会以这些词开头。
 *  只锚定行首，避免误伤对白/叙述里合法出现的"不要""此处""这一段"等词。
 *  命中即判定为"该怎么改"的描述说明，而非可直接替换的成品。 */
const INSTRUCTION_PREFIX = /^(把|将|改为|换成|应该|可以|建议|请|需要|拆到|拆成|拆开|放到|放在|挪到|挪开|删掉|删除|加上|改成|调整|重写|让|不要|避免|注意|保持)/
const INSTRUCTION_PATTERN = /^(独立成句|放在.*之前|拆到.*下一句|用.*代替)/

export interface RewritableCheck {
  ok: boolean
  reason?: string
}

/** 判断候选文本是否可作为成品直接替换正文中的 quote。
 *  candidate 通常来自 rewrite，回退时来自 advice。 */
export function isRewritable(candidate: string | undefined, quote: string): RewritableCheck {
  if (!candidate || !candidate.trim()) {
    return { ok: false, reason: '该建议未给出可直接替换的成品，仅作说明参考。' }
  }
  if (!quote) {
    return { ok: false, reason: '此建议无匹配原文，无法自动应用。' }
  }
  const text = candidate.trim()
  if (INSTRUCTION_PREFIX.test(text) || INSTRUCTION_PATTERN.test(text)) {
    return { ok: false, reason: '该建议像是"该怎么改"的说明，而非可直接替换的成品，已拦截自动应用。可复制说明后手动修改。' }
  }
  return { ok: true }
}

/** 取一条建议的"应用候选"：优先 rewrite，回退 advice。 */
export function applyCandidate(s: ReviewSuggestion): string | undefined {
  return s.rewrite ?? s.advice
}

/** 给一组建议计算各自在 draft 中应替换/聚焦的位置。
 *  同 quote 多条建议按列表顺序依次匹配 draft 中的下一处，避免都指向 indexOf 首处。
 *  已应用建议（appliedIndexes）在 draft 中已被替换，pos = -1 且不参与位置消费——
 *  下一条同 quote 建议从 cursor 0 重新匹配，自然滑动到剩余的首处。
 *  返回数组与 suggestions 下标对齐；quote 为空、已应用或正文匹配数不够时返回 -1。 */
export function computeSuggestionPositions(
  suggestions: ReviewSuggestion[],
  draft: string,
  appliedIndexes?: ReadonlySet<number>
): number[] {
  const positions: number[] = []
  const cursors = new Map<string, number>()
  suggestions.forEach((s, i) => {
    if (!s.quote || appliedIndexes?.has(i)) {
      positions.push(-1)
      return
    }
    const start = cursors.get(s.quote) ?? 0
    const pos = draft.indexOf(s.quote, start)
    positions.push(pos)
    if (pos !== -1) cursors.set(s.quote, pos + 1)
  })
  return positions
}

/** AI 改稿建议在 rewriteHistory 中使用的 violationKey 前缀。
 *  与 audit 面板的 violationKey（category:word:offset）共用一个命名空间，
 *  靠前缀区分来源，避免误判。 */
const REVIEW_KEY_PREFIX = 'ai-review-'
const REVIEW_KEY_RE = new RegExp(`^${REVIEW_KEY_PREFIX}(\\d+)-`)

/** 构造 AI 改稿建议的 violationKey。 */
export function buildReviewKey(index: number, pos: number): string {
  return `${REVIEW_KEY_PREFIX}${index}-${pos}`
}

/** 判断一个 violationKey 是否来自 AI 改稿建议。 */
export function isReviewKey(key: string): boolean {
  return key.startsWith(REVIEW_KEY_PREFIX)
}

/** 从 violationKey 解析出建议序号；非 AI 改稿来源返回 null。 */
export function parseReviewIndex(key: string): number | null {
  const m = REVIEW_KEY_RE.exec(key)
  return m ? Number(m[1]) : null
}
