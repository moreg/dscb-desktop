import { describe, it, expect } from 'vitest'
import {
  computeCost,
  summarizeUsage,
  formatTokens,
  formatCost,
  formatRelativeTime,
  evaluateCostAlert,
  shouldBlockAiGenerate,
  aggregateByDay,
  aggregateByDayWithCost,
  aggregateByProject,
  aggregateByChapter,
  filterByDate,
  filterByChapter,
  DEFAULT_COST_THRESHOLDS,
  type UsageRecord
} from '../src/main/data/usage-summary'

const PRICING = { inputRate: 1, outputRate: 3 } // 1 元/百万 input, 3 元/百万 output

describe('computeCost', () => {
  it('zero tokens → zero cost', () => {
    expect(computeCost(0, 0, PRICING)).toBe(0)
  })

  it('1M input tokens + 0 output → 1 元', () => {
    expect(computeCost(1_000_000, 0, PRICING)).toBe(1)
  })

  it('0 input + 1M output → 3 元', () => {
    expect(computeCost(0, 1_000_000, PRICING)).toBe(3)
  })

  it('mixed: 1M input + 1M output → 4 元', () => {
    expect(computeCost(1_000_000, 1_000_000, PRICING)).toBe(4)
  })

  it('500K input + 500K output → 2 元', () => {
    expect(computeCost(500_000, 500_000, PRICING)).toBe(2)
  })

  it('respects custom pricing (DeepSeek-style 1/2)', () => {
    expect(computeCost(1_000_000, 1_000_000, { inputRate: 1, outputRate: 2 })).toBe(3)
  })

  it('small token counts (e.g. 1K input + 500 output) → small cost', () => {
    const cost = computeCost(1000, 500, PRICING)
    expect(cost).toBeCloseTo(0.001 + 0.0015, 6)
  })
})

describe('summarizeUsage', () => {
  it('empty records → all zero + empty byFeature', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const s = summarizeUsage([], PRICING, now)
    expect(s.today).toEqual({ input: 0, output: 0, total: 0, cost: 0 })
    expect(s.month).toEqual({ input: 0, output: 0, total: 0, cost: 0 })
    expect(s.allTime).toEqual({ input: 0, output: 0, total: 0, cost: 0 })
    expect(s.byFeature).toEqual([])
  })

  it('single record today → all buckets include it', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T05:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    expect(s.today.total).toBe(2_000_000)
    expect(s.today.cost).toBe(4)
    expect(s.month.total).toBe(2_000_000)
    expect(s.allTime.total).toBe(2_000_000)
    expect(s.byFeature).toEqual([{ feature: '正文续写', total: 2_000_000, cost: 4, calls: 1 }])
  })

  it('record from yesterday → only allTime, not today', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-21T23:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    expect(s.today.total).toBe(0)
    expect(s.month.total).toBe(1_000_000) // 同月
    expect(s.allTime.total).toBe(1_000_000)
  })

  it('record from last month → only allTime', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-05-15T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    expect(s.today.total).toBe(0)
    expect(s.month.total).toBe(0)
    expect(s.allTime.total).toBe(1_000_000)
  })

  it('aggregates by feature (multiple records same feature)', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T01:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      { at: '2026-06-22T02:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    const chapterEntry = s.byFeature.find((f) => f.feature === '正文续写')!
    expect(chapterEntry.total).toBe(3_000_000)
    expect(chapterEntry.calls).toBe(2)
    // (1M/1M)*1 + (1M/1M)*3 + (0.5M/1M)*1 + (0.5M/1M)*3 = 1+3+0.5+1.5 = 6 元
    expect(chapterEntry.cost).toBeCloseTo(6, 6)
  })

  it('sorts byFeature by total descending', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T01:00:00Z', feature: 'review', model: 'test-model', inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
      { at: '2026-06-22T02:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      { at: '2026-06-22T03:00:00Z', feature: 'humanize', model: 'test-model', inputTokens: 50_000, outputTokens: 50_000, totalTokens: 100_000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    expect(s.byFeature.map((f) => f.feature)).toEqual([
      '正文续写', // 2M 最大
      '改稿建议', // 100K
      'AI 改写'   // 100K（后注册排后）
    ])
  })

  it('translates feature keys to Chinese labels (FEATURE_LABELS)', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T01:00:00Z', feature: 'outline-main', model: 'test-model', inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      { at: '2026-06-22T02:00:00Z', feature: 'cast', model: 'test-model', inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    const labels = s.byFeature.map((f) => f.feature)
    expect(labels).toContain('总纲生成')
    expect(labels).toContain('登场识别')
  })

  it('unknown feature key falls through to original key as label', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T01:00:00Z', feature: 'my-custom-feature', model: 'test-model', inputTokens: 100, outputTokens: 100, totalTokens: 200 }
    ]
    const s = summarizeUsage(records, PRICING, now)
    expect(s.byFeature[0].feature).toBe('my-custom-feature')
  })

  it('does not mutate input records (immutability)', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T01:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }
    ]
    const snapshot = JSON.stringify(records)
    summarizeUsage(records, PRICING, now)
    expect(JSON.stringify(records)).toBe(snapshot)
  })
})

