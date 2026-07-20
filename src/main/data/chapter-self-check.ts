/**
 * 写后自检：对照「写前/写后自检清单」用纯算法验正文。
 * 不调用 LLM，低成本、可单测；结果供 toast / 流程面板展示。
 * 类型定义见 shared/types（单一真相源）。
 */

import type {
  ChapterSelfCheckReport,
  PrevEndingState,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict,
  SettingsEvolutionEntry
} from '../../shared/types'
import type { SettingsContext } from './skill-format/settings-md-repo'
import { extractPowerBoundaryBullets } from './power-boundary'

export type {
  ChapterSelfCheckReport,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict
} from '../../shared/types'

export interface SelfCheckForeshadowInput {
  content: string
  status: string
  expectedCollect?: number
  plantChapter?: number
}

export interface ChapterSelfCheckInput {
  chapterNumber: number
  content: string
  prevEndingState?: PrevEndingState | null
  prevTail?: string
  plotSummary?: string
  hook?: string
  foreshadowings?: SelfCheckForeshadowInput[]
  /** 已抽取的金手指边界短句；空则尝试从 settings 再抽 */
  powerBoundaryBullets?: string[]
  settings?: SettingsContext | null
  settingsEvolution?: SettingsEvolutionEntry[]
  /** 卷内禁止提前的提示句（可选） */
  doNotAdvanceHints?: string[]
}

/** 兼容旧 import 路径 */
export { extractPowerBoundaryBullets, extractPowerBoundaryBulletsFromSettings } from './power-boundary'

/** 章末说教/AI 抒怀（与 chapter-audit 对齐的轻量子集） */
const ENDING_TABOO: Array<{ re: RegExp; reason: string }> = [
  { re: /才(刚|刚刚)开始/, reason: '章末 AI 味抒怀' },
  { re: /(也许|或许)这就是/, reason: '章末说教模板' },
  { re: /(这就是|就是)(命运|宿命)/, reason: '宿命论说教' },
  { re: /命运的齿轮/, reason: 'AI 套话' },
  { re: /故事.*?才(开始|刚刚)/, reason: 'AI 味结尾' }
]

const DIALOGUE_RE = /["'""「『][^"'""」』\n]{1,200}["'""」』]/
const EVENT_HINT_RE =
  /突然|猛地|骤然|忽然|出现|推开|冲|响起|传来|倒下|跪下|转身|伸手|抓住|门外|来人|声音|脚步/

/** 能力越权常见套话（相对「只能看当日/不能改命运」类边界） */
const POWER_OVERCLAIM_RE =
  /预知未来|看穿一生|看清终身|改变命运|逆天改命|注定的结局|未来三[年月日]|十年后必然|看透生死/

/**
 * 对正文执行写后自检，返回结构化报告。
 */
