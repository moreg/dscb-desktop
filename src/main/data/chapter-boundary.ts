import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import type { ChapterDetail, OutlineDiffReport } from '../../shared/types'
import { missingForeshadowings } from './foreshadowing-repair'

function boundaryText(detail: ChapterDetail): string {
  // Keep literal text (not JSON escapes) so evidence quotes can be located exactly.
  const lines = new Set<string>()
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'rawFields' || key === 'proseSections') continue
    if (typeof value === 'string' && value.trim()) lines.add(`${key}：${value}`)
    else if (Array.isArray(value) && value.length) lines.add(`${key}：${value.join('；')}`)
  }
  for (const [key, value] of Object.entries(detail.rawFields ?? {})) {
    lines.add(`${key}：${Array.isArray(value) ? value.join('；') : value}`)
  }
  for (const section of detail.proseSections ?? []) lines.add(`${section.title}\n${section.text}`)
  return [...lines].join('\n')
}

/** Read the actual chapter plans, including prose-only prohibitions. Never derive a boundary from generated prose. */
export async function readChapterBoundary(dir: string, chapterNumber: number): Promise<string> {
  const repo = new DetailedOutlineMdRepo(dir)
  const chapters = await Promise.all([0, 1, 2, 3].map(offset => repo.readChapter(chapterNumber + offset)))
  const sections = chapters.flatMap((detail, offset) => detail ? [
    `${offset === 0 ? '本章允许推进的事件、揭示范围与停止位置' : '后章计划，只作禁止提前兑现的边界'}（第 ${chapterNumber + offset} 章）：\n${boundaryText(detail)}`
  ] : [])
  if (!sections.length) return ''
  const boundary = sections.join('\n\n')
  if (boundary.length > 24_000) throw new Error('CHAPTER_BOUNDARY_TOO_LARGE: 本章及后续三章细纲超过24000字符，请精简后重试；不会截断禁区后放行。')
  return boundary
}

/** Explicit scope violations cannot be erased by fixing omissions or rebasing the outline. */
export function assertOutlineBoundary(report: OutlineDiffReport): void {
  const violations = report.diffs.filter(diff => diff.boundaryViolation === true || (
    diff.boundaryViolation === undefined && diff.priority !== 'P2' && (
      diff.type === 2 || ([4, 5].includes(diff.type) && diff.resolution === 'updateContent')
    )
  ))
  if (violations.length) throw new Error(`LONGFORM_CONFLICT: 章节边界核对发现越界，已暂停交稿与同步；须修正文，不能回写细纲消除：\n${violations.map(diff =>
    `细纲：${diff.outline ?? ''}\n正文：${diff.actual ?? ''}\n修正：${diff.suggestion}`).join('\n')}`)
}

/** Single and batch writing must repair required events before accepting or rebasing prose. */
export function requiredChapterEventOmissions(report: OutlineDiffReport, plans: readonly string[] = [],
  allowForeshadowOmissions = false): OutlineDiffReport['diffs'] {
  const clues = allowForeshadowOmissions ? missingForeshadowings(report, plans) : []
  return report.diffs.filter(diff => diff.type === 1 && diff.priority !== 'P2' && !clues.includes(diff))
}

export function assertChapterOutlineRequirements(report: OutlineDiffReport, plans: readonly string[] = [],
  allowForeshadowOmissions = false): void {
  assertOutlineBoundary(report)
  const missing = requiredChapterEventOmissions(report, plans, allowForeshadowOmissions)
  if (missing.length) throw new Error(`LONGFORM_CONFLICT: 本章细纲必需剧情漏写，须先补正文并复核，不能删改细纲消除：\n${missing.map(diff =>
    `细纲：${diff.outline ?? ''}\n正文：${diff.actual ?? ''}\n修正：${diff.suggestion}`).join('\n')}`)
}