describe('formatTokens', () => {
  it('zero → "0"', () => {
    expect(formatTokens(0)).toBe('0')
  })

  it('500 → "500"', () => {
    expect(formatTokens(500)).toBe('500')
  })

  it('999 → "999"', () => {
    expect(formatTokens(999)).toBe('999')
  })

  it('1000 → "1.0k"', () => {
    expect(formatTokens(1000)).toBe('1.0k')
  })

  it('1500 → "1.5k"', () => {
    expect(formatTokens(1500)).toBe('1.5k')
  })

  it('12345 → "12.3k"', () => {
    expect(formatTokens(12345)).toBe('12.3k')
  })

  it('1_000_000 → "1.00M"', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M')
  })

  it('1_500_000 → "1.50M"', () => {
    expect(formatTokens(1_500_000)).toBe('1.50M')
  })
})

describe('formatCost', () => {
  it('zero → "¥0.0000"', () => {
    expect(formatCost(0)).toBe('¥0.0000')
  })

  it('0.005 → "¥0.0050" (smallest precision)', () => {
    expect(formatCost(0.005)).toBe('¥0.0050')
  })

  it('0.05 → "¥0.050"', () => {
    expect(formatCost(0.05)).toBe('¥0.050')
  })

  it('1.5 → "¥1.50"', () => {
    expect(formatCost(1.5)).toBe('¥1.50')
  })

  it('100 → "¥100.00"', () => {
    expect(formatCost(100)).toBe('¥100.00')
  })
})

