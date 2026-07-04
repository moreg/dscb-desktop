import { describe, it, expect } from 'vitest'
import {
  createLongProgress,
  createShortMeta,
  markStageComplete,
  markStageInProgress,
  nextStage,
  isPausedAfterStage1,
  isComplete,
  routeByWordCount,
  validateStructureCounts,
  buildProgressInfo,
  LONG_STAGES,
  SHORT_STAGES
} from '../src/main/data/teardown/teardown-state'

describe('teardown-state 长篇状态机', () => {
  it('createLongProgress 初始化为空阶段', () => {
    const p = createLongProgress('盘龙', [
      { chapter: 1, title: '第一章', start: 0, end: 1000 }
    ])
    expect(p.schemaVersion).toBe(2)
    expect(p.bookName).toBe('盘龙')
    expect(p.stagesCompleted).toEqual([])
    expect(p.pausedAfterStage1).toBe(false)
    expect(p.failures).toEqual([])
  })

  it('markStageInProgress 设置 lastStageInProgress', () => {
    const p = createLongProgress('盘龙', [])
    const p2 = markStageInProgress(p, 2)
    expect(p2.lastStageInProgress).toBe(2)
    expect(p.lastStageInProgress).toBeUndefined() // 不可变
  })

  it('markStageComplete 追加阶段并清空 lastStageInProgress', () => {
    let p = createLongProgress('盘龙', [])
    p = markStageInProgress(p, 0)
    p = markStageComplete(p, 0)
    expect(p.stagesCompleted).toEqual([0])
    expect(p.lastStageInProgress).toBeUndefined()

    p = markStageComplete(p, 0.5)
    p = markStageComplete(p, 1)
    expect(p.stagesCompleted).toEqual([0, 0.5, 1])
  })

  it('markStageComplete 保持阶段顺序（即使乱序完成）', () => {
    let p = createLongProgress('盘龙', [])
    p = markStageComplete(p, 1)
    p = markStageComplete(p, 0)
    p = markStageComplete(p, 0.5)
    expect(p.stagesCompleted).toEqual([0, 0.5, 1])
  })

  it('nextStage 返回第一个未完成阶段', () => {
    expect(nextStage('long', [])).toBe(0)
    expect(nextStage('long', [0, 0.5])).toBe(1)
    expect(nextStage('long', [0, 0.5, 1, 2])).toBe(3)
  })

  it('nextStage 全部完成返回 null', () => {
    expect(nextStage('long', LONG_STAGES)).toBeNull()
  })

  it('isPausedAfterStage1 识别停靠点', () => {
    let p = createLongProgress('盘龙', [])
    p = markStageComplete(p, 0)
    p = markStageComplete(p, 0.5)
    p = markStageComplete(p, 1)
    p = { ...p, pausedAfterStage1: true }
    expect(isPausedAfterStage1(p)).toBe(true)

    // 进了 Stage 2 就不再算停靠
    p = markStageComplete(p, 2)
    expect(isPausedAfterStage1(p)).toBe(false)
  })

  it('isComplete 识别管道完成', () => {
    expect(isComplete('long', LONG_STAGES)).toBe(true)
    expect(isComplete('long', [0, 1, 2, 3, 4, 5])).toBe(false) // 缺 6
    expect(isComplete('long', [...LONG_STAGES, 6])).toBe(true)
  })
})

describe('teardown-state 短篇状态机', () => {
  it('createShortMeta 初始化', () => {
    const m = createShortMeta('曾将爱意私藏', 8500)
    expect(m.version).toBe(1)
    expect(m.wordCount).toBe(8500)
    expect(m.stagesCompleted).toEqual([])
    expect(m.structureCounts.beats).toBe(0)
  })

  it('nextStage 短篇从 2 开始', () => {
    expect(nextStage('short', [])).toBe(2)
    expect(nextStage('short', [2])).toBe(3)
    expect(nextStage('short', SHORT_STAGES)).toBeNull()
  })

  it('isComplete 短篇', () => {
    expect(isComplete('short', SHORT_STAGES)).toBe(true)
    expect(isComplete('short', [2, 3, 4, 5])).toBe(false)
  })
})

