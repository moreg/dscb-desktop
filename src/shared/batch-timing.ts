import { MAX_BATCH_CHAPTERS } from './batch-range'

/** 单批墙钟上限：30 天。再大的记录当作损坏数据丢掉。 */
export const MAX_BATCH_TIMING_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 一批连续写作的墙钟耗时。
 * 只累计真正在跑的时间；暂停、关闭弹窗或电脑重启后的空档不计入。
 */
export interface BatchTimingState {
  /** 已经结束的运行段累计毫秒，不含当前还没闭合的一段。 */
  elapsedMs: number
  /** 当前运行段的起点。没在跑时没有。 */
  runStartedAt?: number
  /** 当前章这一段的起点。 */
  chapterStartedAt?: number
  currentChapter?: number
  /** 已完成章的耗时，含该章中断后续跑和补跑检查。 */
  chapterDurations: Record<number, number>
  /** 还没写完的章，已经累计、但当前这一段还没并进去的毫秒。 */
  chapterPartial: Record<number, number>
}

export function emptyBatchTiming(): BatchTimingState {
  return { elapsedMs: 0, chapterDurations: {}, chapterPartial: {} }
}

function clampMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(MAX_BATCH_TIMING_MS, Math.round(ms))
}

/** 把当前章尚未闭合的一段收进 partial，避免换章或暂停时丢掉。 */
function foldOpenChapter(state: BatchTimingState, now: number): BatchTimingState {
  if (state.currentChapter === undefined || state.chapterStartedAt === undefined) return state
  const segment = clampMs(now - state.chapterStartedAt)
  const previous = state.chapterPartial[state.currentChapter] ?? 0
  return {
    ...state,
    chapterStartedAt: undefined,
    chapterPartial: {
      ...state.chapterPartial,
      [state.currentChapter]: clampMs(previous + segment)
    }
  }
}

export function beginBatchRun(
  previous: BatchTimingState | null,
  mode: 'start' | 'resume' | 'retry',
  chapter: number,
  now: number
): BatchTimingState {
  const base = mode === 'start' || !previous
    ? emptyBatchTiming()
    : {
        elapsedMs: clampMs(previous.elapsedMs),
        chapterDurations: { ...previous.chapterDurations },
        chapterPartial: { ...previous.chapterPartial },
        ...(previous.currentChapter !== undefined ? { currentChapter: previous.currentChapter } : {})
      }
  return noteBatchChapter({ ...base, runStartedAt: now }, chapter, now)
}

/** 同一章的阶段切换不重新计时；换章时先收起上一章未完成的一段。 */
export function noteBatchChapter(state: BatchTimingState, chapter: number, now: number): BatchTimingState {
  if (!Number.isSafeInteger(chapter) || chapter < 1) return state
  if (state.currentChapter === chapter && state.chapterStartedAt !== undefined) return state
  const folded = foldOpenChapter(state, now)
  return { ...folded, currentChapter: chapter, chapterStartedAt: now }
}

/**
 * 一章的正文和写后检查都结束时结算。
 * 同一章后来补跑，时间加到原来的耗时上，不把前一段清掉。
 */
export function finishBatchChapter(
  state: BatchTimingState,
  chapter: number,
  now: number
): { state: BatchTimingState; durationMs: number } {
  const folded = state.currentChapter === chapter ? foldOpenChapter(state, now) : state
  const durationMs = clampMs((folded.chapterDurations[chapter] ?? 0) + (folded.chapterPartial[chapter] ?? 0))
  const chapterPartial = { ...folded.chapterPartial }
  delete chapterPartial[chapter]
  const stillThisChapter = folded.currentChapter === chapter
  return {
    durationMs,
    state: {
      ...folded,
      chapterPartial,
      chapterDurations: { ...folded.chapterDurations, [chapter]: durationMs },
      ...(stillThisChapter ? { chapterStartedAt: undefined, currentChapter: undefined } : {})
    }
  }
}

/** 停跑时收口。已经收过口再调一次，耗时不变。 */
export function pauseBatchTiming(state: BatchTimingState, now: number): BatchTimingState {
  const folded = foldOpenChapter(state, now)
  const running = state.runStartedAt !== undefined ? clampMs(now - state.runStartedAt) : 0
  return {
    elapsedMs: clampMs(folded.elapsedMs + running),
    chapterDurations: folded.chapterDurations,
    chapterPartial: folded.chapterPartial,
    ...(folded.currentChapter !== undefined ? { currentChapter: folded.currentChapter } : {})
  }
}

/**
 * 崩溃恢复时丢掉未闭合的锚点。
 * 锚点是上一进程的时钟，拿当前时间去减会把关机的空档算进去。
 * 已收进 elapsedMs / partial 的部分保留，未落盘的最后一段放弃。
 */
export function discardOpenAnchors(state: BatchTimingState): BatchTimingState {
  if (state.runStartedAt === undefined && state.chapterStartedAt === undefined) return state
  return {
    elapsedMs: state.elapsedMs,
    chapterDurations: state.chapterDurations,
    chapterPartial: state.chapterPartial,
    ...(state.currentChapter !== undefined ? { currentChapter: state.currentChapter } : {})
  }
}

/**
 * 落盘前把已经跑过的时间收进 elapsed / partial，再从现在重新起一段。
 * 这样崩溃恢复丢掉锚点时，只会丢失最后一次落盘之后的短空档。
 */
