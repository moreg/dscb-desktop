import { formatChapterProse } from '../../shared/format-chapter-prose'

/** 无论最终稿是否等于生成前正文，都要覆盖流式预览。 */
export function finalizeChapterRewrite(content: string, commit: (text: string) => void): string {
  const formatted = formatChapterProse(content)
  commit(formatted)
  return formatted
}