describe('P10-A 集成: 真实使用场景', () => {
  it('一天多次 LLM 调用汇总', () => {
    const now = new Date('2026-06-22T18:00:00Z')
    const records: UsageRecord[] = [
      // 早晨 3 次续写
      { at: '2026-06-22T08:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 2_000_000, outputTokens: 2_000_000, totalTokens: 4_000_000 },
      { at: '2026-06-22T09:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_500_000, outputTokens: 2_000_000, totalTokens: 3_500_000 },
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_500_000, totalTokens: 2_500_000 },
      // 中午 1 次审稿
      { at: '2026-06-22T13:00:00Z', feature: 'review', model: 'test-model', inputTokens: 5_000_000, outputTokens: 500_000, totalTokens: 5_500_000 },
      // 下午 2 次 AI 改写
      { at: '2026-06-22T15:00:00Z', feature: 'humanize', model: 'test-model', inputTokens: 200, outputTokens: 200, totalTokens: 400 },
      { at: '2026-06-22T15:30:00Z', feature: 'humanize', model: 'test-model', inputTokens: 200, outputTokens: 300, totalTokens: 500 }
    ]
    const s = summarizeUsage(records, PRICING, now)

    // 今日 = 全部 6 条，totalTokens = 4M + 3.5M + 2.5M + 5.5M + 400 + 500 = 15_500_900
    expect(s.today.total).toBe(15_500_900)
    // 续写总 = 4M+3.5M+2.5M = 10M → 4M*1/1M*1 + 2.5M*1/1M*3 = 1 + 7.5 = 8.5 + ?
    // 实际：(2M*1 + 2M*3) + (1.5M*1 + 2M*3) + (1M*1 + 1.5M*3) = 8 + 7.5 + 5.5 = 21 元
    // 审稿：5M*1 + 0.5M*3 = 5 + 1.5 = 6.5 元
    // humanize 2 条：0.0004 元（太小四舍五入）— 实际 (0.2/1M)*1 + (0.2/1M)*3 ≈ 极小
    const chapterEntry = s.byFeature.find((f) => f.feature === '正文续写')!
    expect(chapterEntry.cost).toBeCloseTo(21, 4)
    expect(chapterEntry.calls).toBe(3)
    const reviewEntry = s.byFeature.find((f) => f.feature === '改稿建议')!
    expect(reviewEntry.cost).toBeCloseTo(6.5, 4)
    expect(reviewEntry.calls).toBe(1)
  })
})

describe('formatRelativeTime (P11-A 保存指示器)', () => {
  it('同一时间 → "刚刚"', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t)).toBe('刚刚')
  })

  it('< 5 秒 → "刚刚"（避免频繁刷新抖动）', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t + 3_000)).toBe('刚刚')
    expect(formatRelativeTime(t, t + 4_999)).toBe('刚刚')
  })

  it('5-59 秒 → "X 秒前"', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t + 5_000)).toBe('5 秒前')
    expect(formatRelativeTime(t, t + 30_000)).toBe('30 秒前')
    expect(formatRelativeTime(t, t + 59_000)).toBe('59 秒前')
  })

  it('60-3599 秒 → "X 分钟前"', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t + 60_000)).toBe('1 分钟前')
    expect(formatRelativeTime(t, t + 5 * 60_000)).toBe('5 分钟前')
    expect(formatRelativeTime(t, t + 59 * 60_000)).toBe('59 分钟前')
  })

  it('1-23 小时 → "X 小时前"', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t + 60 * 60_000)).toBe('1 小时前')
    expect(formatRelativeTime(t, t + 5 * 60 * 60_000)).toBe('5 小时前')
    expect(formatRelativeTime(t, t + 23 * 60 * 60_000)).toBe('23 小时前')
  })

  it('≥ 24 小时 → "X 天前"', () => {
    const t = 1_000_000
    expect(formatRelativeTime(t, t + 24 * 60 * 60_000)).toBe('1 天前')
    expect(formatRelativeTime(t, t + 3 * 24 * 60 * 60_000)).toBe('3 天前')
    expect(formatRelativeTime(t, t + 30 * 24 * 60 * 60_000)).toBe('30 天前')
  })

  it('未来时间戳（now < timestamp）→ "刚刚"（负差值兜底）', () => {
    const t = 1_000_000
    // now 比 timestamp 早 5 秒（模拟时钟漂移）→ 应显示"刚刚"而非负数
    expect(formatRelativeTime(t, t - 5_000)).toBe('刚刚')
  })

  it('跨午夜边界：从 23:59 到 00:01 算 2 分钟前', () => {
    // 验证用整数秒数计算，不受日期边界影响
    const t = 1_700_000_000_000 // 任意基准
    expect(formatRelativeTime(t, t + 2 * 60_000)).toBe('2 分钟前')
  })

  it('0 时刻 → "刚刚"', () => {
    expect(formatRelativeTime(0, 0)).toBe('刚刚')
  })

  it('大数值（很久以前）→ "X 天前" 不溢出', () => {
    const t = 0
    const now = 365 * 24 * 60 * 60 * 1000 // 一年后
    expect(formatRelativeTime(t, now)).toBe('365 天前')
  })
})