export function rollBatchTiming(state: BatchTimingState, now: number): BatchTimingState {
  const wasRunning = state.runStartedAt !== undefined
  const chapter = state.currentChapter
  const paused = pauseBatchTiming(state, now)
  if (!wasRunning) return paused
  const restarted: BatchTimingState = { ...paused, runStartedAt: now }
  return chapter !== undefined ? noteBatchChapter(restarted, chapter, now) : restarted
}

/** 写入恢复记录用的静止快照，不改内存里仍在跑的那一份。 */
export function snapshotBatchTiming(state: BatchTimingState, now = Date.now()): BatchTimingState {
  if (state.runStartedAt === undefined && state.chapterStartedAt === undefined) return state
  return pauseBatchTiming(state, now)
}

export function batchTotalMs(state: BatchTimingState, now: number): number {
  const running = state.runStartedAt !== undefined ? clampMs(now - state.runStartedAt) : 0
  return clampMs(state.elapsedMs + running)
}

/** 当前章已用时间。还没开始、也没有中断残留时返回 null。 */
export function currentChapterElapsedMs(state: BatchTimingState, now: number): number | null {
  if (state.currentChapter === undefined) return null
  const partial = state.chapterPartial[state.currentChapter] ?? 0
  const open = state.chapterStartedAt !== undefined ? clampMs(now - state.chapterStartedAt) : 0
  if (state.chapterStartedAt === undefined && partial === 0) return null
  return clampMs(partial + open)
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => value.toString().padStart(2, '0')
  if (hours > 0) return `${hours}小时${pad(minutes)}分${pad(seconds)}秒`
  if (minutes > 0) return `${minutes}分${pad(seconds)}秒`
  return `${seconds}秒`
}

export function formatChapterDurationList(durations: Record<number, number>): string {
  return Object.keys(durations)
    .map(Number)
    .filter((chapter) => Number.isSafeInteger(chapter) && chapter > 0 && Number.isFinite(durations[chapter]))
    .sort((a, b) => a - b)
    .map((chapter) => `第${chapter}章 ${formatElapsed(durations[chapter])}`)
    .join('、')
}

function readDurationMap(value: unknown): Record<number, number> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_BATCH_CHAPTERS) return null
  const map: Record<number, number> = {}
  for (const [key, raw] of entries) {
    if (!/^[1-9]\d*$/.test(key)) return null
    const chapter = Number(key)
    if (!Number.isSafeInteger(chapter)) return null
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_BATCH_TIMING_MS) return null
    map[chapter] = raw
  }
  return map
}

/** 恢复记录里的耗时。损坏时返回 null，调用方应丢掉耗时、保留批次本身。 */
export function parseBatchTiming(value: unknown, keepAnchors = false): BatchTimingState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.elapsedMs !== 'number' || !Number.isInteger(raw.elapsedMs) || raw.elapsedMs < 0 || raw.elapsedMs > MAX_BATCH_TIMING_MS) {
    return null
  }
  const chapterDurations = readDurationMap(raw.chapterDurations)
  const chapterPartial = readDurationMap(raw.chapterPartial)
  if (!chapterDurations || !chapterPartial) return null
  const state: BatchTimingState = { elapsedMs: raw.elapsedMs, chapterDurations, chapterPartial }
  if (typeof raw.currentChapter === 'number' && Number.isSafeInteger(raw.currentChapter) && raw.currentChapter > 0) {
    state.currentChapter = raw.currentChapter
  }
  if (keepAnchors) {
    if (typeof raw.runStartedAt === 'number' && Number.isSafeInteger(raw.runStartedAt) && raw.runStartedAt > 0) {
      state.runStartedAt = raw.runStartedAt
    }
    if (typeof raw.chapterStartedAt === 'number' && Number.isSafeInteger(raw.chapterStartedAt) && raw.chapterStartedAt > 0) {
      state.chapterStartedAt = raw.chapterStartedAt
    }
  }
  return state
}

// 桌面端使用单调时钟；移动端保留可持久化运行段，支持服务重启恢复。
export interface BatchTiming {
  totalMs: number
  chapters: Record<string, number>
}

/** Restore durations only: time spent with the window closed is never charged. */
export function restoreBatchTiming(value: unknown, from: number, to: number): BatchTiming {
  const empty = { totalMs: 0, chapters: {} }
  if (!value || typeof value !== 'object') return empty
  // 兼容本地旧版记录：只迁移已累计耗时，忽略已失效的运行时间锚点。
  const legacy = value as { elapsedMs?: unknown; chapterDurations?: unknown; chapterPartial?: unknown }
  if ('elapsedMs' in legacy) {
    if (typeof legacy.elapsedMs !== 'number' || !Number.isFinite(legacy.elapsedMs) || legacy.elapsedMs < 0) return empty
    const chapters: Record<string, number> = {}
    for (const durations of [legacy.chapterDurations, legacy.chapterPartial]) {
      if (!durations || typeof durations !== 'object' || Array.isArray(durations)) continue
      for (const [key, ms] of Object.entries(durations)) {
        const chapter = Number(key)
        if (Number.isSafeInteger(chapter) && chapter >= from && chapter <= to && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
          chapters[chapter] = (chapters[chapter] ?? 0) + ms
        }
      }
    }
    return { totalMs: legacy.elapsedMs, chapters }
  }
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
