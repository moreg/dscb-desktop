export interface ReviewSuggestion {
  quote: string
  /** 可直接替换 quote 的成品写法（来自「改写」标签）。缺失时回退到 advice 走校验。 */
  rewrite?: string
  /** 来自「建议」标签的内容（旧格式或 LLM 未遵守「改写」时）。可能是成品也可能是描述说明。 */
  advice: string
  why: string
}

const LABELS = ['原文', '改写', '建议', '理由'] as const
const LABEL_ALT = '[【\\[\\]】]?'
const LABEL_LOOKAHEAD = LABELS.join('|')

/** 把 LLM 输出的"原文：… 改写：… 理由：…"标签格式解析成结构化建议。
 *  兼容旧格式（只有「建议」没有「改写」）。流式友好：按空行分块，已闭合字段即可解析。 */
export function parseSuggestions(text: string): ReviewSuggestion[] {
  const blocks = text.split(/\n{2,}/)
  const out: ReviewSuggestion[] = []
  for (const b of blocks) {
    if (!b.trim()) continue
    const find = (label: string) => {
      const re = new RegExp(
        `${LABEL_ALT}\\s*${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n${LABEL_ALT}\\s*(?:${LABEL_LOOKAHEAD})|$)`
      )
      const m = b.match(re)
      return m ? m[1].trim() : ''
    }
    const quote = find('原文')
    const rewrite = find('改写')
    const advice = find('建议')
    const why = find('理由')
    if (quote || rewrite || advice || why) {
      out.push({ quote, rewrite: rewrite || undefined, advice, why })
    } else {
      // 完全无标签的段落（前言/总结）：归到 why 当说明，不进入 advice，避免被当成可应用建议。
      out.push({ quote: '', rewrite: undefined, advice: '', why: b.trim() })
    }
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