describe('evaluateCostAlert (P12-C 用量预警)', () => {
  const T = { warning: 10, exceeded: 30 }

  it('0 元 → ok', () => {
    const r = evaluateCostAlert(0, T)
    expect(r.level).toBe('ok')
    expect(r.cost).toBe(0)
  })

  it('低于 warning → ok', () => {
    const r = evaluateCostAlert(5, T)
    expect(r.level).toBe('ok')
    expect(r.cost).toBe(5)
  })

  it('恰好等于 warning → warning（含 threshold）', () => {
    const r = evaluateCostAlert(10, T)
    expect(r.level).toBe('warning')
    expect(r.cost).toBe(10)
    expect(r.threshold).toBe(10)
  })

  it('warning 与 exceeded 之间 → warning', () => {
    expect(evaluateCostAlert(15, T).level).toBe('warning')
    expect(evaluateCostAlert(29.99, T).level).toBe('warning')
  })

  it('恰好等于 exceeded → exceeded', () => {
    const r = evaluateCostAlert(30, T)
    expect(r.level).toBe('exceeded')
    expect(r.cost).toBe(30)
    expect(r.threshold).toBe(30)
  })

  it('高于 exceeded → exceeded', () => {
    expect(evaluateCostAlert(50, T).level).toBe('exceeded')
    expect(evaluateCostAlert(1000, T).level).toBe('exceeded')
  })

  it('negative cost → ok (兜底)', () => {
    expect(evaluateCostAlert(-5, T).level).toBe('ok')
  })

  it('warning < 0 (非法阈值) → ok (兜底)', () => {
    const r = evaluateCostAlert(50, { warning: -1, exceeded: 100 })
    expect(r.level).toBe('ok')
  })

  it('warning >= exceeded (非法阈值) → ok (兜底)', () => {
    // warning 必须 < exceeded，否则 warning 永远不触发
    const r = evaluateCostAlert(50, { warning: 100, exceeded: 50 })
    expect(r.level).toBe('ok')
  })

  it('warning = exceeded (相等非法) → ok (兜底)', () => {
    const r = evaluateCostAlert(50, { warning: 30, exceeded: 30 })
    expect(r.level).toBe('ok')
  })

  it('不同阈值：warning=2, exceeded=5 → 小金额触发', () => {
    const T2 = { warning: 2, exceeded: 5 }
    expect(evaluateCostAlert(0, T2).level).toBe('ok')
    expect(evaluateCostAlert(1.99, T2).level).toBe('ok')
    expect(evaluateCostAlert(2, T2).level).toBe('warning')
    expect(evaluateCostAlert(4, T2).level).toBe('warning')
    expect(evaluateCostAlert(5, T2).level).toBe('exceeded')
    expect(evaluateCostAlert(10, T2).level).toBe('exceeded')
  })

  it('大阈值：warning=100, exceeded=1000 → 中等费用不触发', () => {
    const T3 = { warning: 100, exceeded: 1000 }
    expect(evaluateCostAlert(50, T3).level).toBe('ok')
    expect(evaluateCostAlert(100, T3).level).toBe('warning')
    expect(evaluateCostAlert(500, T3).level).toBe('warning')
    expect(evaluateCostAlert(1000, T3).level).toBe('exceeded')
  })

  it('DEFAULT_COST_THRESHOLDS (10/30) 边界精确', () => {
    expect(evaluateCostAlert(0, DEFAULT_COST_THRESHOLDS).level).toBe('ok')
    expect(evaluateCostAlert(9.99, DEFAULT_COST_THRESHOLDS).level).toBe('ok')
    expect(evaluateCostAlert(10, DEFAULT_COST_THRESHOLDS).level).toBe('warning')
    expect(evaluateCostAlert(29.99, DEFAULT_COST_THRESHOLDS).level).toBe('warning')
    expect(evaluateCostAlert(30, DEFAULT_COST_THRESHOLDS).level).toBe('exceeded')
  })

  it('P12-C 集成: 用户场景 (默认阈值 10/30)', () => {
    // 场景：用户一天用 5 元 → ok，不打扰
    expect(evaluateCostAlert(5, DEFAULT_COST_THRESHOLDS).level).toBe('ok')
    // 场景：累计 12 元 → warning，提醒"接近预警线 10 元"
    expect(evaluateCostAlert(12, DEFAULT_COST_THRESHOLDS).level).toBe('warning')
    // 场景：累计 35 元 → exceeded，强烈警告
    expect(evaluateCostAlert(35, DEFAULT_COST_THRESHOLDS).level).toBe('exceeded')
  })
})