export function evaluateChapterSelfCheck(input: ChapterSelfCheckInput): ChapterSelfCheckReport {
  const content = (input.content ?? '').trim()
  const ch = input.chapterNumber
  const items: SelfCheckItemResult[] = []

  if (!content) {
    items.push({
      id: 'empty',
      category: 'structure',
      label: '正文非空',
      verdict: 'fail',
      detail: '正文为空，无法自检'
    })
    return finalize(ch, items)
  }

  // 1) 章末形态
  items.push(checkEndingForm(content))

  // 2) 章末说教
  items.push(checkEndingTaboo(content))

  // 3) 上章悬念
  if (input.prevEndingState?.suspense?.trim()) {
    items.push(
      checkKeywordPresence({
        id: 'prev_suspense',
        category: 'continuity',
        label: '上章悬念有回应迹象',
        source: input.prevEndingState.suspense,
        haystack: content.slice(0, Math.min(content.length, 2500)),
        failVerdict: 'warn',
        passDetail: '正文前部出现与上章悬念相关的词',
        failDetail: `未明显回应上章悬念「${clip(input.prevEndingState.suspense, 60)}」`
      })
    )
  }

  // 4) 未完成事项
  const unfinished = input.prevEndingState?.unfinished ?? []
  unfinished.slice(0, 5).forEach((u, i) => {
    if (!u?.trim()) return
    items.push(
      checkKeywordPresence({
        id: `unfinished_${i}`,
        category: 'continuity',
        label: '上章未完成事项',
        source: u,
        haystack: content,
        failVerdict: 'warn',
        passDetail: `可能已处理：${clip(u, 40)}`,
        failDetail: `可能未处理：${clip(u, 60)}`
      })
    )
  })

  // 5) 人物位置（弱信号）
  const positions = input.prevEndingState?.characterPositions ?? []
  if (positions.length > 0) {
    const locs = positions.map((p) => p.location).filter((x) => x && x.length >= 2)
    const head = content.slice(0, 800)
    const hit = locs.some((loc) => head.includes(loc))
    items.push({
      id: 'char_position',
      category: 'continuity',
      label: '人物位置连续',
      verdict: hit ? 'pass' : locs.length ? 'warn' : 'skip',
      detail: hit
        ? `开头附近出现上章地点（${locs.slice(0, 3).join('、')}）`
        : locs.length
          ? `开头未出现上章地点词（${locs.slice(0, 3).join('、')}），请人工确认是否瞬移`
          : '无位置信息'
    })
  }

  // 6) 本章核心事件
  if (input.plotSummary?.trim()) {
    items.push(
      checkKeywordPresence({
        id: 'core_plot',
        category: 'plot',
        label: '本章核心事件有落地',
        source: input.plotSummary,
        haystack: content,
        failVerdict: 'fail',
        minHits: 2,
        passDetail: '正文含核心事件关键词',
        failDetail: `正文几乎未覆盖核心事件「${clip(input.plotSummary, 80)}」`
      })
    )
  }

  // 7) 到期伏笔
  const fores = input.foreshadowings ?? []
  const due = fores.filter(
    (f) =>
      (f.status === 'planted' || f.status === '已埋设') && f.expectedCollect === ch
  )
  due.slice(0, 6).forEach((f, i) => {
    items.push(
      checkKeywordPresence({
        id: `due_fb_${i}`,
        category: 'foreshadow',
        label: '到期伏笔回收迹象',
        source: f.content,
        haystack: content,
        failVerdict: 'fail',
        minHits: 1,
        passDetail: `可能已回收：${clip(f.content, 40)}`,
        failDetail: `到期伏笔未见回收迹象：${clip(f.content, 60)}`
      })
    )
  })

  // 8) 未到期伏笔误爆（高命中 → warn）
  const notYet = fores.filter(
    (f) =>
      (f.status === 'planted' || f.status === '已埋设') &&
      f.expectedCollect != null &&
      f.expectedCollect > ch
  )
  notYet.slice(0, 5).forEach((f, i) => {
    const kws = extractKeywords(f.content)
    const hits = kws.filter((k) => content.includes(k)).length
    // 关键词很多且命中率高，可能提前揭穿
    const ratio = kws.length ? hits / kws.length : 0
    items.push({
      id: `early_fb_${i}`,
      category: 'foreshadow',
      label: '未到期伏笔未提前揭穿',
      verdict: kws.length < 2 ? 'skip' : ratio >= 0.6 && hits >= 3 ? 'warn' : 'pass',
      detail:
        kws.length < 2
          ? '伏笔过短，跳过'
          : ratio >= 0.6 && hits >= 3
            ? `可能提前涉及未到期伏笔「${clip(f.content, 40)}」（预计第 ${f.expectedCollect} 章）`
            : `未明显提前揭穿「${clip(f.content, 40)}」`
    })
  })

  // 9) 金手指越权套话
  const boundaries =
    input.powerBoundaryBullets && input.powerBoundaryBullets.length > 0
      ? input.powerBoundaryBullets
      : extractPowerBoundaryBullets(input.settings ?? null, input.settingsEvolution ?? [])
  items.push(checkPowerOverclaim(content, boundaries))

  // 10) 卷内禁抢写提示（弱）
  if (input.doNotAdvanceHints?.length) {
    let worst: SelfCheckItemResult | null = null
    for (const hint of input.doNotAdvanceHints.slice(0, 8)) {
      const kws = extractKeywords(hint).filter((k) => k.length >= 2)
      const hits = kws.filter((k) => content.includes(k)).length
      if (kws.length >= 3 && hits >= 3) {
        worst = {
          id: 'volume_spoiler',
          category: 'ban',
          label: '未抢写卷内后续大事件',
          verdict: 'warn',
          detail: `正文可能触及后续节点「${clip(hint, 50)}」`
        }
        break
      }
    }
    items.push(
      worst ?? {
        id: 'volume_spoiler',
        category: 'ban',
        label: '未抢写卷内后续大事件',
        verdict: 'pass',
        detail: '未明显命中卷内后续节点关键词'
      }
    )
  }

  // 11) 元叙述 / 章号泄露
  items.push(checkMetaNarration(content))

  return finalize(ch, items)
}

