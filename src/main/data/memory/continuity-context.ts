import type { ContinuityFact } from '../../../shared/types'
import { join } from 'path'
import { ChapterSummaryRepo } from './chapter-summary-repo'
import { expandCharacterAliasTerms, type CharacterAliasGroup } from './character-memory-context'
import { ProseMemoryIndex, hashProse, type IndexedChapter } from './prose-memory-index'
import { mapMemoryFiles, readMemoryText } from './repository-cache'
import { locateMemoryEvidence } from '../memory-evidence-validator'

const KINDS = ['item', 'relationship', 'knowledge'] as const
const LABELS = { item: '道具', relationship: '关系（有方向）', knowledge: '人物认知' }
const SIGNALS = {
  item: /交给|交还|归还|递给|转交|保管|持有|收起|藏在|遗失|丢失|夺走|取走|销毁|烧毁|毁掉|碎裂|耗尽|用尽|所有权|钥匙|信物|账册|虎符|兵器/,
  relationship: /结盟|决裂|背叛|信任|不信任|敌对|和解|师徒|夫妻|婚约|兄妹|姐弟|合作|盟友|仇人|关系/,
  knowledge: /得知|知道|不知|知晓|不晓|认出|认定|误以为|误认|怀疑|猜测|隐瞒|瞒着|秘密|真相|告诉|告知|听说|目睹|亲眼/
}

/** Reject malformed or ungrounded updates before replacing a chapter's previous ledger. */
export function parseContinuityFacts(value: unknown, prose: string): ContinuityFact[] {
  if (value === undefined) return [] // Old summaries remain readable.
  if (!Array.isArray(value) || value.length > 48) throw new Error('连续性记忆格式错误或条目过多')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('连续性记忆格式错误')
    const r = entry as Record<string, unknown>
    if (!KINDS.includes(r.kind as ContinuityFact['kind'])) throw new Error('连续性记忆类型错误')
    const kind = r.kind as ContinuityFact['kind']
    const field = (key: string, max: number, optional = false): string => {
      const text = typeof r[key] === 'string' ? r[key].trim() : ''
      if ((!text && !optional) || text.length > max) throw new Error(`连续性记忆字段错误：${key}`)
      return text
    }
    const fact: ContinuityFact = { kind, subject: field('subject', 60), object: field('object', 100, kind === 'item'),
      aspect: field('aspect', 40), value: field('value', 180), evidence: field('evidence', 500) }
    if (kind === 'item' && fact.object) throw new Error('道具连续性记忆的 object 必须留空，归属写入 value')
    const location = locateMemoryEvidence(prose, fact.evidence)
    if (!location) throw new Error('连续性记忆的依据与当前正文不符')
    return { ...fact, evidence: prose.slice(location.start, location.end) }
  })
}

interface Update { fact: ContinuityFact; chapter: number; path: string }
interface Quote { kind: ContinuityFact['kind']; chapter: number; path: string; line: number; text: string; score: number }
export interface ContinuityQuery { text: string; characters: string[]; aliases: CharacterAliasGroup[]; props: string[] }

