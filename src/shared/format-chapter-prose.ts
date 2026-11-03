/** 最小正文排版：清理多余空白，保留语意段落、句末标点和事件顺序。 */
import { stripPublishedChapterRefs } from './strip-chapter-meta'

const LATIN_SPACE_NEIGHBOR = /[\p{Script=Latin}\p{M}0-9.,!?;:'"“”‘’–—…()[\]{}@#%&+/\\=<>_-]/u

/** 保留旧调用接口。动作位置属于叙事事实，格式化不得搬动动作。 */
export function separateDialogueInterruption(text: string): string {
  return text
}

export function formatChapterProse(text: string): string {
  if (!text) return text
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, (space, offset: number, input: string) => {
      const left = input[offset - 1] ?? ''
      const right = input[offset + space.length] ?? ''
      return LATIN_SPACE_NEIGHBOR.test(left) && LATIN_SPACE_NEIGHBOR.test(right) ? ' ' : ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // 保留既有的误入正文章号清理；不按句号拆段，也不补造或删去台词标点。
  return stripPublishedChapterRefs(normalized)
}

/**
 * 句末判定：终止标点（可后跟收尾引号/括号）。
 * 用于决定续写接缝处该不该断段。
 */
const SENTENCE_END_RE = /(?:[。！？!?…～~—.][」』】》〉）)\]"'”’]*|[」』”"])$/

/**
 * 拼接续写结果。
 *
 * 两种接缝要区别对待：
 * - 原文停在**句末**（或已换行）：模型是另起一段往下写。此时必须补换行——
 *   prompt 要求它「开头不需要任何承接词」，首 token 一般不是换行，裸拼会把原文
 *   最后一段和新写的第一段焊成一段；台词无句号时也要识别闭合引号。
 * - 原文停在**句子中间**（如「他推开」）：模型是在把这句写完。这时补换行反而会把
 *   一句话劈成两段，比焊死更糟。直接拼接才是对的。
 */
export function joinContinuation(base: string, addition: string): string {
  if (!base.trim()) return addition
  if (!addition.trim()) return base
  const left = base.replace(/\s+$/, '')
  const right = addition.replace(/^\s+/, '')
  // 只在本次新增段落的接缝留一个空行，不重排前文已有段落。
  const endedWithNewline = /\n[^\S\n]*$/.test(base)
  if (endedWithNewline || SENTENCE_END_RE.test(left)) return left + '\n\n' + right
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
