/**
 * 将写后自检报告转为「临时写作要求 / 按要求重写」指令文本。
 * 纯函数，供流程面板一键填入、单测共用。
 */

import type {
  ChapterSelfCheckReport,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict
} from './types'

const CATEGORY_LABEL: Record<SelfCheckCategory, string> = {
  continuity: '衔接',
  plot: '剧情',
  foreshadow: '伏笔',
  power: '金手指',
  structure: '结构',
  ban: '禁项'
}

export type SelfCheckRequirementsMode = 'rewrite' | 'continue'

export interface BuildSelfCheckRequirementsOptions {
  /** rewrite：按要求重写正文；continue：续写时的临时要求 */
  mode?: SelfCheckRequirementsMode
  /** 纳入 fail + warn（默认）或仅 fail */
  includeWarn?: boolean
  /** 最多条数（默认 12） */
  maxItems?: number
  chapterNumber?: number
  /**
   * 本章仍在分轮续写中（extend），正文是**故意没写完**的半成品。
   * 此时「核心事件未完成」「到期伏笔未回收」这类完成度检查必然失败，
   * 原样灌成"必须"级要求等于逼模型下一轮把整章的活全干完——与分轮续写的意图相反。
   * 置 true 时这些项降级为"后续"，其余项（衔接/禁项/金手指等）照常。
   */
  partialChapter?: boolean
}

/**
 * 完成度类检查项：只有整章写完才有意义。
 * 分轮续写的中间轮里，它们失败是正常状态，不是缺陷。
 * 自检面板复用它给这些项打「待写完」标，两处判定必须同源。
 */
export function isCompletenessItem(id: string): boolean {
  return id === 'core_plot' || id === 'word_count' || id.startsWith('due_fb_')
}

function isOverLengthItem(item: SelfCheckItemResult): boolean {
  return item.repairKind === 'over_length' ||
    (!item.repairKind && item.id === 'word_count' && /上限/.test(item.label) && /超出/.test(item.detail))
}

/** 超限需要核对压缩，即使章节尚未完成也不能当成「以后补写」项。 */
export function isDeferredSelfCheckItem(item: SelfCheckItemResult): boolean {
  return isCompletenessItem(item.id) && !isOverLengthItem(item)
}

/**
 * 从自检报告生成可执行的写作约束文本。
 * 无问题项时返回空串。
 */
export function buildTempRequirementsFromSelfCheck(
  report: ChapterSelfCheckReport | null | undefined,
  opts: BuildSelfCheckRequirementsOptions = {}
): string {
  if (!report?.items?.length) return ''

  const includeWarn = opts.includeWarn !== false
  const maxItems = opts.maxItems ?? 12
  const mode = opts.mode ?? 'rewrite'
  const ch = opts.chapterNumber ?? report.chapterNumber

  // partial 下完成度项排到最后：本次要落实的项优先占用 maxItems 名额与模型注意力
  const allIssues = pickIssueItems(report.items, includeWarn, opts.partialChapter === true)
  const issues = allIssues.slice(0, maxItems)
  if (issues.length === 0) return ''

  const partial = opts.partialChapter === true
  const lines: string[] = []
  if (mode === 'rewrite') {
    lines.push(`【按写后自检修订第 ${ch} 章】`)
    lines.push(
      '请在保留已写剧情与文风的前提下，逐条核对下列提示，只有确认正文有问题时才修改。关键词未命中不等于事件没写；已有同义表达或合理安排的段落保持原样。能局部修补的就局部修补。'
    )
  } else {
    lines.push(`【写后自检补写要求 · 第 ${ch} 章】`)
    lines.push(
      '续写/补写前逐条核对下列提示，只处理确实遗漏或矛盾的内容；已有同义表达或合理安排不重复补写。与既有正文衔接，不要抢写下一章；需要删改已写内容的提示不能靠续写重复一遍来修复。'
    )
  }
  if (partial) {
    lines.push(
      '注意：本章尚未写完（仍在分轮续写中）。标【后续】的是整章写完前再核对的完成度项，本次能顺势推进就推进，**不要为了勾掉它们而把本章硬收尾或跳过中间剧情**；标【必须】【建议】的本次先核实，再按实际问题处理。'
    )
  }
  lines.push('')

  let n = 1
  for (const it of issues) {
    const tag =
      partial && isDeferredSelfCheckItem(it) ? '后续' : it.verdict === 'fail' ? '必须' : '建议'
    const cat = CATEGORY_LABEL[it.category] ?? it.category
    lines.push(`${n}. 【${tag}·${cat}】${it.label}`)
    if (it.detail?.trim()) {
      lines.push(`   依据：${clip(it.detail.trim(), 160)}`)
    }
    // 字面匹配只能提出待核对点，不能直接命令重写已用同义表达完成的情节。
    const missing = (it.missing ?? []).map((m) => m.trim()).filter(Boolean)
    if (missing.length > 0) {
      lines.push(
        `   待核对的要点（可能已有同义表达，确认遗漏后再处理）：${missing
          .map((m) => `「${clip(m, 60)}」`)
          .join('、')}`
      )
    }
    const action = actionHint(it)
    if (action) lines.push(`   改法：${action}`)
    lines.push('')
    n++
  }

  if (issues.length < allIssues.length) {
    lines.push(`本次列出 ${issues.length}/${allIssues.length} 项提示，其余项尚未纳入本轮要求，不代表已解决。`)
  }

  lines.push(
    partial
      ? '改完后复核：确认存在的问题应由正文中的行动、结果或必要删改解决，禁止仅用旁白声称「已解决」；误报保留原文，【后续】项留到整章写完前核对，伏笔可依因果条件合理延期。'
      : '改完后复核：确认存在的问题应由正文中的行动、结果或必要删改解决，禁止仅用旁白声称「已解决」；误报保留原文，不能为通过关键词检查重复情节或强行揭底。'
  )
  if (mode === 'rewrite') {
    // 落笔结果是整体替换编辑器正文的（见 ChapterEditor.adjustChapter），
    // 这段又被 adjust prompt 声明为最高优先级——放任「只给改动段落」会把整章截没。
    lines.push('直接输出修订后的**完整本章正文**（含未改动的段落），不要只给改动片段，不要解释过程。')
  }

  return lines.join('\n').trim() + '\n'
}

