/**
 * 检测 LLM/Agent 输出是否为「流程旁白」而非小说正文。
 *
 * 典型形态：
 * - 「我会调用 story-long-write 技能…技能文件被截断…」
 * - 「我会按长篇网文写作流程先核对…再直接给出正文。」（无技能名，同样非法）
 *
 * 常见于 Codex / Grok / agy 等 CLI agent 先讲流程再出稿；按内容判定，不绑定某一家。
 * 此类文本绝不能作为章节正文落盘。
 *
 * deslop 的硬规则也复用本文件导出的正则，避免两处漂移。
 */

/** 技能名硬特征（deslop / 旁白检测共用） */
export const AGENT_SKILL_NAME_RE =
  /story-(?:long|short)-(?:write|scan|analyze|import|review|setup|cover|deslop)/i

/**
 * 强特征：短文本命中 1 条即判旁白；任意长度命中 ≥2 条也判。
 * 注意：不含单独的「再直接给出正文」（易误杀短稿/台词），该句归弱特征。
 */
export const AGENT_STRONG_PATTERNS: RegExp[] = [
  AGENT_SKILL_NAME_RE,
  /我会调用.{0,40}技能/,
  /技能文件(?:较长|被截断|太长)/,
  /正在补读完整规则/,
  /不会把流程说明混进小说/,
  /先做规则与衔接自检/,
  /这一步只用于确保/,
  /随后会直接输出正文/,
  // 「我会按…写作流程…」——无技能名的软旁白主句
  /我会按.{0,20}(?:长篇|短篇)?(?:网文)?写作流程/,
  /先核对(?:本章的)?衔接[、,，]?细纲边界/
]

/** deslop 行级硬匹配：强特征 + 若干高置信弱特征（单行出现即视为 agent 旁白） */
export const AGENT_DESLOP_HARD_RES: RegExp[] = [
  AGENT_SKILL_NAME_RE,
  /我会调用.{0,40}技能/,
  /技能文件(?:较长|被截断|太长)/,
  /正在补读完整规则/,
  /不会把流程说明混进小说/,
  /先做规则与衔接自检/,
  /我会按.{0,20}(?:长篇|短篇)?(?:网文)?写作流程/,
  /先核对(?:本章的)?衔接[、,，]?细纲边界/,
  // 与「我会/技能/流程」共现时才更像旁白；单行「再直接给出正文」仍作硬规则（agent 输出极短时常整段只有这句）
  /再直接给(?:出)?正文/
]

/** 弱特征：需配合短篇幅或多个命中 */
const WEAK_PATTERNS: RegExp[] = [
  /(?:章节|长篇|短篇|网文)写作流程/,
  /细纲边界/,
  /章末(?:钩子|卡点)/,
  /衔接自检|核对.{0,8}衔接/,
  /我正在补读/,
  /直接给(?:出)?正文/,
  /再直接给(?:出)?正文/,
  /先做规则/,
  /不会把流程说明/
]

/**
 * 判断文本是否为 agent/模型流程旁白（不应作为正文）。
 */
export function isAgentProcessNarration(text: string): boolean {
  const t = text.trim()
  if (!t) return false

  let strong = 0
  for (const re of AGENT_STRONG_PATTERNS) {
    if (re.test(t)) strong += 1
  }
  if (strong >= 2) return true
  if (strong >= 1 && t.length < 1500) return true

  let weak = 0
  for (const re of WEAK_PATTERNS) {
    if (re.test(t)) weak += 1
  }
  if (strong >= 1 && weak >= 1) return true
  // 极短文本 + 多条写作流水线术语 → 旁白
  if (weak >= 2 && t.length < 300) return true
  if (weak >= 3 && t.length < 800) return true

  // 全文几乎只有一句「先…再输出正文」且无小说叙述特征
  if (
    t.length < 200 &&
    /我会|先.{0,12}(?:核对|自检|检查|读取)|再(?:直接)?(?:给|输出|写)/.test(t) &&
    /正文/.test(t) &&
    !/[「」""]/.test(t) // 无对白引号，更不像成稿
  ) {
    return true
  }

  return false
}

/**
 * 流式早拦：累计输出仍较短时，若已明显是旁白则应中止。
 * 阈值略宽于最终校验，避免长正文中段偶发词误杀。
 */
export function isEarlyAgentNarration(accumulated: string): boolean {
  const t = accumulated.trim()
  if (!t || t.length > 2000) return false
  return isAgentProcessNarration(t)
}

/** 生成失败错误码（前端 friendlyLlmError 可映射） */
export const LLM_AGENT_META_ERROR = 'LLM_AGENT_META'

/** 高置信非正文格式、复制前部与空正文；与语义质量提醒分开处理。 */
export const LLM_PROSE_FORMAT_ERROR = 'LLM_PROSE_FORMAT'
export const LLM_PROSE_REPETITION_ERROR = 'LLM_PROSE_REPETITION'
export const LLM_EMPTY_PROSE_ERROR = 'LLM_EMPTY_PROSE'

/** 用户主动取消（与超时 LLM_TIMEOUT 区分） */
export const LLM_ABORTED_ERROR = 'LLM_ABORTED'

/**
 * 仅拦高置信非正文：旁白、格式/占位泄漏、空稿、续写大段复制前部。
 * 只校验，不修改传入文本；合法末尾伏笔回执仅从检查视图中剥离。
 * existingText 有实际正文时允许空增量，避免完整章节被迫继续凑字数。
 */
