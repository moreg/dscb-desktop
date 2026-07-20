/**
 * 「按要求重写」修改建议中的落笔要点解析。
 * 纯函数：从 AI 方案文案里抽出可勾选条目，并组装确认后的落笔方案。
 */

export interface AdjustPlanCheckItem {
  id: string
  text: string
}

/**
 * 列表行：- / * / • / 1. / 1) / 1、 / (1) / （1）
 * 中文编号后常无空格（「1、删旁白」），故数字/括号标记后用 \s*；
 * 符号标记仍要求空白，避免把「-foo」当列表。
 */
const LIST_ITEM_RE =
  /^\s*(?:(?:[-*•+]\s+)|(?:\d{1,2}[.)、]\s*)|(?:[(（]\d{1,2}[)）]\s*))(.+?)\s*$/

/** 常见「落笔要点」标题（宽松匹配） */
const ACTION_HEADING_RE = /^#{1,3}\s*落笔要点\s*$/i
const SUGGESTION_HEADING_RE = /^#{1,3}\s*修改建议\s*$/i
const ANY_HEADING_RE = /^#{1,3}\s+\S/

/**
 * 截取某个 markdown 二级/三级标题下的正文块，直到下一个同级或更高级标题。
 * 找不到返回 null。
 */
export function extractMarkdownSection(
  plan: string,
  headingTest: (line: string) => boolean
): string | null {
  const lines = plan.replace(/\r\n/g, '\n').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headingTest(lines[i].trim())) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim()
    if (ANY_HEADING_RE.test(t) && !LIST_ITEM_RE.test(t)) break
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text || null
}

/** 从一段文本中解析列表条目（只取单行列表项） */
export function parseListItemLines(block: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of block.replace(/\r\n/g, '\n').split('\n')) {
    const m = LIST_ITEM_RE.exec(raw)
    if (!m) continue
    const text = m[1].replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2) continue
    // 去重（忽略首尾空白）
    const key = text
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/**
 * 从完整修改建议中抽出可勾选的落笔条目。
 * 优先级：
 * 1. 「## 落笔要点」下的列表
 * 2. 「## 修改建议」下的列表
 * 3. 全文所有列表项（至少 2 条才采用，避免误抓）
 */
export function parseAdjustPlanItems(plan: string): AdjustPlanCheckItem[] {
  const trimmed = plan?.trim() ?? ''
  if (!trimmed) return []

  const fromAction = extractMarkdownSection(trimmed, (l) => ACTION_HEADING_RE.test(l))
  let texts = fromAction ? parseListItemLines(fromAction) : []

  if (texts.length === 0) {
    const fromSuggest = extractMarkdownSection(trimmed, (l) => SUGGESTION_HEADING_RE.test(l))
    texts = fromSuggest ? parseListItemLines(fromSuggest) : []
  }

  if (texts.length === 0) {
    const all = parseListItemLines(trimmed)
    // 全文列表往往混有输出要求示例；只有明显多条才当作条目
    if (all.length >= 2) texts = all
  }

  return texts.map((text, i) => ({
    id: `item-${i}`,
    text
  }))
}

/**
 * 根据用户勾选组装落笔时传给模型的 confirmedPlan。
 * 明确约束：只执行勾选条目。
 */
export function buildConfirmedPlanFromSelection(
  fullPlan: string,
  selectedTexts: readonly string[]
): string {
  const selected = selectedTexts.map((t) => t.trim()).filter(Boolean)
  if (selected.length === 0) return ''

  const lines = [
    '## 用户勾选的落笔要点（仅执行以下条目；未勾选条目一律不要改）',
    ...selected.map((t, i) => `${i + 1}. ${t}`),
    '',
    '**硬性约束**：只落实上方编号条目。完整建议里出现但未勾选的内容，禁止改动对应正文。'
  ]

  const plan = fullPlan.trim()
  if (plan) {
    lines.push('', '## 完整修改建议（仅供理解上下文；未勾选条目禁止执行）', plan)
  }
  return lines.join('\n')
}

/** 从勾选状态数组取出已选文案 */
export function selectedPlanTexts(
  items: readonly { text: string; checked: boolean }[]
): string[] {
  return items.filter((x) => x.checked).map((x) => x.text)
}