/** 是否有可生成要求的问题项 */
export function selfCheckHasActionableIssues(
  report: ChapterSelfCheckReport | null | undefined,
  includeWarn = true
): boolean {
  if (!report?.items?.length) return false
  return pickIssueItems(report.items, includeWarn).length > 0
}

function pickIssueItems(
  items: SelfCheckItemResult[],
  includeWarn: boolean,
  partialChapter = false
): SelfCheckItemResult[] {
  const allowed: SelfCheckVerdict[] = includeWarn ? ['fail', 'warn'] : ['fail']
  const rank: Record<SelfCheckVerdict, number> = { fail: 0, warn: 1, pass: 2, skip: 3 }
  const weight = (i: SelfCheckItemResult): number =>
    (partialChapter && isDeferredSelfCheckItem(i) ? 10 : 0) + rank[i.verdict]
  return items.filter((i) => allowed.includes(i.verdict) &&
    i.id !== 'self_check_error' && i.repairKind !== 'execution_error')
    .sort((a, b) => weight(a) - weight(b))
}

/** 按检查 id / 类别给可操作改法提示 */
function actionHint(item: SelfCheckItemResult): string {
  const id = item.id
  // 旧报告可能保留已移除的形态规则，不能再次强迫正文换成某种结尾。
  if (id === 'ending_form') {
    return '旧版结尾形态提示仅供核对：正常心理描写、必要总结或对话收束都可保留；只有章末确实空泛或缺少衔接时才局部调整，不强行改成对话或突然动作。'
  }
  if (id === 'ending_taboo') {
    return '核对命中句是否确为脱离人物语境的说教或空泛抒怀；正常对白和必要叙述保留，确属套话时仅删改对应句。'
  }
  if (id === 'prev_suspense') {
    return '先核对章首或前半段是否已回应或合理延续上章悬念；确认遗漏后再补必要的对话或动作。'
  }
  if (id.startsWith('unfinished_')) {
    return '在正文中明确处理或推进该未完成事项（对话承诺、动作完成、或合理延后并点明）。'
  }
  if (id === 'char_position') {
    return '核对人物是否出场及是否已有合理转场；只有地点或行程确实矛盾时才补必要衔接，不为未出场人物强加镜头。'
  }
  if (id === 'core_plot') {
    return '先核对同义表述、实际行动与结果，区分已完成、计划和否定；只有确实遗漏的核心事件才补写，已落实的情节保持原样，不为命中关键词重复或换词重写。'
  }
  if (id.startsWith('due_fb_')) {
    return '核对伏笔核心疑问是否真的解决，区分提及、强化、部分揭示和完整回收；到期只是安排提醒，因果条件不足可合理延期，不必强行揭底。若回收记录有误，应核对记录，不能为迎合记录编造回收情节。'
  }
  if (id.startsWith('early_fb_')) {
    return '先核对是否真的提前揭穿核心疑问；人物、物品出场和含蓄暗示可以保留，仅删改确认提前揭底的内容。'
  }
  if (id === 'power_bound') {
    return '结合对应人物、能力边界和局部语境核对是否实际越权；否定、传闻和假设不等于使用能力，仅修正确认越权的行动与结果。'
  }
  if (id === 'volume_spoiler') {
    return '核对后续事件是否已在本章实际发生；计划、铺垫和相关人物出场不算抢写，仅调整确认提前发生的节点。'
  }
  if (id === 'word_count') {
    // 兼容旧报告；新报告用结构化方向，不依赖 detail 的措辞。
    if (isOverLengthItem(item)) return '在保留关键行动、因果和收束的前提下压缩重复叙述与冗余段落，使篇幅符合细纲上限；不要扩写或新增情节来处理超限。'
    return '篇幅是参考，先核对剧情与收束是否完整；完整则保留现有长度，只有确实遗漏必要情节才补写，不为凑字扩写环境、心理或重复对白。'
  }
  if (id === 'punctuation_rule') {
    return '只处理提示中的破折号或省略号，按句意替换为合适标点或必要动作断句，保留原有情节；可优先使用一键替换标点。'
  }
  if (id === 'ai_tells') {
    return '结合语境核对提示中的动作是否重复或空泛，必要时替换为具体行为；不要仅因命中模式删除有效情节。'
  }
  if (id === 'meta_narration') {
    return '去掉「第N章」「下章见」「未完待续」等元叙述，改用故事内对话/事件收尾。'
  }

  switch (item.category) {
    case 'continuity':
      return '补上与上章状态/位置/悬念的衔接句。'
    case 'plot':
      return '核对是否偏离当前情节安排；只有确认偏题或遗漏时才局部调整，保留已完成的情节。'
    case 'foreshadow':
      return '核对伏笔的实际推进程度与因果条件，合理保留暗示或延期，不为到期强行揭底。'
    case 'power':
      return '对齐金手指限制，删掉越权表述。'
    case 'structure':
      return '按依据核对具体结构问题，确认后局部调整，保留正常叙述与原有收束方式。'
    case 'ban':
      return '删除抢写、元叙述或违规提前内容。'
    default:
      return '按依据项修改正文，使检查可通过。'
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

/**
 * 对比改前/改后自检，生成「复检」短文案（toast / 状态条）。
 * 无 previous 时退回 next.summary。
 */
export function formatSelfCheckDelta(
  previous: ChapterSelfCheckReport | null | undefined,
  next: ChapterSelfCheckReport
): string {
  if (!previous) return next.summary
  const pf = previous.counts.fail
  const pw = previous.counts.warn
  const nf = next.counts.fail
  const nw = next.counts.warn
  // 改前本就干净：只报本次结果
  if (pf + pw === 0) return next.summary

  const checkedIds = new Set(next.items.filter((item) => item.verdict !== 'skip').map((item) => item.id))
  const unverified = previous.items.filter((item) =>
    (item.verdict === 'fail' || item.verdict === 'warn') &&
    !checkedIds.has(item.id))
  if (next.counts.skip > 0 || unverified.length > 0) {
    return `复检：失败 ${nf}、留意 ${nw}；${next.counts.skip} 项未检查${unverified.length ? `，此前 ${unverified.length} 项问题本次未核验` : ''}，不能据此判断全部通过`
  }

  if (next.ok && nw === 0) {
    return `复检全部通过（此前失败 ${pf}、留意 ${pw}）`
  }
  if (next.ok && nw > 0) {
    return `复检无失败项（留意 ${nw}；此前失败 ${pf}、留意 ${pw}）`
  }
  if (nf < pf || (nf === pf && nw < pw)) {
    return `复检有改善：失败 ${pf}→${nf}，留意 ${pw}→${nw}`
  }
  if (nf > pf || nw > pw) {
    return `复检仍有问题：失败 ${nf}、留意 ${nw}（此前 ${pf}/${pw}）`
  }
  return `复检结果未变：失败 ${nf}、留意 ${nw}`
}
