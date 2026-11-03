/**
 * 确定性道具材质漂移比对：同一中心词、不同材质前缀（铜牌→木牌）。
 * 基准自动来自前文正文、主线计划和道具卡（如有），不需要人工建档。
 * 只产出提示交给长篇核对确认，不直接判错：候选可能是有依据的独立物件或自然简称。
 */

export interface ItemDriftHint { known: string; token: string; head: string }

/** 单字材质/质地前缀；多字材质（玻璃、水晶、青铜）暂不覆盖。 */
const MATERIAL_MODIFIERS = [...'金银铜铁钢锡铅木石玉珠瓷陶竹纸布绢绸麻藤皮革骨角蜡漆']
const MATERIAL_HEAD = new RegExp(`([${MATERIAL_MODIFIERS.join('')}])([\\u4e00-\\u9fff])`, 'g')

/** 后随汉字视为更长词的一部分（木牌匾、铜钱串），不算本章的独立出现。 */
function standalone(token: string, text: string, at: number): boolean {
  const next = text[at + token.length]
  return next === undefined || !/[\u4e00-\u9fff]/.test(next)
}

export function findItemMaterialDrift(input: {
  content: string
  /** 道具卡名（可选增强，通常是自动提取落盘的结果）。 */
  knownItems?: string[]
  plan?: string
  priorText?: string
  limit?: number
}): ItemDriftHint[] {
  const { content, knownItems = [], plan = '', priorText = '', limit = 6 } = input
  // 只有本章新出现的「材质+名词」二字组合才需要与历史对照；先扫正文，避免整本小说白扫。
  const candidates = [...new Set([...content.matchAll(MATERIAL_HEAD)]
    .filter(m => standalone(m[0], content, m.index!)).map(m => m[0]))]
  if (!candidates.length) return []
  const cardByHead = new Map<string, string>()
  for (const name of knownItems) {
    if (name.length < 2 || name.length > 3) continue
    const head = name.at(-1)!
    if (!cardByHead.has(head)) cardByHead.set(head, name)
  }
  // 前文与计划整体只扫一遍，收集其中出现过的同类二字组合作为既定词。
  const established = new Set([...(priorText + '\n' + plan).matchAll(MATERIAL_HEAD)].map(m => m[0]))
  const hints = new Map<string, ItemDriftHint>()
  for (const token of candidates) {
    if (established.has(token) || knownItems.includes(token)) continue
    const head = token[1]
    const card = cardByHead.get(head)
    if (card && content.includes(card)) continue
    let known = card
    let sameHeadInContent = false
    for (const k of established) {
      if (k[1] !== head) continue
      if (content.includes(k)) { sameHeadInContent = true; break }
      if (!known) known = k
    }
    // 本章已出现同头物件（道具卡或历史词）时，候选视为并列的新物件而不是漂移。
    if (sameHeadInContent) continue
    if (!known) continue
    if (!hints.has(token)) hints.set(token, { known, token, head })
    if (hints.size >= limit) return [...hints.values()]
  }
  return [...hints.values()]
}

export function renderItemDriftHints(hints: ItemDriftHint[]): string[] {
  return hints.map(h => `本章出现「${h.token}」，而既有依据中的「${h.known}」未在本章出现；两者同为「${h.head}」类物件、仅材质前缀不同。请核对是否同一物件被写错材质或名称；若「${h.token}」是有前文或计划依据的独立物件（含自然简称），属误报，不要写入 findings。`)
}
