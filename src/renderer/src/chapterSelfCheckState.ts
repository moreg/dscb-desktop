import type { ChapterSelfCheckReport } from '../../shared/types'
import { isDeferredSelfCheckItem } from '../../shared/self-check-to-requirements'

export interface ChapterDraftContext {
  projectId: string
  chapterNumber: number
  content: string
}

export interface ChapterDraftSnapshot extends ChapterDraftContext {
  revision: number
}

export interface ChapterCheckRequest extends ChapterDraftSnapshot {
  requestId: number
}

export interface ChapterSelfCheckSnapshot {
  report: ChapterSelfCheckReport
  source: ChapterDraftSnapshot
}

/**
 * Track every draft transition, including edits that are later undone. Results belong to a
 * particular chapter revision; a newer check also supersedes an older check of that revision.
 * Update this alongside the textarea ref so a callback cannot beat React's next render.
 */
export function createChapterCheckTracker(initial: ChapterDraftContext) {
  let context = { ...initial }
  let revision = 0
  let requestId = 0
  const capture = (): ChapterDraftSnapshot => ({ ...context, revision })
  const matches = (snapshot: ChapterDraftSnapshot): boolean =>
    snapshot.revision === revision &&
    snapshot.projectId === context.projectId &&
    snapshot.chapterNumber === context.chapterNumber &&
    snapshot.content === context.content

  return {
    update(next: ChapterDraftContext): void {
      if (
        next.projectId !== context.projectId ||
        next.chapterNumber !== context.chapterNumber ||
        next.content !== context.content
      ) {
        context = { ...next }
        revision += 1
      }
    },
    capture,
    matches,
    begin(): ChapterCheckRequest {
      return { ...capture(), requestId: ++requestId }
    },
    isLatest(request: ChapterCheckRequest): boolean {
      return request.requestId === requestId
    },
    accepts(request: ChapterCheckRequest): boolean {
      return request.requestId === requestId && matches(request)
    },
    invalidate(): void {
      revision += 1
      requestId += 1
    }
  }
}

/** A skipped check is unknown coverage, never evidence that the chapter passed. */
export function selfCheckStatusLabel(report: ChapterSelfCheckReport): string {
  const { fail, warn, pass, skip } = report.counts
  if (report.items.some((item) => item.id === 'self_check_error' || item.repairKind === 'execution_error')) {
    return '检查未完成'
  }
  if (fail > 0) return `${fail} 项失败`
  if (!report.ok) return '检查未完成'
  if (warn > 0) return `${warn} 项留意`
  if (skip > 0) return pass > 0 ? `已检查项通过 · ${skip} 项跳过` : '尚无可判定项'
  return pass > 0 ? '全部通过' : '尚无可判定项'
}

export function selfCheckToastType(report: ChapterSelfCheckReport): 'success' | 'info' | 'error' {
  if (!report.ok) return 'error'
  return report.counts.warn > 0 || report.counts.skip > 0 || report.counts.pass === 0 ? 'info' : 'success'
}

export function selfCheckPresentation(report: ChapterSelfCheckReport, partialChapter = false) {
  const counts = { ...report.counts }
  const deferred = new Set(report.items.filter((item) => partialChapter &&
    (item.verdict === 'fail' || item.verdict === 'warn') && isDeferredSelfCheckItem(item)).map((item) => item.id))
  for (const item of report.items) {
    if (deferred.has(item.id)) counts[item.verdict] -= 1
  }
  const effective = { ...report, counts, ok: report.ok || (report.counts.fail > 0 && counts.fail === 0) }
  const label = deferred.size > 0 && counts.fail === 0 && counts.warn === 0
    ? `${deferred.size} 项待写完`
    : selfCheckStatusLabel(effective)
  const status = !effective.ok ? 'fail' :
    counts.warn > 0 || counts.skip > 0 || deferred.size > 0 || counts.pass === 0 ? 'warn' : 'ok'
  return { counts, deferred, label, status }
}
