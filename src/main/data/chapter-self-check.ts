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
import { TOXIC_PATTERNS } from './deslop/banned-words'

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
  /** 实际回收章号：以经过核验的记忆或作者记录为准 */
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
   * 仅提供篇幅参考；写不满时提醒核实情节，不因字数少强制扩写。
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
  unfinished.forEach((u, i) => {
    if (!u?.trim()) return
    items.push(
      checkKeywordPresence({
        id: `unfinished_${i}`,
        category: 'continuity',
        label: '上章未完成事项',
        source: u,
        haystack: content,
        failVerdict: 'warn',
        passDetail: `出现事项相关文字，尚需核实处理结果：${clip(u, 40)}`,
        failDetail: `可能未处理：${clip(u, 60)}`
      })
    )
  })

  // 5) 人物位置（弱信号）
  const positions = input.prevEndingState?.characterPositions ?? []
  if (positions.length > 0) {
    const head = content.slice(0, 800)
    const clauses = head.split(/[。！？!?，,；;\r\n]+/).map((s) => s.trim()).filter(Boolean)
    const checkable = positions.filter((p) => p.name?.trim() && p.location?.length >= 2)
    const uncertain = checkable.filter((p) => {
      const first = clauses.findIndex((s) => s.includes(p.name))
      if (first < 0) return true
      const own = clauses[first]
      if (/不在|没在|并非|尚未|想起|听说|望向|看向|打算|计划/.test(own)) return true
      // 不能借用同句另一个角色的地点；只认本人的明确位置描述。
      const hasOther = checkable.some((other) => other.name !== p.name && own.includes(other.name))
      if (!hasOther && isLocationMentioned(p.location, own) &&
          /(?:站在|坐在|身处|位于|守在|留在|待在|蹲在|靠在|就在|仍在|在)/.test(own)) return false
      // 场景先行句可提供地点，前提是没有其他人物/移动动作介入。
      const scene = clauses[first - 1]
      return !scene || hasOther || checkable.some((other) => scene.includes(other.name)) ||
        /走向|赶往|离开|回到|前往|远处|想起|听说|望向/.test(scene) ||
        !isLocationMentioned(p.location, scene)
    })
    items.push({
      id: 'char_position',
      category: 'continuity',
      label: '人物位置对应线索',
      verdict: !checkable.length ? 'skip' : uncertain.length ? 'warn' : 'pass',
      detail: !checkable.length ? '缺少可对应的人物或地点，未核验位置连续性'
        : uncertain.length
          ? `无法确认人物与上章地点的对应：${uncertain.map((p) => `${p.name}—${p.location}`).join('、')}；核对转场或交给深度审稿，不能只凭地点出现判通过`
          : '开头有人物与原地点对应的文字线索；本项不核验转场时间与全过程'
    })
  }

  // 6) 本章核心事件
  if (input.plotSummary?.trim()) {
    items.push(checkCorePlot(content, input.plotSummary))
  }

  // 7) 到期伏笔（含「模型回执自称本章已回收」的，见 isDueForeshadow）
  const fores = input.foreshadowings ?? []
  const due = fores.filter((f) => isDueForeshadow(f, ch))
  due.forEach((f, i) => {
    items.push(checkForeshadowRecovery(f, i, ch, content))
  })

  // 8) 未到期伏笔误爆（高命中 → warn）
  const notYet = fores.filter(
    (f) =>
      PLANTED_STATUSES.has(f.status) &&
      f.expectedCollect != null &&
      f.expectedCollect > ch
  )
  notYet.forEach((f, i) => {
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
    for (const hint of input.doNotAdvanceHints) {
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

  // 写完即查的 AI 痕迹。只放语料实测有正向判别力的两条，见 tests/fixtures/deslop-corpus/FINDINGS.md
  items.push(checkPunctuationRule(content))
  items.push(checkAiTells(content))

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
    label: '本章核心事件文字痕迹（非完成核验）',
    repairKind: 'verify_plot' as const
  }
  const clauses = splitEventClauses(plotSummary).filter(isCheckableClause)
  if (clauses.length === 0) {
    return { ...base, verdict: 'skip', detail: '核心事件句无可判定的关键词' }
  }
  const missing = clauses.filter((c) => !isClauseCovered(c, content))
  const uncertain = clauses.filter((c) => hasUnresolvedUnfinishedMention(c, content))
  const hit = clauses.length - missing.length
  const coverage = hit / clauses.length
  const scale = `${hit}/${clauses.length}`
  if (coverage >= CORE_PLOT_PASS_COVERAGE && uncertain.length === 0) {
    return {
      ...base,
      verdict: 'pass',
      detail: missing.length
        ? `相关文字痕迹 ${scale}，下列要点未见明确叙述；关键词不能证明事件完成，请核对行动与结果`
        : `相关文字痕迹 ${scale}；关键词不能证明事件完成，请核对行动、结果与因果关系`,
      ...(missing.length ? { missing } : {})
    }
  }
  return {
    ...base,
    verdict: uncertain.length ? 'warn' : coverage < CORE_PLOT_FAIL_COVERAGE ? 'fail' : 'warn',
    detail: uncertain.length
      ? `相关要点有否定、疑问、计划或尚未完成的表述，其他提及不足以解除疑问，不能判为已落实；可确认文字痕迹 ${scale}，请核对实际行动与结果`
      : `相关文字痕迹 ${scale}，下列要点未找到；先核对同义表述与情节结果，避免按关键词机械补写`,
    missing
  }
}

const PLANTED_STATUSES = new Set(['planted', 'reinforced', 'partial', '已埋设', '已强化', '强化', '部分回收'])
const COLLECTED_STATUSES = new Set(['collected', '已回收'])

/**
 * 本章要验的伏笔：到期未收的，**以及回执自称本章刚回收的**。
 *
 * 也核对既有/导入的本章回收记录，防止错误的已回收状态把检查关闭。
 */
function isDueForeshadow(f: SelfCheckForeshadowInput, ch: number): boolean {
  if (f.plantChapter != null && f.plantChapter > ch) return false
  if (PLANTED_STATUSES.has(f.status) && f.expectedCollect != null && f.expectedCollect <= ch) return true
  return COLLECTED_STATUSES.has(f.status) && f.actualCollect === ch
}

/**
 * 到期伏笔是否在正文里有回收痕迹。
 *
 * 关键词只提供线索，不足以证明核心疑问已解决。到期未推进只提醒；
 * 本章记录已回收但完全无对应文字才判失败，语义结论交由正文证据核验。
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
    label: claimed ? '伏笔回收待核实' : '到期伏笔推进待核对',
    repairKind: 'verify_foreshadow' as const
  }
  const clauses = splitEventClauses(f.content).filter(isCheckableClause)
  if (clauses.length === 0) {
    return { ...base, verdict: 'skip', detail: '伏笔内容无可判定的关键词' }
  }
  const missing = clauses.filter((c) => !isClauseCovered(c, content))
  if (missing.length < clauses.length) {
    return {
      ...base,
      verdict: 'warn',
      detail: claimed
        ? `回执称本章回收，但关键词只能证明提及，不能确认核心疑问已解决：${clip(f.content, 40)}`
        : `正文有相关线索，需区分强化、部分揭示与完整回收：${clip(f.content, 40)}`,
      ...(missing.length ? { missing } : {})
    }
  }
  return {
    ...base,
    verdict: claimed ? 'fail' : 'warn',
    detail: claimed
      ? `回执声称本章已回收（伏笔库状态已被改写），但正文未见回收迹象：${clip(f.content, 60)}`
      : `到期伏笔未见推进迹象，可核对后续安排或合理延期，不必强行揭底：${clip(f.content, 60)}`,
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

/** 篇幅参考线：低于目标 5% 内不提醒，不以字数判失败 */
const WORD_COUNT_PASS_RATIO = 0.95
/** 上限口径下超出多少才提示 */
const WORD_COUNT_OVER_RATIO = 1.15

/**
 * 篇幅参考检查，剧情与收束完整优先，字数不足不判失败。
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
      repairKind: 'over_length',
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
      repairKind: 'short_length',
      label: '篇幅参考',
      verdict: 'pass',
      detail: `实际 ${actual} 字 / ${source}参考 ${targetWords} 字；字数不代表剧情完整或质量合格`
    }
  }
  // 篇幅是参考，不能用硬性失败驱动模型机械补字；剧情完整优先。
  return {
    id: 'word_count',
    category: 'structure',
    repairKind: 'short_length',
    label: '篇幅参考',
    verdict: 'warn',
    detail: `实际 ${actual} 字，比${source}参考 ${targetWords} 字少 ${gap} 字（${Math.round(ratio * 100)}%）；以剧情完整为先，事件与收束已完成可提前结束，不要为凑字机械扩写`
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
    if (counts.skip > 0) summary += `；${counts.skip} 项未检查`
  } else if (counts.skip > 0) {
    summary = `写后自检完成（通过 ${counts.pass} 项${counts.warn ? `，${counts.warn} 项需留意` : ''}，${counts.skip} 项未检查）`
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
  // 保留原字符位置再截尾，避免长对白被删后把章中旁白带进检查范围。
  // 对白中的「比赛才刚开始」等属于人物发言，不能据此判断旁白说教。
  const narrative = content.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g,
    (speech) => speech.replace(/[^\r\n]/g, ' '))
  const tail = narrative.slice(-600)
  for (const t of ENDING_TABOO) {
    const match = tail.match(t.re)
    if (match) {
      return {
        id: 'ending_taboo',
        category: 'structure',
        label: '章末无说教/AI 抒怀',
        verdict: 'warn',
        detail: `章末旁白出现「${match[0]}」（${t.reason}），请结合语境核对，不凭套话判定正文失败`
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
  const m = findAffirmativePowerMention(content, POWER_OVERCLAIM_RE)
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
  for (const b of boundaries) {
    const neg = b.match(/(?:不能|无法|不可|禁止)([^，。；\n]{2,12})/)
    if (!neg) continue
    const forbidden = neg[1].replace(/[的了吗呢吧]/g, '').trim()
    if (forbidden.length >= 2 && findAffirmativePowerMention(content, new RegExp(escapeReg(forbidden)))) {
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

/** 每次能力表述分别核对局部前缀；一处否定不能豁免另一处实际施展。 */
function findAffirmativePowerMention(content: string, pattern: RegExp): RegExpMatchArray | undefined {
  for (const clause of content.split(/[。！？!?，,；;\r\n]+/)) {
    const matches = [...clause.matchAll(new RegExp(pattern.source, 'g'))]
    for (const [index, match] of matches.entries()) {
      const previousEnd = index > 0 ? matches[index - 1].index! + matches[index - 1][0].length : 0
      // 只看本次命中之前、上一次能力表述之后的短语，防止远处否定词串过来。
      const prefix = clause.slice(Math.max(previousEnd, match.index! - 16), match.index)
      // 只接受直接否定能力，或「没有能力」「无法真正」等受限连接。
      // 「没有犹豫便控制天气」「并非凡人所以能够控制天气」都在实际施展能力。
      if (/(?:不能|无法|不可|禁止|不可能|没能|未能|不曾|从未|并非|尚未|没有|不会|不具备)(?:真的?|真正|直接|完全|随意|任意|轻易|长期|继续|再次|再|去|够|能够|做到|拥有|使用|具备|实现|使出|获得|学会|掌握|能力|本领|本事|神通|手段|权限|办法|的){0,4}$/.test(prefix)) continue
      return match
    }
  }
  return undefined
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

/**
 * 标点守则自检：正文里的破折号 / 省略号。
 *
 * **这不是 AI 味判断，是指令遵守检查。** 写作守则第 9 条明写禁用这两样，
 * 出现即模型没照做。而且它是确定性可修的——deslop 的 normalize-punctuation
 * 会把 ——/— 和 ……/… 直接替换成句号/逗号，不需要走 LLM 改写。
 *
 * 顺带一提，语料实测它同时也是最强的单一 AI 信号（AUC 0.639，真人稿中位 0 处，
 * 自产 AI 稿中位 6.3 处/万字）。但对自己的稿子，「像不像 AI」这个信息没有用，
 * 「哪几行要改」才有用，所以这条按守则违规呈现，不按痕迹检测呈现。
 */
function checkPunctuationRule(content: string): SelfCheckItemResult {
  const id = 'punctuation_rule'
  const label = '标点守则（破折号/省略号）'
  const lines: number[] = []
  content.split(/\r?\n/).forEach((line, i) => {
    if (/——|—|--|……|…/.test(line)) lines.push(i + 1)
  })
  if (lines.length === 0) {
    return { id, category: 'ban', label, verdict: 'pass', detail: '正文无破折号/省略号' }
  }
  return {
    id,
    category: 'ban',
    label,
    verdict: 'warn',
    detail:
      `${lines.length} 处（第 ${formatLines(lines)} 行）。守则第 9 条禁用；` +
      '改成句号、逗号或动作断句。这是确定性替换，「去 AI 味」的标点兜底可直接改掉，不必调 LLM'
  }
}

/**
 * AI 痕迹自检：写完即查，纯算法零 token。
 *
 * **只查道具停止式**（「手里的算盘停了」「他的手一顿」）。这是 19 篇番茄真人稿
 * vs 19 篇未润色自产 AI 稿实测下来，全系统唯一一条 AI 命中多于真人的规则：
 * 7:0，命中 5/19 篇 AI 稿、0/19 篇真人稿。
 *
 * **刻意不查**禁用词密度（AUC 0.097，方向相反：真人用得比 AI 多 6.5 倍）、
 * 三个结构均匀度 CV（0.285–0.486，无判别力）、「不是A而是B」（0.428，反向）。
 * 把那些加进来只会天天报在自己的稿子上。理由见 tests/fixtures/deslop-corpus/FINDINGS.md。
 *
 * 也刻意不把它写进写作 prompt 的负向清单：一旦写进去生成端就会规避，这条指标随即失效
 * （词表整层就是这么废掉的）。留它只在检测端存在，才能持续当指标用。
 */
function checkAiTells(content: string): SelfCheckItemResult {
  const id = 'ai_tells'
  const label = 'AI 痕迹（道具停止式）'
  const handRe = TOXIC_PATTERNS.find((p) => p.id === 'hand_stops')?.re
  const lines: number[] = []
  if (handRe) {
    content.split(/\r?\n/).forEach((line, i) => {
      if (new RegExp(handRe.source).test(line)) lines.push(i + 1)
    })
  }
  if (lines.length === 0) {
    return { id, category: 'ban', label, verdict: 'pass', detail: '未见道具停止式' }
  }
  return {
    id,
    category: 'ban',
    label,
    verdict: 'warn',
    detail: `${lines.length} 处（第 ${formatLines(lines)} 行）。改成具体的失误或速率变化（算珠拨过了头 / 算盘打得更快），或直接删掉`
  }
}

/** 行号列表：最多列 6 个，多的折叠成「等 N 处」，避免长章刷屏 */
function formatLines(lines: number[]): string {
  if (lines.length <= 6) return lines.join('、')
  return `${lines.slice(0, 6).join('、')} 等 ${lines.length} 处`
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
  if (ok && !hasUnresolvedUnfinishedMention(opts.source, opts.haystack)) {
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

/** 本项只能寻找文字痕迹；否定、愿望或计划不能算实际事件的证据。 */
function isClauseCovered(clause: string, haystack: string): boolean {
  const mentions = matchingEventSentences(clause, haystack)
  return mentions.some((m) => !m.unfinished) && !hasUnresolvedMentions(mentions)
}

const UNFINISHED_EVENT_RE = /没有|没能|未能|从未|尚未|还未|并未|未曾|未(?=取得|救出|完成|实现|找到|拿到)|没(?=取得|救出|完成|找到)|不曾|不可能|如果|假如|要是|但愿|希望能|计划|打算|准备(?:去|要|将)?|想要|想过|考虑|试图|正要|将要|明天|以后|日后|尚需|仍需/

interface EventMention {
  score: number
  unfinished: boolean
}

function matchingEventSentences(clause: string, haystack: string): EventMention[] {
  const normalize = (text: string): string => text.replace(/终于|已经|成功|最终|确实|后来|了/g, '')
  const { long, short } = clauseFragments(normalize(clause))
  const mentions: EventMention[] = []
  // 逗号后的计划或否定常属于另一个动作，不能污染逗号前已经完成的事件。
  for (const raw of haystack.split(/(?<=[。！？!?，,；;\r\n])/)) {
    const sentence = normalize(raw)
    // 比较覆盖度时忽略否定/计划词本身，否则「林舟没有取得」会比「林舟取得」少命中，
    // 导致明确否定天然处于劣势。是否否定仍由原分句判定。
    const comparison = sentence.replace(new RegExp(UNFINISHED_EVENT_RE.source, 'g'), '')
    const longHits = long.filter((k) => comparison.includes(k))
    const shortHits = short.filter((k) => comparison.includes(k))
    if (longHits.length === 0 && shortHits.length < 2) continue
    const hits = [...longHits, ...shortHits]
    const rawHits = hits.filter((k) => sentence.includes(k))
    const evidenceEnd = rawHits.length
      ? Math.max(...rawHits.map((k) => sentence.lastIndexOf(k) + k.length)) : sentence.length
    mentions.push({
      score: longHits.length * 2 + shortHits.length,
      // 相关动作之后的「没有停留」等不反过来否定动作本身。
      // 保留疑问标点，询问是否取得不能覆盖前面明确的「没有取得」。
      unfinished: /[？?]\s*$|是否|能否|有没有|会不会|是不是/.test(sentence) ||
        hasUnfinishedEventEvidence(sentence.slice(0, evidenceEnd), [...long, ...short])
    })
  }
  return mentions
}

function hasUnfinishedEventEvidence(sentence: string, fragments: string[]): boolean {
  for (const marker of sentence.matchAll(new RegExp(UNFINISHED_EVENT_RE.source, 'g'))) {
    if (!/^(?:没有|没能|未能|从未|尚未|还未|并未|未曾|未|没|不曾|不可能)$/.test(marker[0])) return true
    const after = sentence.slice(marker.index! + marker[0].length)
      .replace(/^(?:真正|直接|完全|随意|任意|轻易|继续|再次|再|去|能够|做到|拥有|学会|掌握|能力|办法|机会|的|会){0,4}/, '')
    // 否定必须直接约束目标事件；「没有犹豫便取得」否定的是犹豫。
    if (fragments.some((fragment) => after.startsWith(fragment))) return true
  }
  return false
}

function hasUnresolvedMentions(mentions: EventMention[]): boolean {
  // 覆盖最完整的证据优先，同等覆盖度取最后一次表述。
  // 重复物品名不能洗掉明确否定；后续关于物品的其他计划也不能冲掉已完成动作。
  // 这仍只是文字证据，不是语义完成核验。
  let strongest: EventMention | undefined
  for (const mention of mentions) {
    if (!strongest || mention.score >= strongest.score) strongest = mention
  }
  return strongest?.unfinished === true
}

function hasUnresolvedUnfinishedMention(clause: string, haystack: string): boolean {
  return hasUnresolvedMentions(matchingEventSentences(clause, haystack))
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