describe('teardown-state 字数路由', () => {
  it('<15000 字判为短篇', () => {
    expect(routeByWordCount(5000)).toEqual({ lengthKind: 'short', isGrayZone: false })
    expect(routeByWordCount(14999)).toEqual({ lengthKind: 'short', isGrayZone: false })
  })

  it('>20000 字判为长篇', () => {
    expect(routeByWordCount(25000)).toEqual({ lengthKind: 'long', isGrayZone: false })
    expect(routeByWordCount(100000)).toEqual({ lengthKind: 'long', isGrayZone: false })
  })

  it('15000-20000 灰区默认短篇 + 标记', () => {
    expect(routeByWordCount(15000)).toEqual({ lengthKind: 'short', isGrayZone: true })
    expect(routeByWordCount(18000)).toEqual({ lengthKind: 'short', isGrayZone: true })
    expect(routeByWordCount(20000)).toEqual({ lengthKind: 'short', isGrayZone: true })
    expect(routeByWordCount(20001)).toEqual({ lengthKind: 'long', isGrayZone: false })
  })
})

describe('teardown-state Phase 7 结构校验', () => {
  it('达标时 ok=true', () => {
    expect(
      validateStructureCounts({
        beats: 5,
        hooks: 4,
        setupClues: 3,
        characterArchetypes: 3,
        reusableStructures: 4
      }).ok
    ).toBe(true)
  })

  it('beats<4 不达标', () => {
    const r = validateStructureCounts({
      beats: 3,
      hooks: 5,
      setupClues: 5,
      characterArchetypes: 5,
      reusableStructures: 5
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('功能分段不足'))).toBe(true)
  })

  it('hooks<3 不达标', () => {
    const r = validateStructureCounts({
      beats: 5,
      hooks: 2,
      setupClues: 5,
      characterArchetypes: 5,
      reusableStructures: 5
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('钩子不足'))).toBe(true)
  })

  it('setupClues<3 不达标', () => {
    const r = validateStructureCounts({
      beats: 5,
      hooks: 5,
      setupClues: 2,
      characterArchetypes: 5,
      reusableStructures: 5
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('铺垫线索不足'))).toBe(true)
  })

  it('archetypes<2 不达标', () => {
    const r = validateStructureCounts({
      beats: 5,
      hooks: 5,
      setupClues: 5,
      characterArchetypes: 1,
      reusableStructures: 5
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('角色原型不足'))).toBe(true)
  })

  it('reusable<3 不达标', () => {
    const r = validateStructureCounts({
      beats: 5,
      hooks: 5,
      setupClues: 5,
      characterArchetypes: 5,
      reusableStructures: 2
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('可复用结构不足'))).toBe(true)
  })
})

describe('teardown-state buildProgressInfo', () => {
  it('进行中阶段显示正确状态文本', () => {
    const info = buildProgressInfo('盘龙', 'long', [0, 0.5], 1)
    expect(info.currentStage).toBe(1)
    expect(info.statusText).toContain('黄金三章')
  })

  it('Stage 2 显示章节进度', () => {
    const info = buildProgressInfo('盘龙', 'long', [0, 0.5, 1], 2, { done: 5, total: 20 })
    expect(info.chapterProgress).toEqual({ done: 5, total: 20 })
    expect(info.statusText).toContain('5/20')
  })

  it('全部完成显示拆解完成', () => {
    const info = buildProgressInfo('盘龙', 'long', LONG_STAGES)
    expect(info.statusText).toBe('拆解完成')
    expect(info.currentStage).toBeNull()
  })

  it('短篇 Stage 标签', () => {
    const info = buildProgressInfo('短篇', 'short', [], 2)
    expect(info.statusText).toContain('结构与情节节点')
  })
})
