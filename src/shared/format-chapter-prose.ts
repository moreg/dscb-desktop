/**
 * 章节正文格式化：
 * - 去掉汉字间与行首尾的多余空白；英文词间空白归一为空格
 * - 去掉空行（连续换行压成单个换行）
 * - **保留**段落换行
 * - 对话动作排版归一：严禁同一人台词中间夹动作打断（“话1”动作，“话2”），自动将动作前置独立成行并合并台词
 *
 * 保持清理汉字空格与单换行的产品策略，但不把英文短语粘成一个词。
 */
import { stripPublishedChapterRefs } from './strip-chapter-meta'

const LATIN_SPACE_NEIGHBOR = /[\p{Script=Latin}\p{M}0-9.,!?;:'"“”‘’–—…()[\]{}@#%&+/\\=<>_-]/u

/**
 * 将同一人台词中间被动作打断的句式重构为规范网文排版：
 * “不是今晚才沾上的。”朴博士把图像放大，“旧切片里就有主毒……”
 * 转换为：
 * 朴博士把图像放大。
 * “不是今晚才沾上的，旧切片里就有主毒……”
 */
export function separateDialogueInterruption(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // 匹配单行内“台词1”动作“台词2”的夹塞动作结构
    const m = trimmed.match(/^([“"「])([^”"」\n]+?)([”"」])\s*([^“”"「」\n]{1,60}?)\s*([“"「])([^”"」\n]+?)([”"」])$/)
    if (m) {
      const openQ = m[1]
      const closeQ = m[3]
      const rawQ1 = m[2]
      let action = m[4].trim().replace(/^[，,：:\s]+|[，,：:\s]+$/g, '')
      if (action && !/[。！？…~～]$/.test(action)) action += '。'

      let sep = '，'
      if (/[？！?!~～…]+$/.test(rawQ1)) {
        sep = rawQ1.match(/[？！?!~～…]+$/)![0]
      }
      const q1Clean = rawQ1.replace(/[。！？，；、…!?~～]+$/, '')
      const q2 = m[6]

      if (action) {
        out.push(action)
      }
      out.push(`${openQ}${q1Clean}${sep}${q2}${closeQ}`)
    } else {
      out.push(line)
    }
  }

  return out.join('\n')
}

export function formatChapterProse(text: string): string {
  if (!text) return text
  const normalized = text
    // 统一换行
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 汉字间去空白；英文词、数字与英文标点之间保留一个分词空格。
    .replace(/[^\S\n]+/g, (space, offset: number, input: string) => {
      const left = input[offset - 1] ?? ''
      const right = input[offset + space.length] ?? ''
      return LATIN_SPACE_NEIGHBOR.test(left) && LATIN_SPACE_NEIGHBOR.test(right) ? ' ' : ''
    })
    // 连续空行压成单行换行
    .replace(/\n{2,}/g, '\n')
    // 去掉首尾空行
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')

  const proseWithDialogue = separateDialogueInterruption(normalized)
  // 空白收干净之后再认章号：「第 9 章」会先变成「第9章」。
  return stripPublishedChapterRefs(proseWithDialogue)
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
  // 若模型在英文词间断开，接缝上已有的分词空格不能随 trim 一起丢掉。
  if ((/[^\S\n]$/.test(base) || /^[^\S\n]/.test(addition)) &&
    LATIN_SPACE_NEIGHBOR.test(left.slice(-1)) && LATIN_SPACE_NEIGHBOR.test(right[0])) {
    return left + ' ' + right
  }
  return left + right
}

/** 是否还有可格式化内容（用于按钮禁用/提示） */
export function needsChapterProseFormat(text: string): boolean {
  if (!text) return false
  return formatChapterProse(text) !== text
}
