/**
 * 章节正文格式化：
 * - 去掉行内空白（半角/全角空格、Tab、nbsp 等；**含英文词间空格**）
 * - 去掉空行（连续换行压成单个换行）
 * - **保留**段落换行
 *
 * 产品策略偏激进：优先清掉 AI 在汉字间插入的空格与多余空行。
 * 若正文含英文短语，词间空格也会被去掉（`Hello World` → `HelloWorld`）。
 */
export function formatChapterProse(text: string): string {
  if (!text) return text
  return (
    text
      // 统一换行
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // 去掉行内空白（不含换行）：空格、Tab、nbsp、全角空格等
      .replace(/[^\S\n]+/g, '')
      // 连续空行压成单行换行
      .replace(/\n{2,}/g, '\n')
      // 去掉首尾空行
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
  )
}

/**
 * 句末判定：终止标点（可后跟收尾引号/括号）。
 * 用于决定续写接缝处该不该断段。
 */
const SENTENCE_END_RE = /[。！？!?…～~—.][」』】》〉）)\]"'”’]*$/

/**
 * 拼接续写结果。
 *
 * 两种接缝要区别对待：
 * - 原文停在**句末**（或已换行）：模型是另起一段往下写。此时必须补换行——
 *   prompt 要求它「开头不需要任何承接词」，首 token 一般不是换行，裸拼会把原文
 *   最后一段和新写的第一段焊成一段，而 formatChapterProse 只压空行、不补换行，救不回来。
 * - 原文停在**句子中间**（如「他推开」）：模型是在把这句写完。这时补换行反而会把
 *   一句话劈成两段，比焊死更糟。直接拼接才是对的。
 */
export function joinContinuation(base: string, addition: string): string {
  if (!base.trim()) return addition
  if (!addition.trim()) return base
  const left = base.replace(/\s+$/, '')
  const right = addition.replace(/^\s+/, '')
  // 原文本就以换行结尾 → 作者已经手动分段，尊重它
  const endedWithNewline = /\n[^\S\n]*$/.test(base)
  if (endedWithNewline || SENTENCE_END_RE.test(left)) return left + '\n' + right
  return left + right
}

/** 是否还有可格式化内容（用于按钮禁用/提示） */
export function needsChapterProseFormat(text: string): boolean {
  if (!text) return false
  return formatChapterProse(text) !== text
}