describe('shouldBlockAiGenerate (P14-C 硬上限拦截)', () => {
  const BASE = { enabled: true, blockOnExceeded: true, warning: 10, exceeded: 30 }

  it('cost < warning → 不拦截', () => {
    expect(shouldBlockAiGenerate(5, BASE)).toBe(false)
  })

  it('warning <= cost < exceeded → 不拦截（仅 warning，不弹确认）', () => {
    expect(shouldBlockAiGenerate(10, BASE)).toBe(false)
    expect(shouldBlockAiGenerate(20, BASE)).toBe(false)
    expect(shouldBlockAiGenerate(29.99, BASE)).toBe(false)
  })

  it('cost >= exceeded → 拦截（弹 confirm）', () => {
    expect(shouldBlockAiGenerate(30, BASE)).toBe(true)
    expect(shouldBlockAiGenerate(50, BASE)).toBe(true)
    expect(shouldBlockAiGenerate(1000, BASE)).toBe(true)
  })

  it('disabled: true → 不拦截（用户关掉预警）', () => {
    expect(shouldBlockAiGenerate(1000, { ...BASE, enabled: false })).toBe(false)
  })

  it('blockOnExceeded: false → 不拦截（用户不要确认）', () => {
    expect(shouldBlockAiGenerate(1000, { ...BASE, blockOnExceeded: false })).toBe(false)
  })

  it('negative cost → 不拦截（兜底）', () => {
    expect(shouldBlockAiGenerate(-5, BASE)).toBe(false)
  })

  it('非法阈值（warning < 0）→ 不拦截（兜底）', () => {
    expect(
      shouldBlockAiGenerate(1000, { ...BASE, warning: -1 })
    ).toBe(false)
  })

  it('非法阈值（warning >= exceeded）→ 不拦截（兜底）', () => {
    expect(
      shouldBlockAiGenerate(1000, { ...BASE, warning: 50, exceeded: 30 })
    ).toBe(false)
  })

  it('P14-C 集成: 用户场景', () => {
    // 用户开了 enabled + blockOnExceeded，本月用 35 元
    expect(shouldBlockAiGenerate(35, BASE)).toBe(true)
    // 用户关掉 blockOnExceeded，即使超阈值也不弹
    expect(shouldBlockAiGenerate(35, { ...BASE, blockOnExceeded: false })).toBe(false)
    // 用户关掉 enabled 整个预警
    expect(shouldBlockAiGenerate(1000, { ...BASE, enabled: false })).toBe(false)
    // 默认配置（blockOnExceeded: false）→ 不弹
    const DEFAULT_CFG = { enabled: true, blockOnExceeded: false, warning: 10, exceeded: 30 }
    expect(shouldBlockAiGenerate(1000, DEFAULT_CFG)).toBe(false)
  })
})

