import { describe, expect, it } from 'vitest'
import { BatchClock, formatBatchDuration, restoreBatchTiming } from '../src/shared/batch-timing'
import { parseSavedBatchSession, recoverBatchProgress } from '../src/renderer/src/ChapterListPage'

describe('batch elapsed time', () => {
  it('accumulates stages and waiting without restarting a chapter, then freezes completed chapters', () => {
    const clock = new BatchClock()
    clock.start(10, 1000)
    clock.start(10, 6000) // writing -> polishing
    clock.start(10, 36000) // rate-limit wait -> retry
    clock.finishChapter(10, 41000)
    clock.start(11, 42000)
    expect(clock.snapshot(47000)).toEqual({ totalMs: 46000, chapters: { 10: 40000, 11: 5000 } })
    expect(clock.stop(52000)).toEqual({ totalMs: 51000, chapters: { 10: 40000, 11: 10000 } })
    expect(clock.snapshot(999000).totalMs).toBe(51000)
  })

  it('excludes pauses and restores only accumulated time across reopening and retrying the same chapter', () => {
    const clock = new BatchClock()
    clock.start(1, 0)
    const paused = clock.stop(10000)
    const saved = parseSavedBatchSession(JSON.stringify({
      progress: recoverBatchProgress(1, 10, [], 'stopped'),
      autoContinue: true, autoStrength: true, styleProfileId: null, timing: paused
    }))
    expect(saved?.timing).toEqual(paused)
    const restored = new BatchClock(saved?.timing)
    expect(restored.snapshot(500000)).toEqual(paused)
    restored.start(1, 900000)
    expect(restored.stop(905000)).toEqual({ totalMs: 15000, chapters: { 1: 15000 } })
  })

  it('ignores invalid stored durations without losing resumable progress', () => {
    expect(restoreBatchTiming({ totalMs: -1, chapters: {} }, 1, 10)).toEqual({ totalMs: 0, chapters: {} })
    expect(restoreBatchTiming({ totalMs: 5000, chapters: { 1: 2000, 2: -100, 99: 3000 } }, 1, 10))
      .toEqual({ totalMs: 5000, chapters: { 1: 2000 } })
    expect(new BatchClock().snapshot(1000)).toEqual({ totalMs: 0, chapters: {} })
  })

  it('formats seconds, minutes and hours without wrapping at an hour', () => {
    expect([0, 59999, 60000, 3661000].map(formatBatchDuration))
      .toEqual(['0秒', '59秒', '1分0秒', '1小时1分1秒'])
  })
})
