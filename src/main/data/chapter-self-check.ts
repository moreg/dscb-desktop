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
  /** 实际回收章号：模型写的伏笔回执会把状态置为已回收并填这个 */
  actualCollect?: number
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
  /**
   * 整章目标字数（细纲「字数预估」口径）。给了才跑字数项。
   * 分轮续写的中间轮里这项失败是正常的——它被登记为完成度项，会被降级为「待写完」。
   */
  targetWords?: number
  /** 目标字数是否真的来自细纲；false 表示是兜底值，字数项只提示不判死 */
  targetFromOutline?: boolean
  /**
   * 细纲字数的语义（口径与 shared/word-target.ts 同源）：
   * - 'min'：目标/下限，写不够才是问题（默认）
   * - 'about'：上限口径（「不超过 3000 字」「3000 字以内」），写不够**不是**问题，写超了才提示
   * 不传按 'min'。丢掉这个字段会把「上限」当「下限」判死。
   */
  targetBound?: 'min' | 'about'
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

  // 1) 章末说教（已去掉「章末必须对话/事件收束」形态检查，避免误伤正常心理/总结收尾）
  items.push(checkEndingTaboo(content))

  // 1.5) 上章结尾状态缺失：显式记一条 skip
  // 结尾状态是只读缓存（本次会话写过本章才有）。拿不到时下面三项整条不进报告，
  // counts/ok 就在更小的集合上算，面板只显示「通过 N」——用户无从知道有三项压根没跑。
  if (ch > 1 && !input.prevEndingState) {
    items.push({
      id: 'prev_state_missing',
      category: 'continuity',
      label: '上章衔接三项（悬念/未完成/人物位置）',
      verdict: 'skip',
      detail: input.prevTail?.trim()
        ? '未缓存上章结尾状态（本次会话没写过本章正文），这三项未执行——不等于通过'
        : '没有上一章正文，无法做衔接检查'
    })
  }

  // 2) 上章悬念
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
    const hit = locs.some((loc) => isLocationMentioned(loc, head))
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
    items.push(checkCorePlot(content, input.plotSummary))
  }

  // 7) 到期伏笔（含「模型回执自称本章已回收」的，见 isDueForeshadow）
  const fores = input.foreshadowings ?? []
  const due = fores.filter((f) => isDueForeshadow(f, ch))
  due.slice(0, 6).forEach((f, i) => {
    items.push(checkForeshadowRecovery(f, i, ch, content))
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

  // 12) 篇幅达标（对照细纲「字数预估」）
  if (input.targetWords && input.targetWords > 0) {
    items.push(
      checkWordCount(
        content,
        input.targetWords,
        input.targetFromOutline !== false,
        input.targetBound ?? 'min'
      )
    )
  }

  return finalize(ch, items)
}

/**
 * 核心事件覆盖率阈值（按「子事件」逐条判定，不是整句一刀切）。
 * 细纲的核心事件句通常写成「A；B；C」，逐条判定才能说清到底哪一条没落地。
 */
const CORE_PLOT_PASS_COVERAGE = 2 / 3
const CORE_PLOT_FAIL_COVERAGE = 1 / 3

/**
 * 本章核心事件是否落地：把细纲核心事件句切成子事件，逐条看正文有没有对应痕迹。
 *
 * 旧实现把整句丢进 checkKeywordPresence 做全局关键词计数，而抽词只覆盖到句首十来个字，
 * 于是「后半句一个字没写」照样通过、「前半句换了同义说法」照样判死——用户按自检改完正文
 * 仍是同一条失败，正是这个原因。
 */
function checkCorePlot(content: string, plotSummary: string): SelfCheckItemResult {
  const base = {
    id: 'core_plot',
    category: 'plot' as SelfCheckCategory,
    label: '本章核心事件有落地'
  }
  const clauses = splitEventClauses(plotSummary).filter(isCheckableClause)
  if (clauses.length === 0) {
    return { ...base, verdict: 'skip', detail: '核心事件句无可判定的关键词' }
  }
  const missing = clauses.filter((c) => !isClauseCovered(c, content))
  const hit = clauses.length - missing.length
  const coverage = hit / clauses.length
  const scale = `${hit}/${clauses.length}`
  if (coverage >= CORE_PLOT_PASS_COVERAGE) {
    return {
      ...base,
      verdict: 'pass',
      detail: missing.length
        ? `核心事件要点覆盖 ${scale}，仅下列未见落地`
        : `核心事件要点全部覆盖（${scale}）`,
      ...(missing.length ? { missing } : {})
    }
  }
  return {
    ...base,
    verdict: coverage < CORE_PLOT_FAIL_COVERAGE ? 'fail' : 'warn',
    detail: `核心事件要点只覆盖 ${scale}，下列要点在正文里找不到落地痕迹`,
    missing
  }
}

const PLANTED_STATUSES = new Set(['planted', '已埋设'])
const COLLECTED_STATUSES = new Set(['collected', '已回收'])

/**
 * 本章要验的伏笔：到期未收的，**以及回执自称本章刚回收的**。
 *
 * 续写完成时会按模型写的【本章伏笔回执】把状态改成 collected；若这里只筛 planted，
 * 模型只要在回执里声称回收（正文里一个字没写），就能把检查它的这一项关掉。
 */
function isDueForeshadow(f: SelfCheckForeshadowInput, ch: number): boolean {
  if (PLANTED_STATUSES.has(f.status) && f.expectedCollect === ch) return true
  return COLLECTED_STATUSES.has(f.status) && f.actualCollect === ch
}

/**
 * 到期伏笔是否在正文里有回收痕迹。
 *
 * 判定用子事件口径（1 个 ≥3 字片段，或 2 个 2 字片段），不再是「命中池子里任意 1 个片段」——
 * 那个口径下正文随便出现个人名就算「已回收」，而这是一条 fail 级检查，假通过比假失败更伤。
 */
function checkForeshadowRecovery(
  f: SelfCheckForeshadowInput,
  index: number,
  ch: number,
  content: string
): SelfCheckItemResult {
  const claimed = COLLECTED_STATUSES.has(f.status) && f.actualCollect === ch
  const base = {
    id: `due_fb_${index}`,
    category: 'foreshadow' as SelfCheckCategory,
    label: claimed ? '伏笔回执与正文一致' : '到期伏笔回收迹象'
  }
  const clauses = splitEventClauses(f.content).filter(isCheckableClause)
  if (clauses.length === 0) {
    return { ...base, verdict: 'skip', detail: '伏笔内容无可判定的关键词' }
  }
  const missing = clauses.filter((c) => !isClauseCovered(c, content))
  if (missing.length < clauses.length) {
    return {
      ...base,
      verdict: 'pass',
      detail: claimed
        ? `回执称本章回收，正文有对应痕迹：${clip(f.content, 40)}`
        : `可能已回收：${clip(f.content, 40)}`
    }
  }
  return {
    ...base,
    verdict: 'fail',
    detail: claimed
      ? `回执声称本章已回收（伏笔库状态已被改写），但正文未见回收迹象：${clip(f.content, 60)}`
      : `到期伏笔未见回收迹象：${clip(f.content, 60)}`,
    ...(clauses.length >= 2 ? { missing } : {})
  }
}

/** 「附近」「旁边」这类到处都是的词，不能拿来当地点命中的证据 */
const GENERIC_PLACE_RE = /^(附近|旁边|里面|外面|上面|下面|中间|周围|一带|地方|这里|那里)$/

/**
 * 上章地点是否被提到。
 *
 * 结尾状态里的 location 是 LLM 提取的带限定语串（如「空沙滩（潮线附近）」），
 * 整串 includes 永远匹配不上——这项此前几乎恒 warn。改成按片段匹配核心地名。
 */
function isLocationMentioned(loc: string, haystack: string): boolean {
  const { long, short } = clauseFragments(loc)
  if (long.some((k) => haystack.includes(k))) return true
  return short.some((k) => !GENERIC_PLACE_RE.test(k) && haystack.includes(k))
}

/** 达标线：低于目标 5% 内算通过，低于 20% 判失败 */
const WORD_COUNT_PASS_RATIO = 0.95
const WORD_COUNT_FAIL_RATIO = 0.8
/** 上限口径下超出多少才提示 */
const WORD_COUNT_OVER_RATIO = 1.15

/**
 * 篇幅达标检查。
 *
 * 模型算不准中文字数，写不够是常态；此前全链路没有任何地方核对过实际字数
 * （审稿的 word_count 提醒已废弃、自检也没有这一项），于是写少了根本没人发现。
 *
 * bound='about' 是上限口径（细纲写「不超过 3000 字」「3000 字以内」）：写不够不是问题，
 * 写超了才提示。写正文的 prompt 一直认这个口径，自检以前不认，于是听话写少的章被判死。
 */
function checkWordCount(
  content: string,
  targetWords: number,
  fromOutline: boolean,
  bound: 'min' | 'about' = 'min'
): SelfCheckItemResult {
  const actual = content.replace(/\s/g, '').length
  const ratio = actual / targetWords
  const gap = targetWords - actual
  const source = fromOutline ? '细纲' : '默认'
  if (bound === 'about') {
    const over = actual - targetWords
    return {
      id: 'word_count',
      category: 'structure',
      label: '篇幅符合细纲上限',
      verdict: ratio > WORD_COUNT_OVER_RATIO ? 'warn' : 'pass',
      detail:
        ratio > WORD_COUNT_OVER_RATIO
          ? `实际 ${actual} 字，超出${source}上限 ${targetWords} 字 ${over} 字（${Math.round(ratio * 100)}%）`
          : `实际 ${actual} 字 / ${source}上限 ${targetWords} 字（上限口径，写不满不算问题）`
    }
  }
  if (ratio >= WORD_COUNT_PASS_RATIO) {
    return {
      id: 'word_count',
      category: 'structure',
      label: '篇幅达到细纲目标',
      verdict: 'pass',
      detail: `实际 ${actual} 字 / ${source}目标 ${targetWords} 字`
    }
  }
  // 兜底目标（细纲没写字数）只提示不判死：这个数不是作者定的
  const verdict: SelfCheckItemResult['verdict'] =
    ratio < WORD_COUNT_FAIL_RATIO && fromOutline ? 'fail' : 'warn'
  return {
    id: 'word_count',
    category: 'structure',
    label: '篇幅达到细纲目标',
    verdict,
    detail: `实际 ${actual} 字，比${source}目标 ${targetWords} 字少 ${gap} 字（${Math.round(ratio * 100)}%）`
  }
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
  if (ok) {
    return {
      id: opts.id,
      category: opts.category,
      label: opts.label,
      verdict: 'pass',
      detail: `${opts.passDetail}（命中 ${hits}/${pool.length}）`
    }
  }
  // 未通过时点名「哪几个子事件没找到」，供「按自检改正文」把靶子交给模型。
  // 单子事件的约束句（多数伏笔/悬念）不列——failDetail 已经把整句说清了。
  const clauses = splitEventClauses(opts.source).filter(isCheckableClause)
  const missing =
    clauses.length >= 2 ? clauses.filter((c) => !isClauseCovered(c, opts.haystack)) : []
  return {
    id: opts.id,
    category: opts.category,
    label: opts.label,
    verdict: opts.failVerdict,
    detail: opts.failDetail,
    ...(missing.length ? { missing } : {})
  }
}

/** 关键词池上限：抽词跨全句轮流取名额，不再被句首吃满 */
const KEYWORD_POOL_LIMIT = 16
const BIGRAM_POOL_LIMIT = 12
/** 保留的关键词条数（更长优先） */
const KEYWORD_KEEP = 10

/**
 * 强分隔：句末与分号，切出「子事件」。
 * 顿号/斜杠/括号不切——它们多是同一子事件内的并列枚举（如「团建/商务/安保」）。
 */
const STRONG_CLAUSE_SEP_RE = /[。；;！!？?\n\r]+/
/** 弱分隔：过长的子事件再按逗号切一刀，避免一条里裹着两件事 */
const WEAK_CLAUSE_SEP_RE = /[，,]+/
const CLAUSE_SPLIT_THRESHOLD = 24

/** 中文连续段（U+4E00–U+9FFF） */
const CJK_RUN_RE = /[一-鿿]+/g
/** 细纲里的编号类元信息（FB-016 / CH12），正文不可能出现，不参与判定 */
const META_TOKEN_RE = /^[A-Za-z]{1,6}[-_]?\d{2,}$/
const STOP_CHARS = new Set(
  '的了吗呢吧啊呀在是有和与及或被把从对为上中下到这那我你他她它们个种'.split('')
)
const FILLER_RE =
  /^(这个|那个|什么|怎么|可以|已经|自己|没有|不是|一个|一种|以及|然后|接着|随后|于是)/

/**
 * 把一句约束文本切成「子事件」，保持原顺序。
 * 命中判定与关键词抽取都以子事件为单位，保证整句每一段都被覆盖到，
 * 而不是像旧实现那样只用到开头十来个字。
 */
export function splitEventClauses(text: string): string[] {
  const out: string[] = []
  for (const strong of (text ?? '').split(STRONG_CLAUSE_SEP_RE)) {
    const s = strong.trim()
    if (!s) continue
    if (s.length <= CLAUSE_SPLIT_THRESHOLD) {
      out.push(s)
      continue
    }
    for (const weak of s.split(WEAK_CLAUSE_SEP_RE)) {
      const w = weak.trim()
      if (w) out.push(w)
    }
  }
  return out
}

interface ClauseFragments {
  /** 3 字以上片段：命中 1 个即认定该子事件落地 */
  long: string[]
  /** 2 字片段（人名/地名常在此）：命中 2 个才算落地 */
  short: string[]
}

/**
 * 抽子事件内的可匹配片段。
 * 4 字窗口按步长 2 铺满整个中文连续段并补上结尾窗口，句尾同样有代表片段。
 */
function clauseFragments(clause: string): ClauseFragments {
  const long: string[] = []
  const short: string[] = []
  for (const run of clause.match(CJK_RUN_RE) ?? []) {
    if (run.length < 2) continue
    if (run.length <= 4) {
      if (run.length >= 3 && !isFiller(run)) long.push(run)
    } else {
      for (let i = 0; i + 4 <= run.length; i += 2) {
        const s = run.slice(i, i + 4)
        if (!isFiller(s)) long.push(s)
      }
      const tail = run.slice(-4)
      if (!isFiller(tail)) long.push(tail)
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const s = run.slice(i, i + 2)
      if (!isFiller(s)) short.push(s)
    }
  }
  for (const t of clause.match(/[A-Za-z0-9]{2,}/g) ?? []) {
    if (t.length < 3 || META_TOKEN_RE.test(t) || !/[A-Za-z]/.test(t)) continue
    long.push(t)
  }
  return { long: uniqueStrings(long), short: uniqueStrings(short) }
}

function isFiller(s: string): boolean {
  if (FILLER_RE.test(s)) return true
  return [...s].every((c) => STOP_CHARS.has(c))
}

/** 该子事件是否有可匹配内容（纯编号/单字的元信息条目不计入分母） */
function isCheckableClause(clause: string): boolean {
  const f = clauseFragments(clause)
  return f.long.length > 0 || f.short.length > 0
}

/** 该子事件在正文里是否有落地痕迹 */
function isClauseCovered(clause: string, haystack: string): boolean {
  const { long, short } = clauseFragments(clause)
  if (long.some((k) => haystack.includes(k))) return true
  return short.filter((k) => haystack.includes(k)).length >= 2
}

/** 2 字片段池（人名/地名常在此），跨子事件轮流取 */
function extractBigrams(text: string): string[] {
  return roundRobin(
    splitEventClauses(text).map((c) => clauseFragments(c).short),
    BIGRAM_POOL_LIMIT
  )
}

/** 各子事件轮流出一个，保证名额被整句均分而不是被第一个子事件吃满 */
function roundRobin(groups: string[][], limit: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let idx = 0; out.length < limit; idx++) {
    let advanced = false
    for (const g of groups) {
      const v = g[idx]
      if (v === undefined) continue
      advanced = true
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
      if (out.length >= limit) break
    }
    if (!advanced) break
  }
  return out
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

/**
 * 从中文短句抽关键词（3 字以上片段），按子事件轮流取名额。
 *
 * 旧实现从句首起滑 4 字窗口、凑满 12 个就返回，抽出来的永远是开头十来个字的
 * 重叠片段——后半句在任何检查里都等于不存在。
 */
export function extractKeywords(text: string): string[] {
  const clauses = splitEventClauses(text)
  if (clauses.length === 0) return []
  const pool = roundRobin(
    clauses.map((c) => clauseFragments(c).long),
    KEYWORD_POOL_LIMIT
  )
  return prioritizeKeywords(pool)
}

/** 更长的词优先，去被包含的短词 */
function prioritizeKeywords(kws: string[]): string[] {
  const sorted = [...kws].sort((a, b) => b.length - a.length)
  const kept: string[] = []
  for (const k of sorted) {
    if (kept.some((x) => x.includes(k) && x !== k)) continue
    kept.push(k)
    if (kept.length >= KEYWORD_KEEP) break
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