export function assertNovelProse(text: string, existingText?: string): void {
  const prose = withoutTerminalReceipt(text)
  const previous = withoutTerminalReceipt(existingText ?? '')
  if (!compactForComparison(prose)) {
    if (compactForComparison(previous)) return
    throw new Error(LLM_EMPTY_PROSE_ERROR)
  }
  if (isAgentProcessNarration(prose)) {
    throw new Error(LLM_AGENT_META_ERROR)
  }
  if (hasProseFormatLeak(prose)) {
    throw new Error(LLM_PROSE_FORMAT_ERROR)
  }
  if (hasSubstantialPriorCopy(prose, previous)) {
    throw new Error(LLM_PROSE_REPETITION_ERROR)
  }
}

/** 只接受位于末尾、字段有效的 JSON；不借宽松解析吞掉其后的正文。 */
function withoutTerminalReceipt(text: string): string {
  const tag = '【本章伏笔回执】'
  for (let start = text.indexOf(tag); start >= 0; start = text.indexOf(tag, start + tag.length)) {
    try {
      const receipt: unknown = JSON.parse(text.slice(start + tag.length).trim())
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
      const fields = Object.entries(receipt)
      if (!fields.length || fields.some(([key, value]) =>
        !['planted', 'collected'].includes(key) ||
        !Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')
      )) continue
      return text.slice(0, start)
    } catch {
      // 可能先读到了小说里提及的标签；继续寻找真正的末尾回执。
    }
  }
  return text
}

function compactForComparison(text: string): string {
  return text.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/gu, '')
}

/** 不把小说人物谈论这些符号、短暂强调或普通悬念省略号当成格式泄漏。 */
function hasProseFormatLeak(text: string): boolean {
  if (/^[ \t]*(?:#{1,6}[ \t]+\S|`{3,}|~{3,})/m.test(text)) return true
  // 合法回执已被剥离；仍单独成行的回执是损坏/未收束的结构化输出。
  if (/^[ \t]*【本章伏笔回执】/m.test(text)) return true

  const bold = [...text.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g)]
  const boldLength = bold.reduce((sum, match) =>
    sum + compactForComparison(match[1] ?? match[2]).length, 0)
  if (boldLength >= 40 && boldLength / compactForComparison(text).length >= 0.25) return true

  // 只检查叙述中的占位，不误伤人物读出“（此处省略）”等文字的情节。
  const unquoted = text.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '')
  return /[（(【[][ \t]*(?:(?:此处|以下|这里|下文|后续)[ \t]*)?(?:省略|略去|略过|待补充|待续写|TODO\b)[^）)】\]\n]{0,100}[）)】\]]/iu.test(unquoted) ||
    /^[ \t]*(?:正文待补充|后续内容省略|此处省略[^\n]{0,80}|TODO(?:[：:].*)?)[ \t]*$/imu.test(unquoted)
}

const PRIOR_COPY_MIN_CHARS = 80
const PRIOR_COPY_MIN_RATIO = 0.35

/**
 * 精确长片段覆盖率，忽略排版空白；不推断语义相似或是否抄袭其他作品。
 * 索引首个出现位置即可，高置信拦截宁可漏报少量变体，也不做模糊匹配误杀呼应。
 */
function hasSubstantialPriorCopy(text: string, existingText: string): boolean {
  const added = compactForComparison(text)
  const previous = compactForComparison(existingText)
  if (added.length < PRIOR_COPY_MIN_CHARS || previous.length < PRIOR_COPY_MIN_CHARS) return false

  const previousWindows = new Map<string, number>()
  for (let i = 0; i <= previous.length - PRIOR_COPY_MIN_CHARS; i++) {
    const seed = previous.slice(i, i + PRIOR_COPY_MIN_CHARS)
    if (!previousWindows.has(seed)) previousWindows.set(seed, i)
  }

  let copied = 0
  for (let i = 0; i <= added.length - PRIOR_COPY_MIN_CHARS;) {
    const start = previousWindows.get(added.slice(i, i + PRIOR_COPY_MIN_CHARS))
    if (start === undefined) {
      i++
      continue
    }
    let length = PRIOR_COPY_MIN_CHARS
    while (i + length < added.length && start + length < previous.length &&
      added[i + length] === previous[start + length]) length++
    const passage = added.slice(i, i + length)
    if (isSubstantivePassage(passage)) copied += length
    if (copied / added.length >= PRIOR_COPY_MIN_RATIO) return true
    i += length
  }
  return false
}

/** 短台词、口号或刻意短句复沓不因为累计到 80 字就升级成大段复制。 */
function isSubstantivePassage(passage: string): boolean {
  const narrative = passage.replace(/“[^”]{0,40}”|‘[^’]{0,40}’|「[^」]{0,40}」|『[^』]{0,40}』|"[^"\n]{0,40}"/gu, '')
  const letters = narrative.match(/[\p{L}\p{N}]/gu) ?? []
  if (letters.length < 40 || new Set(letters).size < 20) return false
  for (let period = 1; period <= 40 && period * 2 <= passage.length; period++) {
    let repeats = true
    for (let i = period; i < passage.length; i++) {
      if (passage[i] !== passage[i % period]) {
        repeats = false
        break
      }
    }
    if (repeats) return false
  }
  return true
}