describe('aggregateByDay (P15-A 每日用量聚合)', () => {
  const PRICING = { inputRate: 1, outputRate: 3 }

  it('无 records：返回 7 个空日（按日期升序）', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const days = aggregateByDay([], now, 7)
    expect(days).toHaveLength(7)
    expect(days.every((d) => d.total === 0 && d.cost === 0 && d.calls === 0)).toBe(true)
    // 升序：第一天 = 6 天前，最后一天 = 今天
    expect(days[0].date).toBe('2026-06-16')
    expect(days[6].date).toBe('2026-06-22')
  })

  it('默认 days = 7', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    expect(aggregateByDay([], now)).toHaveLength(7)
  })

  it('days = 3 返回 3 天', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const days = aggregateByDay([], now, 3)
    expect(days).toHaveLength(3)
    expect(days[0].date).toBe('2026-06-20')
    expect(days[2].date).toBe('2026-06-22')
  })

  it('窗口外的 records 被忽略', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      // 30 天前 → 窗口外
      { at: '2026-05-22T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }
    ]
    const days = aggregateByDay(records, now, 7)
    expect(days.every((d) => d.total === 0)).toBe(true)
  })

  it('窗口内的 records 累加到对应日期', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      // 今天 2 次
      { at: '2026-06-22T01:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      { at: '2026-06-22T05:00:00Z', feature: 'review', model: 'test-model', inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 },
      // 昨天 1 次
      { at: '2026-06-21T15:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000 }
    ]
    const days = aggregateByDay(records, now, 7)
    // 最后一天 = 今天
    const today = days[6]
    expect(today.date).toBe('2026-06-22')
    expect(today.total).toBe(2_500_000)
    expect(today.calls).toBe(2)
    // 倒数第二天 = 昨天
    const yesterday = days[5]
    expect(yesterday.date).toBe('2026-06-21')
    expect(yesterday.total).toBe(200_000)
    expect(yesterday.calls).toBe(1)
    // 其他天 = 0
    expect(days.slice(0, 5).every((d) => d.total === 0 && d.calls === 0)).toBe(true)
  })

  it('aggregateByDayWithCost 正确计算 cost（每行用 computeCost）', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }
    ]
    const days = aggregateByDayWithCost(records, PRICING, now, 7)
    // 1M input + 1M output = 1 + 3 = 4 元
    expect(days[6].cost).toBeCloseTo(4, 6)
  })

  it('aggregateByDayWithCost 累加多行 cost', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      // 今天 3 次续写
      { at: '2026-06-22T01:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      { at: '2026-06-22T02:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 },
      { at: '2026-06-22T03:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000 }
    ]
    const days = aggregateByDayWithCost(records, PRICING, now, 7)
    // 1 + 3 + (0.5*1 + 0.5*3) = 1 + 3 + 2 = 6 元
    expect(days[6].cost).toBeCloseTo(6, 6)
    expect(days[6].calls).toBe(3)
    expect(days[6].total).toBe(3_000_000)
  })

  it('跨月边界：now 在月末，往前 7 天含上月', () => {
    const now = new Date('2026-07-03T10:00:00Z') // 7 月 3 日
    const records: UsageRecord[] = [
      // 6 月 30 日（窗口内）
      { at: '2026-06-30T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      // 6 月 27 日（窗口内）
      { at: '2026-06-27T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 2_000_000, outputTokens: 0, totalTokens: 2_000_000 }
    ]
    const days = aggregateByDay(records, now, 7)
    expect(days[0].date).toBe('2026-06-27')
    expect(days[6].date).toBe('2026-07-03')
    // 找到 6 月 30 日的 entry
    const jun30 = days.find((d) => d.date === '2026-06-30')!
    expect(jun30.total).toBe(1_000_000)
    const jun27 = days.find((d) => d.date === '2026-06-27')!
    expect(jun27.total).toBe(2_000_000)
  })

  it('输出按日期升序（不是降序）', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const days = aggregateByDay([], now, 7)
    for (let i = 1; i < days.length; i++) {
      expect(days[i].date > days[i - 1].date).toBe(true)
    }
  })

  it('does not mutate input records (immutability)', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'test-model', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }
    ]
    const snapshot = JSON.stringify(records)
    aggregateByDay(records, now, 7)
    expect(JSON.stringify(records)).toBe(snapshot)
  })
})

