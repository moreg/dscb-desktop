/**
 * 写作字数统计（P19-B）。
 *
 * 策略：纯函数 + localStorage 持久化（不引入 IPC，简单可靠）。
 * 每日条目：{ date: 'YYYY-MM-DD', words: number }。
 * 跨章节累加：用户编辑任何章节都贡献到今天的字数。
 *
 * "今日字数"定义：当天最后一次保存时的 wordCount 减去当天首次打开时的 wordCount。
 * 简化版：每次保存累加 delta（避免复杂的"打开时基线"逻辑）。
 */

export interface DailyStats {
  date: string // YYYY-MM-DD
  words: number
}

export interface WeeklyStats {
  days: DailyStats[] // 最多 7 天，按日期升序
  totalWords: number
  totalTarget: number // 7 天总目标（dailyWordGoal * 7）
}

const STORAGE_KEY_PREFIX = 'ai-writer:writing-stats:'

/** 跨章节写作字数记录（key = `${projectId}`，所有章节共享） */
function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`
}

/** 从 localStorage 读取所有 daily 记录 */
export function loadStats(projectId: string, storage: StorageLike | null): DailyStats[] {
  if (!storage) return []
  const raw = storage.getItem(storageKey(projectId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d) => d && typeof d.date === 'string' && typeof d.words === 'number')
  } catch {
    return []
  }
}

/** 把 stats 列表写回 localStorage */
export function saveStats(
  projectId: string,
  stats: readonly DailyStats[],
  storage: StorageLike | null
): void {
  if (!storage) return
  try {
    storage.setItem(storageKey(projectId), JSON.stringify(stats))
  } catch {
    // 容量满 / 隐私模式 → 静默降级
  }
}

/** 今天的日期（YYYY-MM-DD），now 注入便于测试 */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** 累加 delta 字数到今天的条目，返回新 stats */
export function accumulateDelta(
  stats: readonly DailyStats[],
  delta: number,
  now: Date = new Date()
): DailyStats[] {
  if (delta <= 0) return [...stats]
  const d = today(now)
  const idx = stats.findIndex((s) => s.date === d)
  if (idx >= 0) {
    const cur = stats[idx]
    return [
      ...stats.slice(0, idx),
      { date: cur.date, words: cur.words + delta },
      ...stats.slice(idx + 1)
    ]
  }
  return [...stats, { date: d, words: delta }]
}

/**
 * 取最近 N 天的 stats（含无数据的空日），按日期升序。
 * 简化：用于 7-日热力图。
 */
export function lastNDays(
  stats: readonly DailyStats[],
  n: number,
  now: Date = new Date()
): DailyStats[] {
  const map = new Map<string, number>()
  for (const s of stats) map.set(s.date, s.words)
  const out: DailyStats[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const k = d.toISOString().slice(0, 10)
    out.push({ date: k, words: map.get(k) ?? 0 })
  }
  return out
}

/** 计算 weekly summary（7 天） */
export function summarizeWeekly(
  stats: readonly DailyStats[],
  dailyTarget: number,
  now: Date = new Date()
): WeeklyStats {
  const days = lastNDays(stats, 7, now)
  const totalWords = days.reduce((acc, d) => acc + d.words, 0)
  return { days, totalWords, totalTarget: dailyTarget * 7 }
}

/** 热力图颜色等级（基于 dailyTarget 比例） */
export type HeatLevel = 0 | 1 | 2 | 3 | 4 // 0 = 无，1 = 浅，4 = 深

export function heatLevel(words: number, dailyTarget: number): HeatLevel {
  if (words === 0) return 0
  const ratio = words / Math.max(dailyTarget, 1)
  if (ratio >= 1.5) return 4 // 超额 150%+
  if (ratio >= 1.0) return 3 // 达标
  if (ratio >= 0.5) return 2 // 半成
  if (ratio > 0) return 1 // 有动笔
  return 0
}

/** Storage 抽象（便于测试 + 兼容隐私模式） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function getLocalStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const probeKey = '__ai-writer-probe__'
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
    return window.localStorage
  } catch {
    return null
  }
}
