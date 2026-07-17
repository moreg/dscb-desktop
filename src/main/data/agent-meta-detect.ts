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

/** 用户主动取消（与超时 LLM_TIMEOUT 区分） */
export const LLM_ABORTED_ERROR = 'LLM_ABORTED'

/**
 * 若文本是 agent 流程旁白则抛出 LLM_AGENT_META。
 * 用于正文/按要求重写等「必须是小说成品」的路径。
 */
export function assertNovelProse(text: string): void {
  if (isAgentProcessNarration(text)) {
    throw new Error(LLM_AGENT_META_ERROR)
  }
}