describe('filterByDate (P16-C 单日详情)', () => {
  const records: UsageRecord[] = [
    { at: '2026-06-20T09:00:00Z', feature: 'chapter', model: 'gpt-4', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    { at: '2026-06-20T15:30:00Z', feature: 'review', model: 'gpt-4', inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 },
    { at: '2026-06-21T10:00:00Z', feature: 'humanize', model: 'gpt-4', inputTokens: 200, outputTokens: 200, totalTokens: 400 },
    { at: '2026-06-22T08:00:00Z', feature: 'chapter', model: 'gpt-4', inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 }
  ]

  it('returns records for the matching date only', () => {
    const r = filterByDate(records, '2026-06-20')
    expect(r).toHaveLength(2)
    expect(r.every((x) => x.at.startsWith('2026-06-20'))).toBe(true)
  })

  it('preserves order of records within a day', () => {
    const r = filterByDate(records, '2026-06-20')
    expect(r[0].at).toBe('2026-06-20T09:00:00Z')
    expect(r[1].at).toBe('2026-06-20T15:30:00Z')
  })

  it('returns empty array for date with no records', () => {
    const r = filterByDate(records, '2026-06-15')
    expect(r).toEqual([])
  })

  it('returns empty array for invalid date format', () => {
    expect(filterByDate(records, '2026/06/20')).toEqual([])
    expect(filterByDate(records, '06-20')).toEqual([])
    expect(filterByDate(records, '')).toEqual([])
    expect(filterByDate(records, 'not a date')).toEqual([])
  })

  it('handles records with different time zones correctly', () => {
    const r = filterByDate(records, '2026-06-22')
    expect(r).toHaveLength(1)
    expect(r[0].feature).toBe('chapter')
  })

  it('handles empty records array', () => {
    expect(filterByDate([], '2026-06-20')).toEqual([])
  })

  it('handles same-day records with sub-second precision', () => {
    const sameDay: UsageRecord[] = [
      { at: '2026-06-22T08:00:00.000Z', feature: 'a', model: 'm', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { at: '2026-06-22T08:00:00.500Z', feature: 'b', model: 'm', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { at: '2026-06-22T08:00:00.999Z', feature: 'c', model: 'm', inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    ]
    const r = filterByDate(sameDay, '2026-06-22')
    expect(r).toHaveLength(3)
  })

  it('does not match dates outside the YYYY-MM-DD prefix', () => {
    // 边界：date "2026-06-2" 应该是 invalid（前导零缺失）→ 兜底返回空
    expect(filterByDate(records, '2026-06-2')).toEqual([])
    expect(filterByDate(records, '2026-6-20')).toEqual([])
  })

  it('P16-C 集成: 7 日窗口内某天 filterByDate 提取', () => {
    const now = new Date('2026-06-22T10:00:00Z')
    const days = aggregateByDay(records, now, 7)
    // 找到 2026-06-20 这一天
    const day = days.find((d) => d.date === '2026-06-20')!
    expect(day.calls).toBe(2) // 2 次调用
    // filterByDate 应返回这 2 次调用的完整记录
    const detail = filterByDate(records, day.date)
    expect(detail).toHaveLength(day.calls)
  })
})

describe('aggregateByProject (P17-A 按项目)', () => {
  const PRICING = { inputRate: 1, outputRate: 3 }

  it('空 records → 返回空数组', () => {
    expect(aggregateByProject([], PRICING)).toEqual([])
  })

  it('单项目多条记录 → 累加', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      { at: '2026-06-22T11:00:00Z', feature: 'review', model: 'm', projectId: 'P1', inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 }
    ]
    const result = aggregateByProject(records, PRICING)
    expect(result).toHaveLength(1)
    expect(result[0].projectId).toBe('P1')
    expect(result[0].total).toBe(2_000_000)
    expect(result[0].calls).toBe(2)
    expect(result[0].cost).toBe(4) // 1 + 3
  })

  it('多项目 → 按 cost 降序排序', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'A', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'B', inputTokens: 0, outputTokens: 5_000_000, totalTokens: 5_000_000 },
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'C', inputTokens: 2_000_000, outputTokens: 0, totalTokens: 2_000_000 }
    ]
    const result = aggregateByProject(records, PRICING)
    // B = 5M*3 = 15 元（最大）
    // C = 2M*1 = 2 元
    // A = 1M*1 = 1 元
    expect(result.map((r) => r.projectId)).toEqual(['B', 'C', 'A'])
  })

  it('无 projectId 的记录归入 "unknown" 分组', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
      { at: '2026-06-22T11:00:00Z', feature: 'review', model: 'm', projectId: 'P1', inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 }
    ]
    const result = aggregateByProject(records, PRICING)
    expect(result).toHaveLength(2)
    const unknown = result.find((r) => r.projectId === 'unknown')
    expect(unknown?.calls).toBe(1)
  })
})

