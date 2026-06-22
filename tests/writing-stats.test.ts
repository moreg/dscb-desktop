import { describe, it, expect } from 'vitest'
import {
  loadStats,
  saveStats,
  accumulateDelta,
  lastNDays,
  summarizeWeekly,
  heatLevel,
  today,
  type DailyStats
} from '../src/renderer/src/writing-stats'

function makeStorage(): { getItem: any; setItem: any; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v)
  }
}

describe('today', () => {
  it('returns YYYY-MM-DD format', () => {
    const now = new Date('2026-06-22T15:30:45Z')
    expect(today(now)).toBe('2026-06-22')
  })
})

describe('loadStats / saveStats', () => {
  it('saveStats writes JSON to storage', () => {
    const s = makeStorage()
    const stats: DailyStats[] = [{ date: '2026-06-22', words: 1500 }]
    saveStats('proj1', stats, s)
    expect(s.data.get('ai-writer:writing-stats:proj1')).toBeDefined()
  })

  it('loadStats parses saved JSON', () => {
    const s = makeStorage()
    const stats: DailyStats[] = [
      { date: '2026-06-20', words: 500 },
      { date: '2026-06-22', words: 1500 }
    ]
    saveStats('proj1', stats, s)
    expect(loadStats('proj1', s)).toEqual(stats)
  })

  it('loadStats returns [] for missing key', () => {
    const s = makeStorage()
    expect(loadStats('proj1', s)).toEqual([])
  })

  it('loadStats returns [] for corrupted JSON', () => {
    const s = makeStorage()
    s.data.set('ai-writer:writing-stats:proj1', 'not json {')
    expect(loadStats('proj1', s)).toEqual([])
  })

  it('loadStats filters out malformed entries', () => {
    const s = makeStorage()
    s.data.set(
      'ai-writer:writing-stats:proj1',
      JSON.stringify([
        { date: '2026-06-22', words: 1500 },
        { date: '2026-06-23' },
        { words: 500 }
      ])
    )
    const result = loadStats('proj1', s)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ date: '2026-06-22', words: 1500 })
  })

  it('isolated per project (key includes projectId)', () => {
    const s = makeStorage()
    saveStats('projA', [{ date: '2026-06-22', words: 100 }], s)
    saveStats('projB', [{ date: '2026-06-22', words: 200 }], s)
    expect(loadStats('projA', s)).toEqual([{ date: '2026-06-22', words: 100 }])
    expect(loadStats('projB', s)).toEqual([{ date: '2026-06-22', words: 200 }])
  })

  it('loadStats with null storage → []', () => {
    expect(loadStats('p', null)).toEqual([])
  })

  it('saveStats with null storage → 静默', () => {
    // 不应抛错
    saveStats('p', [{ date: '2026-06-22', words: 100 }], null)
  })
})

describe('accumulateDelta', () => {
  const now = new Date('2026-06-22T15:00:00Z')

  it('delta <= 0 → 返回新数组（内容相同）', () => {
    const stats: DailyStats[] = [{ date: '2026-06-22', words: 100 }]
    expect(accumulateDelta(stats, 0, now)).toEqual(stats)
    expect(accumulateDelta(stats, -50, now)).toEqual(stats)
    // 验证：返回的是新数组（不修改原）
    expect(accumulateDelta(stats, 0, now)).not.toBe(stats)
  })

  it('已有今日条目 → 累加', () => {
    const stats: DailyStats[] = [{ date: '2026-06-22', words: 100 }]
    const next = accumulateDelta(stats, 50, now)
    expect(next).toEqual([{ date: '2026-06-22', words: 150 }])
  })

  it('无今日条目 → 新增', () => {
    const stats: DailyStats[] = [{ date: '2026-06-21', words: 100 }]
    const next = accumulateDelta(stats, 200, now)
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ date: '2026-06-22', words: 200 })
  })

  it('空 stats → 新增唯一条目', () => {
    const next = accumulateDelta([], 100, now)
    expect(next).toEqual([{ date: '2026-06-22', words: 100 }])
  })

  it('does not mutate input (immutability)', () => {
    const stats: DailyStats[] = [{ date: '2026-06-22', words: 100 }]
    const snapshot = JSON.stringify(stats)
    accumulateDelta(stats, 50, now)
    expect(JSON.stringify(stats)).toBe(snapshot)
  })
})