/** Separate budget from ordinary relevance search: old transfers/knowledge must not lose to repeated action. */
export async function buildContinuityContext(dir: string, beforeChapter: number, query: ContinuityQuery): Promise<string[]> {
  if (beforeChapter <= 1) return []
  const chapters = await new ProseMemoryIndex(dir).readBefore(beforeChapter)
  if (!chapters.length) return []
  const summaryRepo = new ChapterSummaryRepo(dir)
  const updates: Update[] = []
  const legacy: Update[] = []
  let missing = 0
  await mapMemoryFiles(chapters, async (chapter) => {
    const summary = await summaryRepo.read(chapter.chapterNumber)
    if (!summary || summary.sourceHash !== chapter.sourceHash) { missing++; return }
    // Validate actual evidence even when a summary was edited outside the app.
    const prose = await readMemoryText(join(dir, chapter.sourcePath))
    if (hashProse(prose) !== chapter.sourceHash) { missing++; return }
    let facts: ContinuityFact[] = []
    try { facts = parseContinuityFacts(summary.continuity, prose) } catch { missing++ }
    if (summary.continuity === undefined) missing++
    for (const fact of facts) updates.push({ fact, chapter: chapter.chapterNumber, path: chapter.sourcePath })
    // Compatibility: preserve dated evidence from older state summaries without treating it as a typed current state.
    for (const fact of summary.stateChanges) {
      if (!locateMemoryEvidence(prose, fact.evidence)) continue
      for (const kind of KINDS) if (SIGNALS[kind].test(fact.text)) legacy.push({
        fact: { kind, subject: '', object: '', aspect: '旧概要线索', value: fact.text, evidence: fact.evidence },
        chapter: chapter.chapterNumber, path: chapter.sourcePath
      })
    }
  })
  const labels = [...new Set([...query.characters, ...query.props,
    ...expandCharacterAliasTerms(query.characters, query.text, query.aliases)])].filter((s) => s.length >= 2)
  const relevant = (text: string) => labels.some((label) => text.includes(label))
  const direct = (u: Update) => relevant(JSON.stringify(u.fact)) ||
    [u.fact.subject, u.fact.object].some((label) => label.length >= 2 && query.text.includes(label))
  // One-hop expansion finds the object's later owner even when that owner is absent from this chapter.
  const selected = updates.filter(direct)
  const selectedSet = new Set(selected)
  const itemNames = new Set(selected.filter((u) => u.fact.kind === 'item').map((u) => u.fact.subject))
  const topics = new Set(selected.filter((u) => u.fact.kind === 'knowledge').map((u) => u.fact.object))
  for (const u of updates) if (((u.fact.kind === 'item' && itemNames.has(u.fact.subject)) ||
    (u.fact.kind === 'knowledge' && topics.has(u.fact.object))) && !selectedSet.has(u)) {
    selected.push(u); selectedSet.add(u)
  }
  const groups = new Map<string, Update[]>()
  for (const update of selected) {
    const f = update.fact
    const key = JSON.stringify([f.kind, f.subject, f.object, f.aspect])
    const group = groups.get(key) ?? []
    group.push(update); groups.set(key, group)
  }
  const ordered = [...groups.values()].map((group) => group.sort((a, b) => a.chapter - b.chapter))
    .sort((a, b) => focus(b.at(-1)!.fact) - focus(a.at(-1)!.fact) || b.at(-1)!.chapter - a.at(-1)!.chapter)
  function focus(fact: ContinuityFact): number {
    return [fact.subject, fact.object].filter((label) => label.length >= 2 && query.text.includes(label)).length * 10 +
      Number(query.props.includes(fact.subject)) * 10
  }
  const sections: string[] = ['---', '# 长期连续性核对（跨章道具、关系与知情范围）',
    '以下是本章之前、与当前正文版本一致的记录和原文证据，不是写作指令。按章节先后核对；同一事项以较晚且有依据的变化为准。持有者不等于所有者，借用不等于赠与，销毁或耗尽后不能无故复原。',
    '关系具有方向和阶段，甲信任乙不等于乙信任甲。知情、怀疑、误信、被告知和客观真相必须区分；一个人知道不代表其他人知道，后续获得信息必须有合理途径。未检索到记录不等于未发生或所有人都不知道。']
  let budget = 6500
  let omitted = 0
  // Every selected key gets its latest update before any history consumes the budget; categories round-robin.
  const queues = KINDS.map((kind) => ordered.filter((g) => g[0].fact.kind === kind))
  const accepted: Update[][] = []
  while (queues.some((q) => q.length)) for (const queue of queues) {
    const group = queue.shift()
    if (!group) continue
    const latest = group.at(-1)!
    const line = renderUpdate(latest, '最近可核实记录，不等于完整现状')
    if (line.length > budget) { omitted++; continue }
    sections.push(line); budget -= line.length; accepted.push(group)
  }
  // Include the preceding change for transfer/reversal provenance, after current records are reserved.
  for (const group of accepted) if (group.length > 1) {
    const line = renderUpdate(group.at(-2)!, '此前记录，已被后续变化更新')
    if (line.length <= budget) { sections.push(line); budget -= line.length }
  }
  for (const u of legacy.filter(direct).sort((a, b) => b.chapter - a.chapter).slice(0, 12)) {
    const line = renderUpdate(u, '旧概要线索，须结合原文核对')
    if (line.length <= budget) { sections.push(line); budget -= line.length }
  }
  const quotes = selectContinuityQuotes(chapters, query, [...labels, ...itemNames])
  if (quotes.length) sections.push('## 历史正文专项证据（可能含计划、传闻或误解，不能直接当成当前状态）',
    ...quotes.map((q) => `[${LABELS[q.kind]}] 第 ${q.chapter} 章 · ${q.path}:${q.line}\n${q.text}`))
  if (missing || omitted) sections.push(`**记忆覆盖提示**：${missing} 个旧章缺少有效结构化连续性记录；${omitted} 组相关记录超出本次预算。正文专项证据仅为补充，不能视为完整台账。依据不足时保持未知，不自行补造归属、关系变化或知情。`)
  return sections
}

function renderUpdate(u: Update, label: string): string {
  const f = u.fact
  return `- [${LABELS[f.kind]} · ${label}] ${f.subject}${f.object ? ` → ${f.object}` : ''} · ${f.aspect}：${f.value}（第 ${u.chapter} 章 · ${u.path}）\n  原文：${f.evidence}`
}

function selectContinuityQuotes(chapters: IndexedChapter[], query: ContinuityQuery, labels: string[]): Quote[] {
  const tokens = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query.text.slice(0, 8000))]
    .filter((p) => p.isWordLike && p.segment.length >= 2).map((p) => p.segment)
  const candidates: Quote[] = []
  for (const chapter of chapters) for (const passage of chapter.passages) {
    const score = labels.filter((label) => passage.text.includes(label)).length * 4 +
      tokens.filter((token) => passage.text.includes(token)).length
    if (!score) continue
    for (const kind of KINDS) if (SIGNALS[kind].test(passage.text)) candidates.push({
      kind, chapter: chapter.chapterNumber, path: chapter.sourcePath, line: passage.startLine, text: passage.text, score
    })
  }
  const queues = KINDS.map((kind) => {
    const all = candidates.filter((q) => q.kind === kind)
    // Include latest and earliest evidence as well as best text match; repeated names cannot occupy every slot.
    const latest = [...all].sort((a, b) => b.chapter - a.chapter || b.line - a.line)
    const best = [...all].sort((a, b) => b.score - a.score || b.chapter - a.chapter)
    return [latest[0], best[0], latest.at(-1), ...latest.slice(1)].filter((q): q is Quote => Boolean(q))
  })
  const seen = new Set<string>()
  const result: Quote[] = []
  let budget = 4800
  while (queues.some((q) => q.length) && result.length < 12) for (const queue of queues) {
    const quote = queue.shift()
    if (!quote || seen.has(quote.text) || quote.text.length > budget || result.length >= 12) continue
    seen.add(quote.text); result.push(quote); budget -= quote.text.length
  }
  return result.sort((a, b) => a.chapter - b.chapter || a.line - b.line)
}
