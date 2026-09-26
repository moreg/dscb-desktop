import type { AuditViolation, ChapterSelfCheckReport, Foreshadowing, MemoryExtraction } from '../../shared/types'

/**
 * 内容字符 = 汉字/字母/数字。标点、空白、引号一律不参与比对。
 *
 * 证据定位此前是 content.includes(quote) 的零容忍逐字匹配：模型从五千字正文里
 * 复制原句，差一个逗号、一个引号、一个全半角就判「缺少可定位的正文原文依据」。
 * 一章十几条证据里至少错一条几乎是必然，于是闸门的稳态是永远关闭——实测连写
 * 10 章，10 章的记忆全部没入库。
 *
 * 忽略标点不等于接受改写：字符序列仍必须逐字命中，少一个「不」「没」照样不通过。
 */
const CONTENT_CHAR = /[\p{L}\p{N}]/u

/** 抽出内容字符及其在原文中的下标，用于把命中位置映射回原文切片 */
function contentChars(text: string): { chars: string; offsets: number[] } {
  let chars = ''
  const offsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (CONTENT_CHAR.test(ch)) {
      chars += ch
      offsets.push(i)
    }
  }
  return { chars, offsets }
}

/**
 * 完整小句的下限比裸词低：一句完整的话（哪怕很短）本身就是证据，
 * 不需要凑够 6 个字。只有「没有句读的碎片」才该被当成「只引了个名字」挡下。
 *
 * 回归实例（真实项目里抓到的）：证据「"这张不兑。"」「"今日不送。"」都只有
 * 4 个内容字符，逐字精确命中原文，但按旧的统一 6 字下限被判「缺少依据」——
 * 明明是模型精准摘录的一句完整台词，却被字数门槛误杀。
 */
const SENTENCE_END_RE = /[。！？…]/

/** 证据在正文中的位置（原文口径的起止下标）；定位不到返回 undefined */
export function locateMemoryEvidence(
  content: string,
  evidence: string | undefined
): { start: number; end: number } | undefined {
  if (typeof evidence !== 'string') return undefined
  const quote = contentChars(evidence)
  // 只引名字/道具名不算证据；但引文本身若含句末标点，说明是完整小句而非碎片，
  // 下限降到 4 字——短台词（"不兑。"这类）不该因为短就被当成没引够。
  const minLen = SENTENCE_END_RE.test(evidence) ? 4 : 6
  if (quote.chars.length < minLen) return undefined
  const source = contentChars(content)
  const hit = source.chars.indexOf(quote.chars)
  if (hit < 0) return undefined
  const start = source.offsets[hit]
  const end = source.offsets[hit + quote.chars.length - 1] + 1
  /**
   * 边缘标点只在「两头都对得上」时并入。
   * 台词整句作证据时（引号在正文里本来就有），两头都能对上 → 保留原有引号；
   * 模型给引文额外套引号、或只截了台词中间一段时，收尾对不上 → 只返回内容本身，
   * 不把它自己加的引号当成正文的一部分。
   */
  const lead = /^[^\p{L}\p{N}]*/u.exec(evidence)?.[0] ?? ''
  const tail = /[^\p{L}\p{N}]*$/u.exec(evidence)?.[0] ?? ''
  const leadFits = lead === '' || content.slice(Math.max(0, start - lead.length), start) === lead
  const tailFits = tail === '' || content.slice(end, end + tail.length) === tail
  return leadFits && tailFits
    ? { start: start - lead.length, end: end + tail.length }
    : { start, end }
}

/**
 * 把模型给的引文归位成正文里的真实切片。
 * 返回的永远是正文原文（含它自己的标点），而不是模型抄写的版本。
 */
export function resolveMemoryEvidence(content: string, evidence: string | undefined): string | undefined {
  const at = locateMemoryEvidence(content, evidence)
  return at ? content.slice(at.start, at.end) : undefined
}

/** Persist actual source quotes so downstream writers use the same evidence as validation. */
export function normalizeMemoryEvidence(content: string, extraction: MemoryExtraction): MemoryExtraction {
  const normalize = <T extends { evidence?: string }>(item: T): T => {
    const evidence = resolveMemoryEvidence(content, item.evidence)
    return evidence === undefined ? item : { ...item, evidence }
  }
  return { ...extraction,
    newPlotPoints: extraction.newPlotPoints.map(normalize),
    characterStateChanges: extraction.characterStateChanges.map(normalize),
    collectedForeshadowings: extraction.collectedForeshadowings.map(normalize),
    settingsPatches: extraction.settingsPatches?.map(normalize)
  }
}

