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
const DIALOGUE_QUOTE_ENDS = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']])

/** 仅检查接缝所在段落，避免更早段落中未配对的引号影响本次接缝。 */
function hasOpenDialogueQuote(paragraph: string): boolean {
  const expectedEnds: string[] = []
  for (const [mark] of paragraph.matchAll(/[“”‘’「」『』"]/g)) {
    if (expectedEnds.at(-1) === mark) {
      expectedEnds.pop()
    } else {
      const end = DIALOGUE_QUOTE_ENDS.get(mark)
      if (end) expectedEnds.push(end)
    }
  }
  return expectedEnds.length > 0
}

/**
 * 拼接续写结果。
 *
 * 两种接缝要区别对待：
 * - 原文停在**句末**（或已换行）：模型是另起一段往下写。此时必须补换行——
 *   prompt 要求它「开头不需要任何承接词」，首 token 一般不是换行，裸拼会把原文
 *   最后一段和新写的第一段焊成一段；台词无句号时也要识别闭合引号。
 * - 原文停在**句子中间或未闭合的对白中**：模型是在接完这句或这段发言，直接拼接。
 */
export function joinContinuation(base: string, addition: string): string {
  if (!base.trim()) return addition
  if (!addition.trim()) return base
  const left = base.trimEnd()
  const right = addition.trimStart()
  const trailing = base.slice(left.length)
  const breaks = trailing.match(/\r\n|\r|\n/g) ?? []
  const lastParagraph = left.replace(/\r\n?/g, '\n').split(/\n[^\S\n]*\n/).at(-1) ?? ''
  // 已有前部逐字只读，只在接缝缺少段落分隔时补换行。
  if ((breaks.length || SENTENCE_END_RE.test(left)) && !hasOpenDialogueQuote(lastParagraph)) {
    const newline = breaks.at(-1) ?? (base.includes('\r\n') ? '\r\n' : '\n')
    return base + newline.repeat(Math.max(0, 2 - breaks.length)) + right
  }
  // 原稿自带的空格随前部保留，新增端的英文分词空格只在需要时补回。
  if (!trailing && /^[^\S\r\n]/.test(addition) &&
    LATIN_SPACE_NEIGHBOR.test(left.slice(-1)) && LATIN_SPACE_NEIGHBOR.test(right[0])) {
    return base + ' ' + right
  }
  return base + right
}

/** 是否还有可格式化内容（用于按钮禁用/提示） */
export function needsChapterProseFormat(text: string): boolean {
  if (!text) return false
  return formatChapterProse(text) !== text
}
