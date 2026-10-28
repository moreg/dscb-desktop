import { describe, expect, it } from 'vitest'
import {
  batchTotalMs,
  beginBatchRun,
  currentChapterElapsedMs,
  discardOpenAnchors,
  finishBatchChapter,
  formatChapterDurationList,
  formatElapsed,
  noteBatchChapter,
  parseBatchTiming,
  pauseBatchTiming,
  rollBatchTiming,
  snapshotBatchTiming
} from '../src/shared/batch-timing'

describe('一键批次耗时', () => {
  it('同一章的阶段切换不重置，完成时记入该章', () => {
    const started = beginBatchRun(null, 'start', 3, 1_000)
    expect(noteBatchChapter(started, 3, 4_000)).toBe(started)
    const done = finishBatchChapter(started, 3, 6_000)
    expect(done.durationMs).toBe(5_000)
    expect(done.state.chapterDurations).toEqual({ 3: 5_000 })
    expect(batchTotalMs(done.state, 6_000)).toBe(5_000)
    expect(currentChapterElapsedMs(done.state, 6_000)).toBeNull()
  })

  it('暂停不把离开的空档算进去，继续后同一章前后相加', () => {
    let timing = beginBatchRun(null, 'start', 1, 1_000)
    timing = pauseBatchTiming(timing, 4_000)
    expect(batchTotalMs(timing, 50_000)).toBe(3_000)
    expect(currentChapterElapsedMs(timing, 50_000)).toBe(3_000)
    timing = beginBatchRun(timing, 'resume', 1, 50_000)
    const done = finishBatchChapter(timing, 1, 56_000)
    expect(done.durationMs).toBe(9_000)
    expect(batchTotalMs(done.state, 56_000)).toBe(9_000)
  })

  it('补跑已经完成的章时，新的一段加到原耗时上', () => {
    const first = finishBatchChapter(beginBatchRun(null, 'start', 4, 0), 4, 5_000)
    const paused = pauseBatchTiming(first.state, 5_000)
    const resumed = beginBatchRun(paused, 'resume', 4, 20_000)
    const second = finishBatchChapter(resumed, 4, 23_000)
    expect(second.durationMs).toBe(8_000)
    expect(batchTotalMs(second.state, 23_000)).toBe(8_000)
  })

  it('换章先收起上一章未完成的一段，新章单独计时', () => {
    const started = beginBatchRun(null, 'start', 1, 0)
    const next = noteBatchChapter(started, 2, 5_000)
    const done = finishBatchChapter(next, 2, 8_000)
    expect(done.durationMs).toBe(3_000)
    expect(done.state.chapterPartial[1]).toBe(5_000)
    expect(done.state.chapterDurations).toEqual({ 2: 3_000 })
  })

  it('重新开始一批不沿用上一批', () => {
    const paused = pauseBatchTiming(beginBatchRun(null, 'start', 1, 0), 5_000)
    const restarted = beginBatchRun(paused, 'start', 8, 9_000)
    expect(batchTotalMs(restarted, 9_000)).toBe(0)
    expect(restarted.chapterDurations).toEqual({})
    expect(restarted.chapterPartial).toEqual({})
    expect(restarted.currentChapter).toBe(8)
  })

  it('重复暂停不把耗时越加越多', () => {
    const paused = pauseBatchTiming(beginBatchRun(null, 'start', 2, 100), 2_100)
    expect(pauseBatchTiming(paused, 9_100).elapsedMs).toBe(2_000)
  })

  it('快照收口但不改仍在跑的原记录', () => {
    const running = beginBatchRun(null, 'start', 6, 1_000)
    const shot = snapshotBatchTiming(running, 4_000)
    expect(shot.elapsedMs).toBe(3_000)
    expect(shot.runStartedAt).toBeUndefined()
    expect(batchTotalMs(running, 4_000)).toBe(3_000)
    expect(running.runStartedAt).toBe(1_000)
  })

  it('落盘收口后再继续，已经计入的时间不重复加', () => {
    const rolled = rollBatchTiming(beginBatchRun(null, 'start', 1, 0), 5_000)
    expect(batchTotalMs(rolled, 5_000)).toBe(5_000)
    expect(currentChapterElapsedMs(rolled, 5_000)).toBe(5_000)
    const done = finishBatchChapter(rolled, 1, 8_000)
    expect(done.durationMs).toBe(8_000)
    expect(batchTotalMs(done.state, 8_000)).toBe(8_000)
    const recovered = discardOpenAnchors(rolled)
    expect(batchTotalMs(recovered, 90_000)).toBe(5_000)
    expect(currentChapterElapsedMs(recovered, 90_000)).toBe(5_000)
  })

  it('丢掉崩溃时的锚点，不把关机空档算进总耗时', () => {
    const running = beginBatchRun(null, 'start', 2, 1_000)
    const recovered = discardOpenAnchors(running)
    expect(recovered.runStartedAt).toBeUndefined()
    expect(recovered.chapterStartedAt).toBeUndefined()
    expect(batchTotalMs(recovered, 80_000)).toBe(0)
    expect(currentChapterElapsedMs(recovered, 80_000)).toBeNull()
  })

  it('格式按小时、分、秒显示，不足一分钟只显示秒', () => {
    expect(formatElapsed(0)).toBe('0秒')
    expect(formatElapsed(45_900)).toBe('45秒')
    expect(formatElapsed(65_000)).toBe('1分05秒')
    expect(formatElapsed(3_723_000)).toBe('1小时02分03秒')
    expect(formatChapterDurationList({ 2: 65_000, 10: 3_000 })).toBe('第2章 1分05秒、第10章 3秒')
  })

  it('恢复时丢掉损坏耗时；默认不恢复会继续走动的锚点', () => {
    expect(parseBatchTiming(null)).toBeNull()
    expect(parseBatchTiming({ elapsedMs: -1, chapterDurations: {}, chapterPartial: {} })).toBeNull()
    expect(parseBatchTiming({ elapsedMs: 1.5, chapterDurations: {}, chapterPartial: {} })).toBeNull()
    expect(parseBatchTiming({ elapsedMs: 1000, chapterDurations: { bad: 1 }, chapterPartial: {} })).toBeNull()
    const parsed = parseBatchTiming({
      elapsedMs: 4000,
      runStartedAt: 1000,
      chapterStartedAt: 1000,
      currentChapter: 3,
      chapterDurations: { 2: 1500 },
      chapterPartial: { 3: 500 }
    })
    expect(parsed).toEqual({
      elapsedMs: 4000,
      currentChapter: 3,
      chapterDurations: { 2: 1500 },
      chapterPartial: { 3: 500 }
    })
    expect(parseBatchTiming({
      elapsedMs: 4000,
      runStartedAt: 1000,
      chapterStartedAt: 1000,
      currentChapter: 3,
      chapterDurations: {},
      chapterPartial: {}
    }, true)).toMatchObject({ runStartedAt: 1000, chapterStartedAt: 1000 })
  })
})
