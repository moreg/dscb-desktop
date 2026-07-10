/**
 * 节奏图谱 HTML 构建纯函数（供 generateRhythmHtml 与 persistOpening 复用）。
 * 从 opening-service.ts 提取，避免 service 文件过长。
 */

import { RHYTHM_HTML_TEMPLATE } from './skill-prompts/opening/rhythm-html-template'
import { extractRhythmFromText } from './skill-format/outline-md-repo'

/** 从大纲 Markdown 文本提取逐章节奏条目（内存版，不读文件） */
export function extractRhythmFromMarkdown(mainOutlineContent: string) {
  return extractRhythmFromText(mainOutlineContent)
}

/**
 * 用 rhythmData 条目填充节奏图谱 HTML 模板。
 * - 用 JSON.stringify 安全注入字符串值，避免 `</script>` 提前闭合脚本块或 `$` 触发 replace 特殊语义
 * - 用函数形式替换 __RHYTHM_ENTRIES__，避免 innerEntries 中可能出现的 `$&`/`$1`/`$'` 被 String.replace 当作特殊模式
 * - bookName 来自 project.name（用户可控），做 HTML 转义防 XSS
 */
export function buildRhythmHtml(
  rhythmEntries: Array<{ chapter: number; title: string; emotion: number; climax: number; volume: number; actualized: boolean }>,
  bookName: string,
  today: string,
  totalChapters: number
): string {
  // HTML 转义 bookName（注入到 <title> 和 <h1>，防 XSS）
  const safeBookName = bookName
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  let htmlContent = RHYTHM_HTML_TEMPLATE
    .replace(/__BOOK_NAME__/g, safeBookName)
    .replace(/__CREATE_DATE__/g, today)
    .replace(/__TOTAL_CHAPTERS__/g, String(totalChapters))

  const innerEntries = rhythmEntries
    .map((e) => {
      return (
        '            { chapter: ' + e.chapter +
        ', title: ' + JSON.stringify(e.title) +
        ', emotion: ' + e.emotion +
        ', climax: ' + e.climax +
        ', volume: ' + e.volume +
        ', actualized: ' + e.actualized + ' }'
      )
    })
    .join(',\n')
  htmlContent = htmlContent.replace('__RHYTHM_ENTRIES__', () => innerEntries)
  return htmlContent
}