describe('lastNDays', () => {
  const now = new Date('2026-06-22T15:00:00Z')

  it('空 stats → 返回 N 个 0 字天（按日期升序）', () => {
    const days = lastNDays([], 7, now)
    expect(days).toHaveLength(7)
    expect(days.every((d) => d.words === 0)).toBe(true)
    expect(days[0].date).toBe('2026-06-16')
    expect(days[6].date).toBe('2026-06-22')
  })

  it('填入数据 → 正确映射', () => {
    const stats: DailyStats[] = [
      { date: '2026-06-20', words: 500 },
      { date: '2026-06-22', words: 1500 }
    ]
    const days = lastNDays(stats, 7, now)
    expect(days.find((d) => d.date === '2026-06-20')?.words).toBe(500)
    expect(days.find((d) => d.date === '2026-06-22')?.words).toBe(1500)
    expect(days.find((d) => d.date === '2026-06-21')?.words).toBe(0)
  })

  it('N=1 → 仅今天', () => {
    const days = lastNDays([], 1, now)
    expect(days).toHaveLength(1)
    expect(days[0].date).toBe('2026-06-22')
  })
})

describe('summarizeWeekly', () => {
  const now = new Date('2026-06-22T15:00:00Z')

  it('累加 7 天总字数', () => {
    const stats: DailyStats[] = [
      { date: '2026-06-20', words: 1000 },
      { date: '2026-06-21', words: 2000 },
      { date: '2026-06-22', words: 500 }
    ]
    const w = summarizeWeekly(stats, 1000, now)
    expect(w.totalWords).toBe(3500)
    expect(w.totalTarget).toBe(7000)
    expect(w.days).toHaveLength(7)
  })

  it('空 stats → totalWords=0', () => {
    const w = summarizeWeekly([], 1000, now)
    expect(w.totalWords).toBe(0)
    expect(w.totalTarget).toBe(7000)
  })
})

describe('heatLevel', () => {
  it('words=0 → 0', () => {
    expect(heatLevel(0, 1000)).toBe(0)
  })

  it('1-49% of target → 1', () => {
    expect(heatLevel(100, 1000)).toBe(1)
    expect(heatLevel(499, 1000)).toBe(1)
  })

  it('50-99% of target → 2', () => {
    expect(heatLevel(500, 1000)).toBe(2)
    expect(heatLevel(999, 1000)).toBe(2)
  })

  it('100-149% of target → 3', () => {
    expect(heatLevel(1000, 1000)).toBe(3)
    expect(heatLevel(1499, 1000)).toBe(3)
  })

  it('150%+ of target → 4', () => {
    expect(heatLevel(1500, 1000)).toBe(4)
    expect(heatLevel(5000, 1000)).toBe(4)
  })

  it('dailyTarget=0 → 视为无目标（按 1 处理避免除零）', () => {
    // ratio = words / 1, words=0 → 0
    expect(heatLevel(0, 0)).toBe(0)
    // words>0 但 target=0 → ratio 任意正数 → 至少 1
    expect(heatLevel(100, 0)).toBeGreaterThanOrEqual(1)
  })
})

describe('P19-B 集成: 完整流程', () => {
  it('用户场景：跨章节累计 + 7 天热力图', () => {
    // 模拟：第 1 天用户写 1500 字（达标），第 2 天 800 字（未达标），第 3 天 0（休息）
    const s = makeStorage()
    let stats = loadStats('proj1', s)
    const day1 = new Date('2026-06-20T10:00:00Z')
    const day2 = new Date('2026-06-21T10:00:00Z')
    const day3 = new Date('2026-06-22T10:00:00Z')

    stats = accumulateDelta(stats, 1500, day1) // day1 写 1500
    stats = accumulateDelta(stats, 500, day1) // day1 再写 500 → 2000（超额）
    stats = accumulateDelta(stats, 800, day2) // day2 写 800
    stats = accumulateDelta(stats, 0, day3) // day3 不写

    saveStats('proj1', stats, s)

    // 验证：day1=2000, day2=800, day3=0
    const today = day3
    const weekly = summarizeWeekly(stats, 1000, today)
    expect(weekly.days.find((d) => d.date === '2026-06-20')?.words).toBe(2000)
    expect(weekly.days.find((d) => d.date === '2026-06-21')?.words).toBe(800)
    expect(weekly.days.find((d) => d.date === '2026-06-22')?.words).toBe(0)
    // 7 天总字数 = 2000 + 800 = 2800
    expect(weekly.totalWords).toBe(2800)
    // 热力图：day1=2000 → heat-4, day2=800 → heat-2, day3=0 → heat-0
    expect(heatLevel(2000, 1000)).toBe(4)
    expect(heatLevel(800, 1000)).toBe(2)
    expect(heatLevel(0, 1000)).toBe(0)
  })
})
