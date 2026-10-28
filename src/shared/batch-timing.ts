export interface BatchTiming {
  totalMs: number
  chapters: Record<string, number>
}

/** Restore durations only: time spent with the window closed is never charged. */
export function restoreBatchTiming(value: unknown, from: number, to: number): BatchTiming {
  const empty = { totalMs: 0, chapters: {} }
  if (!value || typeof value !== 'object') return empty
  const timing = value as BatchTiming
  if (!Number.isFinite(timing.totalMs) || timing.totalMs < 0 || !timing.chapters || typeof timing.chapters !== 'object') return empty
  const chapters: Record<string, number> = {}
  for (const [key, ms] of Object.entries(timing.chapters)) {
    const chapter = Number(key)
    if (Number.isSafeInteger(chapter) && chapter >= from && chapter <= to && Number.isFinite(ms) && ms >= 0) chapters[chapter] = ms
  }
  return { totalMs: timing.totalMs, chapters }
}

/** One active chapter at a time; repeated stage events do not restart its clock. */
export class BatchClock {
  private timing: BatchTiming
  private since: number | null = null
  private chapter: number | null = null

  constructor(initial: BatchTiming = { totalMs: 0, chapters: {} }) {
    this.timing = { totalMs: initial.totalMs, chapters: { ...initial.chapters } }
  }

  start(chapter: number, now: number): void {
    this.snapshot(now)
    this.since = now
    this.chapter = chapter
    this.timing.chapters[chapter] ??= 0
  }

  finishChapter(chapter: number, now: number): void {
    this.snapshot(now)
    if (this.chapter === chapter) this.chapter = null
  }

  stop(now: number): BatchTiming {
    const result = this.snapshot(now)
    this.since = null
    this.chapter = null
    return result
  }

  snapshot(now: number): BatchTiming {
    if (this.since !== null) {
      const delta = Math.max(0, now - this.since)
      this.timing.totalMs += delta
      if (this.chapter !== null) this.timing.chapters[this.chapter] += delta
      this.since = Math.max(this.since, now)
    }
    return { totalMs: this.timing.totalMs, chapters: { ...this.timing.chapters } }
  }
}

export function formatBatchDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const rest = seconds % 60
  if (hours) return `${hours}小时${minutes}分${rest}秒`
  if (minutes) return `${minutes}分${rest}秒`
  return `${rest}秒`
}
