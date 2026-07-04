import type { TeardownChapterBoundary } from '../../../shared/types'

/**
 * 长篇章节切片器（Stage 0.5 的确定性逻辑）。
 *
 * 这是全管道唯一的章节切片来源：Stage 0.5 跑一次，后续所有 Stage（逐章摘要、
 * 黄金三章、设定提取）都从同一份 chapterBoundaries 取切片，避免多阶段各自 regex
 * 切片导致不一致（skill 包 pipeline-ops.md 的核心约束）。
 *
 * 支持的中文章节标题格式（覆盖主流网文）：
 * - 第N章 / 第N章：标题 / 第N章 标题
 * - 第N回 / 第N节 / 第N卷
 * - 中文数字：第一章/第一十 章（一到九十九）
 * - 阿拉伯数字补零：第001章
 */

/**
 * 章节标题正则。
 * 注意：不能用 \b（单词边界），因为「章」是中文字符，\b 在中文后不生效。
 * 用 [：:．.\-—\s] 或行尾来界定标题后缀。
 */
const CHAPTER_RE = /^[ \t]*第\s*([0-9一二三四五六七八九十百千零〇两]+)\s*[章回节卷][：:．.\-—\s]?(.*)$/u

/** 中文数字 → 阿拉伯（支持 1-9999） */
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000
}

export function chineseToNumber(s: string): number | null {
  if (!s) return null
  // 纯阿拉伯数字
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  // 中文数字解析
  if (!/^[一二三四五六七八九十百千零〇两]+$/.test(s)) return null
  let total = 0
  let current = 0
  for (const ch of s) {
    const d = CN_DIGITS[ch]
    if (d === undefined) return null
    if (d >= 10) {
      // 十/百/千：乘位
      const base = current === 0 ? 1 : current
      if (d === 10) total += base * 10
      else if (d === 100) total += base * 100
      else if (d === 1000) total += base * 1000
      current = 0
    } else {
      current = d
    }
  }
  return total + current // 末尾个位（如「二十一」末尾「一」）
}

/**
 * 从原文按行扫描章节标题，生成章节边界表。
 * 每章的 start = 标题行起始；end = 下一章标题起始（末章 = 文本结尾）。
 */
/** 统一换行为 \n，供 splitChapters/extractChapterText 共用同一份归一化文本，保证偏移一致 */
function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function splitChapters(rawText: string): TeardownChapterBoundary[] {
  // 归一化换行为 \n，避免 CRLF 文件按行 split 后偏移少算 \r 的 1 字符
  const normalized = normalizeLineBreaks(rawText)
  // 按行处理，记录每章标题位置
  const lines = normalized.split('\n')
  // 计算每行在归一化文本中的字符偏移（基于 join \n）
  const lineOffsets: number[] = []
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(pos)
    pos += lines[i].length + 1 // +1 for \n
  }

  const headers: { chapter: number; title: string; offset: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(CHAPTER_RE)
    if (!m) continue
    const num = chineseToNumber(m[1])
    if (num === null || num < 1) continue
    // 标题：去前缀分隔符（：: — - 空格）
    const title = (m[2] || '').replace(/^[：:\-—\s]+/, '').trim()
    headers.push({ chapter: num, title, offset: lineOffsets[i] })
  }

  if (headers.length === 0) return []

  // 去重：同一章号取首次出现
  const seen = new Set<number>()
  const unique = headers.filter((h) => {
    if (seen.has(h.chapter)) return false
    seen.add(h.chapter)
    return true
  })

  // 生成边界
  const boundaries: TeardownChapterBoundary[] = []
  for (let i = 0; i < unique.length; i++) {
    const cur = unique[i]
    const next = unique[i + 1]
    boundaries.push({
      chapter: cur.chapter,
      title: cur.title || `第${cur.chapter}章`,
      start: cur.offset,
      end: next ? next.offset : rawText.length
    })
  }
  return boundaries
}

/**
 * 按边界表提取单章正文。
 * 入参 rawText 会被归一化为 \n 换行，与 splitChapters 计算偏移时使用的文本一致，
 * 因此调用方无论传入原始 CRLF 文本还是已归一化文本都能正确切片。
 */
export function extractChapterText(
  rawText: string,
  boundary: TeardownChapterBoundary
): string {
  const normalized = normalizeLineBreaks(rawText)
  return normalized.slice(boundary.start, boundary.end)
}