function finalize(chapterNumber: number, items: SelfCheckItemResult[]): ChapterSelfCheckReport {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const it of items) counts[it.verdict]++
  const ok = counts.fail === 0
  let summary: string
  if (items.length === 0) {
    summary = '写后自检：无检查项'
  } else if (counts.fail > 0) {
    const first = items.find((i) => i.verdict === 'fail')
    summary = `写后自检未通过：${counts.fail} 项失败${first ? `（${first.label}）` : ''}`
  } else if (counts.warn > 0) {
    summary = `写后自检通过（${counts.warn} 项需留意）`
  } else {
    summary = `写后自检通过（${counts.pass} 项）`
  }
  return {
    schemaVersion: 1,
    chapterNumber,
    generatedAt: new Date().toISOString(),
    counts,
    items,
    ok,
    summary
  }
}

function checkEndingForm(content: string): SelfCheckItemResult {
  const paras = content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const tail = paras.slice(-3).join('\n')
  const hasDialogue = DIALOGUE_RE.test(tail)
  const hasEvent = EVENT_HINT_RE.test(tail)
  const ok = hasDialogue || hasEvent
  return {
    id: 'ending_form',
    category: 'structure',
    label: '章末以对话或事件收束',
    verdict: ok ? 'pass' : 'fail',
    detail: ok
      ? hasDialogue
        ? '章末含对话'
        : '章末含事件/动作迹象'
      : '章末最后几段未见对话或事件钩子，可能是总结/心理收尾'
  }
}

function checkEndingTaboo(content: string): SelfCheckItemResult {
  const paras = content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const tail = paras.slice(-4).join('\n')
  for (const t of ENDING_TABOO) {
    if (t.re.test(tail)) {
      return {
        id: 'ending_taboo',
        category: 'structure',
        label: '章末无说教/AI 抒怀',
        verdict: 'fail',
        detail: t.reason
      }
    }
  }
  return {
    id: 'ending_taboo',
    category: 'structure',
    label: '章末无说教/AI 抒怀',
    verdict: 'pass',
    detail: '未命中说教模板'
  }
}

function checkPowerOverclaim(
  content: string,
  boundaries: string[]
): SelfCheckItemResult {
  const m = content.match(POWER_OVERCLAIM_RE)
  if (m) {
    return {
      id: 'power_bound',
      category: 'power',
      label: '金手指边界未明显越权',
      verdict: 'warn',
      detail: `正文出现可疑越权表述「${m[0]}」${
        boundaries[0] ? `；对照边界：${clip(boundaries[0], 40)}` : ''
      }`
    }
  }
  // 边界句含「不能X」且正文像在做 X（极弱）
  for (const b of boundaries.slice(0, 6)) {
    const neg = b.match(/(?:不能|无法|不可|禁止)([^，。；\n]{2,12})/)
    if (!neg) continue
    const forbidden = neg[1].replace(/[的了吗呢吧]/g, '').trim()
    if (forbidden.length >= 2 && content.includes(forbidden)) {
      // 若正文同时出现「不能/无法」则更像在遵守边界
      if (new RegExp(`(不能|无法|不可).{0,6}${escapeReg(forbidden)}`).test(content)) {
        continue
      }
      return {
        id: 'power_bound',
        category: 'power',
        label: '金手指边界未明显越权',
        verdict: 'warn',
        detail: `边界写「不能${forbidden}」，正文却出现该表述，请人工确认`
      }
    }
  }
  return {
    id: 'power_bound',
    category: 'power',
    label: '金手指边界未明显越权',
    verdict: boundaries.length ? 'pass' : 'skip',
    detail: boundaries.length ? '未命中常见越权套话' : '无金手指边界材料，跳过'
  }
}