/**
 * 三类词对引文的作用范围不同，混成一张表按整句匹配会把大量正常正文拦下。
 *
 * 旧实现把「听说/打算/可能/没有」全表拿去匹配引文所在的整句：
 * 「林昭没有回头，反手一掌拍在石壁上」——拍石壁是实打实发生的，却因同句前半的
 * 「没有」被判成否定。而且回退句首只认「。」和换行，对话段里的「？！」拦不住它，
 * 上下文会一路蔓延到整段开头，捞到更多无关的否定词。网文正文里这几个词密度极高，
 * 于是「证据不足」成了常态。
 *
 * - NEGATION：只推翻紧挨着它的那个谓语，跨小句即失效。
 * - FORWARD_SCOPE：转述、计划、假设，会笼罩它之后的整句。
 * - HEDGE：削弱断言本身的语气词，落在引文前后都算数。
 */
const NEGATION = /(?:并未|没有|尚未|还未|未曾|不曾)/u
const FORWARD_SCOPE = /(?:听说|据说|传闻|谣言|据传|猜测|怀疑|误以为|假装|佯装|打算|准备|计划|倘若|如果|假如|梦见|梦中)/u
const HEDGE = /(?:也许|可能|幻觉)/u

/**
 * 记忆条目自身是否记的就是一件「没发生」的事。
 *
 * 否定闸门防的是「截掉否定词制造既成事实」——正文写「他没有死」，记忆记成「死亡」。
 * 可实测下来被它挡住的绝大多数是另一回事：记忆记的本来就是否定事实
 * （「未流血」「许可缺失而不可用」「未跨入页口街」），引文当然带否定词——
 * 提取提示词还明确要求「保留否定词」。断言与引文同为否定时，两边是对上的，不该拦。
 *
 * 人物性格/关系里最常见的是「克制型」断言：「不追问她的私事」「不替她做选择」，
 * 引文是「他没有追问……」。所以裸「不」也算否定断言，只排除不仅/不断/不禁/不得不
 * 这类并不否定谓语的组合。
 */
const CLAIM_NEGATION =
  /(?:没|未|无法|无力|不(?!仅|但|断|少|久|禁|由|得不|过|错|停|住|知不觉)|并非|缺失|失效|失败|拒绝|停止)/u

const SENTENCE_END = /[。！？!?\n…]/u
const CLAUSE_END = /[，,、；;：:]/u
/** 拼接几段上下文时用的哨兵，防止「没」「有」跨段被拼成「没有」 */
const JOIN = '｜'

/** 从 upto 往前找最近的分隔符下标；找不到返回 -1 */
function lastBreakBefore(content: string, upto: number, breaks: RegExp): number {
  for (let i = upto - 1; i >= 0; i--) if (breaks.test(content[i])) return i
  return -1
}

/** 从 from 往后找最近的分隔符下标；找不到返回 -1 */
function firstBreakAfter(content: string, from: number, breaks: RegExp): number {
  for (let i = from; i < content.length; i++) if (breaks.test(content[i])) return i
  return -1
}