describe('aggregateByChapter (P17-A 按章节)', () => {
  const PRICING = { inputRate: 1, outputRate: 3 }

  it('空 records → 返回空数组', () => {
    expect(aggregateByChapter([], PRICING)).toEqual([])
  })

  it('同项目多章节 → 分别累加', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 1, inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      { at: '2026-06-22T11:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 2, inputTokens: 500_000, outputTokens: 500_000, totalTokens: 1_000_000 }
    ]
    const result = aggregateByChapter(records, PRICING)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ projectId: 'P1', chapterNumber: 1, total: 2_000_000, calls: 1 })
    expect(result[1]).toMatchObject({ projectId: 'P1', chapterNumber: 2, total: 1_000_000, calls: 1 })
  })

  it('多项目多章节 → 按 (projectId, chapterNumber) 升序', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'B', chapterNumber: 1, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
      { at: '2026-06-22T11:00:00Z', feature: 'chapter', model: 'm', projectId: 'A', chapterNumber: 2, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
      { at: '2026-06-22T12:00:00Z', feature: 'chapter', model: 'm', projectId: 'A', chapterNumber: 1, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }
    ]
    const result = aggregateByChapter(records, PRICING)
    expect(result.map((r) => `${r.projectId}:${r.chapterNumber}`)).toEqual([
      'A:1', 'A:2', 'B:1'
    ])
  })

  it('跳过没有 projectId 或 chapterNumber 的记录', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }, // 无 projectId
      { at: '2026-06-22T11:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }, // 无 chapterNumber
      { at: '2026-06-22T12:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 1, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }
    ]
    const result = aggregateByChapter(records, PRICING)
    expect(result).toHaveLength(1)
    expect(result[0].chapterNumber).toBe(1)
  })

  it('does not mutate input records (immutability)', () => {
    const records: UsageRecord[] = [
      { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 1, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }
    ]
    const snapshot = JSON.stringify(records)
    aggregateByChapter(records, PRICING)
    expect(JSON.stringify(records)).toBe(snapshot)
  })
})

describe('filterByChapter (P17-A 单章详情)', () => {
  const records: UsageRecord[] = [
    { at: '2026-06-22T10:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 1, inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
    { at: '2026-06-22T11:00:00Z', feature: 'review', model: 'm', projectId: 'P1', chapterNumber: 1, inputTokens: 500, outputTokens: 0, totalTokens: 500 },
    { at: '2026-06-22T12:00:00Z', feature: 'chapter', model: 'm', projectId: 'P1', chapterNumber: 2, inputTokens: 2000, outputTokens: 0, totalTokens: 2000 },
    { at: '2026-06-22T13:00:00Z', feature: 'chapter', model: 'm', projectId: 'P2', chapterNumber: 1, inputTokens: 3000, outputTokens: 0, totalTokens: 3000 }
  ]

  it('returns records matching both projectId and chapterNumber', () => {
    const r = filterByChapter(records, 'P1', 1)
    expect(r).toHaveLength(2)
    expect(r.every((x) => x.projectId === 'P1' && x.chapterNumber === 1)).toBe(true)
  })

  it('preserves order within the chapter', () => {
    const r = filterByChapter(records, 'P1', 1)
    expect(r[0].at).toBe('2026-06-22T10:00:00Z')
    expect(r[1].at).toBe('2026-06-22T11:00:00Z')
  })

  it('returns empty array for non-existent projectId', () => {
    expect(filterByChapter(records, 'P_UNK', 1)).toEqual([])
  })

  it('returns empty array for non-existent chapterNumber', () => {
    expect(filterByChapter(records, 'P1', 99)).toEqual([])
  })

  it('handles empty records array', () => {
    expect(filterByChapter([], 'P1', 1)).toEqual([])
  })
})
