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

/** 是否还有可格式化内容（用于按钮禁用/提示） */
export function needsChapterProseFormat(text: string): boolean {
  if (!text) return false
  return formatChapterProse(text) !== text
}