const CLOSING_QUOTE = /[”’」』"]/u

/**
 * 把引文按整句切开（原文下标），句末标点和紧跟的收尾引号归前一句。
 *
 * 模型常把两三句连着引：「“合作名单上有我前任，陆恺。他在这次展会里，周六可能碰见。”」。
 * 旧实现拿整段引文去匹配，后一句的「可能」把前一句的既成事实（有个前任）一起推翻。
 * 转述/推测/否定的作用范围都不跨句，所以逐句判。
 */
function sentencePieces(content: string, start: number, end: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = []
  let from = start
  for (let i = start; i < end; i++) {
    if (!SENTENCE_END.test(content[i])) continue
    let j = i + 1
    while (j < end && (SENTENCE_END.test(content[j]) || CLOSING_QUOTE.test(content[j]))) j++
    pieces.push([from, j])
    from = j
    i = j - 1
  }
  if (from < end) pieces.push([from, end])
  return pieces.filter(([a, b]) => contentChars(content.slice(a, b)).chars.length >= 2)
}

/** 引文里最后一个小句的起点（末尾的标点不算小句）；只有一个小句时返回 -1 */
function lastClauseStart(content: string, start: number, end: number): number {
  let seenContent = false
  for (let i = end - 1; i >= start; i--) {
    if (CONTENT_CHAR.test(content[i])) seenContent = true
    else if (seenContent && CLAUSE_END.test(content[i])) return i + 1
  }
  return -1
}

/**
 * 单句引文是否被否定/计划/推测推翻。
 *
 * 否定只看两处：
 * - 引文开头被截掉的那半个小句（「林昭没有|回头，反手……」——截掉否定词制造既成事实）；
 * - 引文最后一个小句连同它在正文里的后半截（「……改到河西的计划没有实现」）。
 * 引文**自己开头**就写着的否定不算截断：「许宴没有替她选，只在她腾不开手时帮忙托着
 * 文件夹」里，否定管的是「替她选」，引文真正落在后面已经发生的「托着文件夹」上。
 */
function pieceTainted(content: string, start: number, end: number, claimNegated: boolean): boolean {
  const quoted = content.slice(start, end)

  // 上下文一律以引文所在的**整句**为界；句内再按小句分近远。
  const sentenceStart = lastBreakBefore(content, start, SENTENCE_END) + 1
  const clauseStart = Math.max(sentenceStart, lastBreakBefore(content, start, CLAUSE_END) + 1)
  const ended = /[。！？!?\n…][”’」』"]*$/.test(quoted)
  const nextSentence = firstBreakAfter(content, end, SENTENCE_END)
  const sentenceEnd = ended ? end : nextSentence >= 0 ? nextSentence + 1 : content.length
  const nextClause = firstBreakAfter(content, end, CLAUSE_END)
  // 引文已带小句末标点时，不把下一小句并入近邻上下文。
  const clauseEnded = /[，,、；;：:][”’」』"]*$/.test(quoted)
  const clauseEnd = clauseEnded ? end : nextClause >= 0 ? Math.min(nextClause, sentenceEnd) : sentenceEnd
  const lead = content.slice(clauseStart, start)
  const trail = content.slice(end, clauseEnd)

  // 转述/推测：与引文同一小句内一律推翻
  const near = [quoted, lead, trail].join(JOIN)
  if (FORWARD_SCOPE.test(near) || HEDGE.test(near)) return true
  // 同句更早的小句：只有转述/计划/假设能管到引文（「他打算，明日便动身」）
  if (FORWARD_SCOPE.test(content.slice(sentenceStart, clauseStart))) return true
  // 引文之后的小句：只有削弱断言的语气词还算数（「……相同，可能只是巧合」）
  if (HEDGE.test(content.slice(clauseEnd, sentenceEnd))) return true

  if (claimNegated) return false
  // 多带一个字，防「没|有」正好被引文边界切开
  if (lead && NEGATION.test(content.slice(clauseStart, Math.min(start + 1, end)))) return true
  const tailFrom = lastClauseStart(content, start, end)
  const tail = tailFrom >= 0 ? content.slice(tailFrom, end) : lead + quoted
  return NEGATION.test([tail, trail].join(JOIN))
}

/**
 * 校验单条证据。通过返回 null，不通过返回原因。
 * A matching quote is necessary, not proof of semantic truth.
 *
 * claim 是这条记忆自己要记下的内容（情节事件、状态新值、设定正文…），
 * 只用来判断断言本身是不是否定式，见 CLAIM_NEGATION。
 *
 * 多句引文只要有一句站得住就通过：模型为了给足上下文会顺带多引一两句，
 * 其中一句带「如果/可能」不代表整条记忆没发生。
 */
function inspectEvidence(
  content: string,
  label: string,
  evidence: string | undefined,
  claim = ''
): string | null {
  const at = locateMemoryEvidence(content, evidence)
  if (!at) return `${label}：缺少可定位的正文原文依据`
  const claimNegated = CLAIM_NEGATION.test(claim)
  const pieces = sentencePieces(content, at.start, at.end)
  if (pieces.length === 0) pieces.push([at.start, at.end])
  if (pieces.some(([s, e]) => !pieceTainted(content, s, e, claimNegated))) return null
  return `${label}：原文含否定、计划或不确定表述，需要核对实际变化`
}

/**
 * 候选记忆的分诊结果。
 *
 * 此前校验是一票否决整章：任何一条证据定位不到，整章记忆——包括压根不要求证据的
 * 新角色/新地点/新物品/新伏笔——全部不写入。实测一章提取 18 条、12 条证据没过，
 * 结果 18 条一条都没进库，其中 10 条是被无关条目株连的。
 *
 * 现在分两级：
 * - chapterIssues：正文本身可疑（解析失败、深度审稿报错、写后自检未过），
 *   这时整章都不该入库——脏正文里抽出来的东西再有引文也不可信。
 * - itemIssues：某一条自己的证据不过关，只挡这一条，其余照常写入。
 */
export interface MemoryCandidatePartition {
  /** 章级问题：非空则整章不写入 */
  chapterIssues: string[]
  /**
   * 条目级问题：**一条被挡下的条目对应一条**（同条目的多个原因合并成一句）。
   * 界面按 length 报「N 项证据不足未写入」，所以这里不能按原因去重——
   * 两条不同的记忆给出同样的原因是常事（同名情节、同一人物的同一字段），
   * 去重后 5 条被挡只报 2 项，作者会以为另外 3 条已经入库。
   */
  itemIssues: string[]
  /** 只含通过校验条目的提取结果（章级问题不在此体现） */
  verified: MemoryExtraction
}

/**
 * 逐条校验的结果。kind + index 一起定位到 extraction 里的具体条目，
 * 复核界面用它做「这一条我确认属实，强制写入」。
 */
export interface MemoryCandidateItemVerdict {
  kind: MemoryCandidateItemKind
  /** 在 extraction 对应数组里的下标——仅在**本次**提取结果内有效 */
  index: number
  /**
   * 内容派生的稳定标识。重新提取一次后数组顺序会变，index 认不出同一条，
   * 而「作者已确认属实」这件事必须跨重跑存活，所以记的是 key 不是 index。
   */
  key: string
  /** 展示用标签，如 情节「雷迹突刺」 */
  label: string
  /** 模型给的引文（已归位成正文切片；定位不到时是原样） */
  evidence?: string
  /** 未通过的原因；空数组 = 通过。不拼成一个字符串——伏笔内容自带分号会被拆错 */
  issues: string[]
}

export type MemoryCandidateItemKind =
  | 'plotPoint'
  | 'stateChange'
  | 'foreshadowCollect'
  | 'settingsPatch'

/** 逐条给出校验结论（通过的也在列表里，issue 为空） */
export function inspectMemoryCandidateItems(
  content: string,
  extraction: MemoryExtraction,
  foreshadowings?: Foreshadowing[]
): MemoryCandidateItemVerdict[] {
  const out: MemoryCandidateItemVerdict[] = []
  const list = (issue: string | null): string[] => (issue ? [issue] : [])
  extraction.newPlotPoints.forEach((event, index) => {
    const label = `情节「${event.title}」`
    out.push({
      kind: 'plotPoint',
      index,
      key: `plot:${event.title}`,
      label,
      evidence: event.evidence,
      issues: list(inspectEvidence(content, label, event.evidence, `${event.title}${event.event}${event.coolPoint ?? ''}`))
    })
  })
  extraction.characterStateChanges.forEach((change, index) => {
    const label = `人物 ${change.name} 的${change.field}`
    out.push({
      kind: 'stateChange',
      index,
      key: `state:${change.name}:${change.field}`,
      label,
      evidence: change.evidence,
      // 断言口径只取新值：旧值里的否定说的是变化之前，不能用来豁免
      issues: list(inspectEvidence(content, label, change.evidence, change.newValue))
    })
  })
  extraction.collectedForeshadowings.forEach((item, index) => {
    const reasons: string[] = []
    const issue = inspectEvidence(content, `伏笔回收「${item.content}」`, item.evidence, item.content)
    if (issue) reasons.push(issue)
    if (item.chapter !== extraction.chapterNumber) {
      reasons.push(`伏笔「${item.content}」的回收章节与当前章不符`)
    }
    if (foreshadowings && item.foreshadowingId) {
      const matches = foreshadowings.filter((f) => f.id === item.foreshadowingId)
      if (matches.length !== 1 || matches[0].content.replace(/\s+/g, '') !== item.content.replace(/\s+/g, '')) {
        reasons.push(`伏笔 ${item.foreshadowingId} 的编号与原问题不一致或存在歧义，需要重新核对`)
      }
    }
    out.push({
      kind: 'foreshadowCollect',
      index,
      key: `fs:${item.foreshadowingId || item.content}`,
      label: `伏笔回收「${item.content}」`,
      evidence: item.evidence,
      issues: reasons
    })
  })
  ;(extraction.settingsPatches ?? []).forEach((patch, index) => {
    const label = `设定「${patch.title || patch.sectionTitle || patch.fileName}」`
    out.push({
      kind: 'settingsPatch',
      index,
      key: `set:${patch.fileName}:${patch.title || patch.sectionTitle || ''}`,
      label,
      evidence: patch.evidence,
      issues: list(inspectEvidence(content, label, patch.evidence, patch.content))
    })
  })
  return out
}

/**
 * 把逐条校验结论收成「每条被挡下的条目一句话」。
 * 一条条目有多个原因（如伏笔既定位不到引文、回收章节又对不上）合并成一句，
 * 这样 length 就是**被挡下的条目数**，与界面上的「N 项未写入」一致。
 */
export function describeBlockedItems(verdicts: MemoryCandidateItemVerdict[]): string[] {
  return verdicts.filter((v) => v.issues.length > 0).map((v) => v.issues.join('；'))
}

/** Check provenance conservatively, item by item. */
export function partitionMemoryCandidate(
  content: string,
  extraction: MemoryExtraction,
  review: AuditViolation[] = [],
  selfCheck?: ChapterSelfCheckReport | null,
  foreshadowings?: Foreshadowing[]
): MemoryCandidatePartition {
  const chapterIssues: string[] = []

  if (extraction.parseError) chapterIssues.push(extraction.parseError)

  const verdicts = inspectMemoryCandidateItems(content, extraction, foreshadowings)
  const passed = (kind: MemoryCandidateItemKind, index: number): boolean =>
    (verdicts.find((v) => v.kind === kind && v.index === index)?.issues.length ?? 0) === 0
  const itemIssues = describeBlockedItems(verdicts)

  const newPlotPoints = extraction.newPlotPoints.filter((_, i) => passed('plotPoint', i))
  const characterStateChanges = extraction.characterStateChanges.filter((_, i) =>
    passed('stateChange', i)
  )
  const collectedForeshadowings = extraction.collectedForeshadowings.filter((_, i) =>
    passed('foreshadowCollect', i)
  )
  const settingsPatches = extraction.settingsPatches?.filter((_, i) => passed('settingsPatch', i))

  // 审稿/自检是对整章正文的判断，不归到某一条，命中即整章不入库
  for (const finding of review) {
    if (finding.ruleId?.startsWith('review_incomplete:') || finding.severity === 'error' ||
      (finding.severity === 'warn' && /logic_hole|character_breakdown|quote_contradiction|low_iq_plot/.test(finding.ruleId ?? ''))) {
      chapterIssues.push(`审稿待核对：${finding.message}`)
    }
  }
  for (const item of selfCheck?.items ?? []) {
    if (item.verdict === 'fail') chapterIssues.push(`正文自检待核对：${item.label}：${item.detail}`)
  }

  return {
    // 章级问题按原因去重（同一条正文自检可能被多处提及）；条目级不去重，见字段注释
    chapterIssues: [...new Set(chapterIssues)],
    itemIssues,
    verified: {
      ...extraction,
      newPlotPoints,
      characterStateChanges,
      collectedForeshadowings,
      settingsPatches
    }
  }
}

/**
 * 兼容旧口径：把两级问题拍平成一个列表。
 * 新代码请用 partitionMemoryCandidate，按级别分别处理。
 */
export function validateMemoryCandidate(
  content: string,
  extraction: MemoryExtraction,
  review: AuditViolation[] = [],
  selfCheck?: ChapterSelfCheckReport | null,
  foreshadowings?: Foreshadowing[]
): string[] {
  const { chapterIssues, itemIssues } = partitionMemoryCandidate(
    content,
    extraction,
    review,
    selfCheck,
    foreshadowings
  )
  return [...new Set(chapterIssues), ...itemIssues]
}