function checkMetaNarration(content: string): SelfCheckItemResult {
  const tail = content.slice(-400)
  if (/第\s*\d+\s*章/.test(tail) || /下[一]?章见|未完待续|请看下回/.test(tail)) {
    return {
      id: 'meta_narration',
      category: 'ban',
      label: '章末无元叙述/章号泄露',
      verdict: 'warn',
      detail: '章末疑似出现章号或「下章见」类元叙述'
    }
  }
  return {
    id: 'meta_narration',
    category: 'ban',
    label: '章末无元叙述/章号泄露',
    verdict: 'pass',
    detail: '未见章末元叙述'
  }
}

function checkKeywordPresence(opts: {
  id: string
  category: SelfCheckCategory
  label: string
  source: string
  haystack: string
  failVerdict: 'fail' | 'warn'
  minHits?: number
  passDetail: string
  failDetail: string
}): SelfCheckItemResult {
  const kws = extractKeywords(opts.source)
  // 另取源句中的 2 字中文片（人名/地名常在此），避免长关键词过严
  const bigrams = extractBigrams(opts.source)
  const pool = uniqueStrings([...kws, ...bigrams])
  if (pool.length === 0) {
    return {
      id: opts.id,
      category: opts.category,
      label: opts.label,
      verdict: 'skip',
      detail: '无法从约束文本提取关键词'
    }
  }
  const hits = pool.filter((k) => opts.haystack.includes(k)).length
  const need = opts.minHits ?? 1
  // 至少命中 need 个；或长关键词整段命中 1 个也算过
  const longHit = kws.some((k) => k.length >= 4 && opts.haystack.includes(k))
  const ok = hits >= need || longHit
  return {
    id: opts.id,
    category: opts.category,
    label: opts.label,
    verdict: ok ? 'pass' : opts.failVerdict,
    detail: ok ? `${opts.passDetail}（命中 ${hits}/${pool.length}）` : opts.failDetail
  }
}

function extractBigrams(text: string): string[] {
  const compact = text.replace(/[^\u4e00-\u9fff]/g, '')
  const out: string[] = []
  for (let i = 0; i + 2 <= compact.length; i++) {
    const s = compact.slice(i, i + 2)
    if (/^(这个|那个|什么|怎么|可以|已经|自己|没有|不是|一个|一种)/.test(s)) continue
    out.push(s)
  }
  return uniqueStrings(out).slice(0, 10)
}

function uniqueStrings(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of arr) {
    if (!a || seen.has(a)) continue
    seen.add(a)
    out.push(a)
  }
  return out
}

/** 从中文短句抽关键词（长度 2–6 的片断 + 去停用） */
export function extractKeywords(text: string): string[] {
  const raw = text
    .replace(/[「」『』""'']/g, '')
    .replace(/[，。！？、；：,.!?;:\-—…（）()【】\[\]\s]/g, ' ')
    .trim()
  if (!raw) return []

  const stop = new Set(
    '的了吗呢吧啊呀在是有和与及或被把从对为上中下到这那我你他她它们一个一种'.split('')
  )
  const out: string[] = []
  const seen = new Set<string>()

  // 连续中文 2-4 字窗口
  const compact = raw.replace(/\s+/g, '')
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= compact.length; i++) {
      const slice = compact.slice(i, i + n)
      if (!/^[\u4e00-\u9fff]+$/.test(slice)) continue
      if ([...slice].every((c) => stop.has(c))) continue
      if (seen.has(slice)) continue
      // 跳过纯虚词组合
      if (/^(这个|那个|什么|怎么|可以|已经|自己|没有|不是)/.test(slice)) continue
      seen.add(slice)
      out.push(slice)
      if (out.length >= 12) return prioritizeKeywords(out)
    }
  }

  // 英文/数字 token
  for (const t of raw.split(/\s+/)) {
    if (/^[A-Za-z0-9]{3,}$/.test(t) && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return prioritizeKeywords(out)
}

/** 更长的词优先，去被包含的短词 */
function prioritizeKeywords(kws: string[]): string[] {
  const sorted = [...kws].sort((a, b) => b.length - a.length)
  const kept: string[] = []
  for (const k of sorted) {
    if (kept.some((x) => x.includes(k) && x !== k)) continue
    kept.push(k)
    if (kept.length >= 8) break
  }
  return kept
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
