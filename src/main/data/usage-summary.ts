/**
 * 用量统计的纯函数（与 src/main/ipc/usage.ts 行为一致，但单测友好）。
 *
 * 抽出来是为了让 settings 页面的小徽章 / ChapterEditor 工具栏 / 后续 dashboard
 * 都能用同一份逻辑 + 直接在 vitest 里断言。
 */

import type { UsageSummary, UsageBucket } from '../../shared/types'

export interface PricingConfig {
  /** 元 / 百万 token */
  inputRate: number
  /** 元 / 百万 token */
  outputRate: number
}

export interface UsageRecord {
  at: string // ISO 时间字符串
  feature: string
  projectId?: string
  chapterNumber?: number
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

const FEATURE_LABELS: Record<string, string> = {
  'outline-main': '总纲生成',
  'outline-detailed': '细纲生成',
  chapter: '正文续写',
  review: '改稿建议',
  cast: '登场识别',
  relationship: '关系推断',
  humanize: 'AI 改写',
  other: '其他'
}

function labelOf(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature
}

/**
 * 计算一次 LLM 调用的费用（元）。
 * 与 src/main/ipc/usage.ts:costOf 行为一致。
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  pricing: PricingConfig
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputRate +
    (outputTokens / 1_000_000) * pricing.outputRate
  )
}

/**
 * 把 records 汇总为 today / month / allTime + byFeature。
 * now 用于取"今天"和"本月"分桶的 key（便于测试时固定时间）。
 */
export function summarizeUsage(
  records: readonly UsageRecord[],
  pricing: PricingConfig,
  now: Date
): UsageSummary {
  const acc = (): UsageBucket => ({ input: 0, output: 0, total: 0, cost: 0 })
  const today = acc()
  const month = acc()
  const allTime = acc()
  const byFeatureMap = new Map<string, { total: number; cost: number; calls: number }>()

  const todayKey = now.toISOString().slice(0, 10)
  const monthKey = now.toISOString().slice(0, 7)

  for (const r of records) {
    const cost = computeCost(r.inputTokens, r.outputTokens, pricing)
    allTime.input += r.inputTokens
    allTime.output += r.outputTokens
    allTime.total += r.totalTokens
    allTime.cost += cost
    const dk = r.at.slice(0, 10)
    const mk = r.at.slice(0, 7)
    if (dk === todayKey) {
      today.input += r.inputTokens
      today.output += r.outputTokens
      today.total += r.totalTokens
      today.cost += cost
    }
    if (mk === monthKey) {
      month.input += r.inputTokens
      month.output += r.outputTokens
      month.total += r.totalTokens
      month.cost += cost
    }
    const key = labelOf(r.feature)
    const prev = byFeatureMap.get(key) ?? { total: 0, cost: 0, calls: 0 }
    prev.total += r.totalTokens
    prev.cost += cost
    prev.calls += 1
    byFeatureMap.set(key, prev)
  }

  return {
    today,
    month,
    allTime,
    byFeature: [...byFeatureMap.entries()]
      .map(([feature, v]) => ({ feature, ...v }))
      .sort((a, b) => b.total - a.total),
    byDay: aggregateByDayWithCost(records, pricing, now)
  }
}

/** 把 token 数格式化为人类可读字符串（≥1M 用 M，≥1k 用 k，否则原数） */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

/** 把费用（元）格式化为 ¥X.XX 风格 */
export function formatCost(n: number): string {
  if (n >= 1) return '¥' + n.toFixed(2)
  if (n >= 0.01) return '¥' + n.toFixed(3)
  return '¥' + n.toFixed(4)
}

/**
 * P11-A：把"上次保存"的时间戳格式化为"X 秒前/分钟前/刚刚"。
 * 注入 now 便于测试固定时间。
 *
 * 文案（中文）：
 * - 同一秒内 → "刚刚"
 * - < 60s → "X 秒前"
 * - < 60min → "X 分钟前"
 * - < 24h → "X 小时前"
 * - 更早 → "Y 天前"
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

// ============================================================
// 用量预警（P12-C：避免月度账单爆炸）
// ============================================================

export interface CostThresholds {
  /** 警告阈值：达到此费用时弹 toast 提醒（默认 10 元） */
  warning: number
  /** 硬上限：达到此费用时弹更强的 toast + 阻止继续 LLM 调用（默认 30 元） */
  exceeded: number
}

export const DEFAULT_COST_THRESHOLDS: CostThresholds = {
  warning: 10,
  exceeded: 30
}

export type CostAlertLevel = 'ok' | 'warning' | 'exceeded'

export interface CostAlert {
  level: CostAlertLevel
  /** 触发本等级时的费用（用于 toast 展示"已用 X 元"） */
  cost: number
  /** 触发本等级时的阈值（warning / exceeded 才有） */
  threshold?: number
}

/**
 * P12-C：根据当月累计费用和阈值，返回预警等级。
 *
 * 规则：
 * - cost >= thresholds.exceeded → 'exceeded'（最强警告）
 * - cost >= thresholds.warning  → 'warning'（提醒）
 * - 否则 → 'ok'
 *
 * 注意：warning 必须 < exceeded，否则 warning 永远不会被触发。
 * 如果 thresholds 非法（warning >= exceeded 或 < 0），按'ok'兜底。
 */
export function evaluateCostAlert(
  monthCost: number,
  thresholds: CostThresholds
): CostAlert {
  if (thresholds.warning < 0 || thresholds.exceeded <= thresholds.warning) {
    return { level: 'ok', cost: monthCost }
  }
  if (monthCost >= thresholds.exceeded) {
    return { level: 'exceeded', cost: monthCost, threshold: thresholds.exceeded }
  }
  if (monthCost >= thresholds.warning) {
    return { level: 'warning', cost: monthCost, threshold: thresholds.warning }
  }
  return { level: 'ok', cost: monthCost }
}

// ============================================================
// AI 续写硬上限拦截（P14-C）
// ============================================================

/**
 * P14-C：判断 aiGenerate 是否应弹"继续确认"对话框。
 *
 * 规则（全部满足才拦截）：
 * 1. config.enabled（用户启用预警）
 * 2. config.blockOnExceeded（用户开启"exceeded 时弹确认"）
 * 3. monthCost >= config.exceeded（达到硬上限）
 *
 * 满足则返回 true，UI 应弹 confirm；用户取消则 return；用户确认则继续 aiGenerate。
 *
 * 不满足 → false（不弹任何东西，直接走 aiGenerate）。
 */
export function shouldBlockAiGenerate(
  monthCost: number,
  config: CostThresholds & { enabled: boolean; blockOnExceeded: boolean }
): boolean {
  if (!config.enabled) return false
  if (!config.blockOnExceeded) return false
  // 阈值非法的兜底：与 evaluateCostAlert 一致
  if (config.warning < 0 || config.exceeded <= config.warning) return false
  return monthCost >= config.exceeded
}

// ============================================================
// 每日用量聚合（P15-A：7 日趋势图）
// ============================================================

export interface DailyUsage {
  /** YYYY-MM-DD */
  date: string
  total: number
  cost: number
  calls: number
}

/**
 * P15-A：把 records 按天聚合，返回最近 N 天（含无数据的空天）。
 * now: 用于取基准日期；days: 返回天数（默认 7）。
 *
 * 边界：跨月（如 2026-06-30 往前 7 天会跨入 5 月）也正确——按 ISO date 切分。
 */
export function aggregateByDay(
  records: readonly UsageRecord[],
  now: Date,
  days: number = 7
): DailyUsage[] {
  // 生成 days 天的日期 keys（从 now 往前 days-1 天 → 含今天共 days 天）
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    dates.push(d.toISOString().slice(0, 10))
  }
  // 初始化每个日期为 0
  const map = new Map<string, DailyUsage>()
  for (const d of dates) {
    map.set(d, { date: d, total: 0, cost: 0, calls: 0 })
  }
  // 累加 records
  for (const r of records) {
    const k = r.at.slice(0, 10)
    if (!map.has(k)) continue // 不在窗口内
    const e = map.get(k)!
    e.total += r.totalTokens
    e.calls += 1
    // cost 需 pricing 才能算——但 records 不带 pricing。改为：调用方传入 pricing 用 computeCost
    // 实际：因为 PricingConfig 没在 records 里，需在调用 computeCost
    // 这里先累加 total/calls，cost 在外面再算
  }
  return [...map.values()]
}

/**
 * P15-A：把 records + pricing 按天聚合，返回 cost（每行用 computeCost 算）。
 * 这是 IPC handler 应该调用的版本。
 */
export function aggregateByDayWithCost(
  records: readonly UsageRecord[],
  pricing: PricingConfig,
  now: Date,
  days: number = 7
): DailyUsage[] {
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    dates.push(d.toISOString().slice(0, 10))
  }
  const map = new Map<string, DailyUsage>()
  for (const d of dates) {
    map.set(d, { date: d, total: 0, cost: 0, calls: 0 })
  }
  for (const r of records) {
    const k = r.at.slice(0, 10)
    if (!map.has(k)) continue
    const e = map.get(k)!
    e.total += r.totalTokens
    e.cost += computeCost(r.inputTokens, r.outputTokens, pricing)
    e.calls += 1
  }
  return [...map.values()]
}

// ============================================================
// 单日详情（P16-C：趋势图下钻）
// ============================================================

/**
 * P16-C：把 records 按指定日期（YYYY-MM-DD）过滤出来。
 * 用于"点击趋势图某一天柱状图 → 弹出当天所有 LLM 调用列表"。
 * 边界：date 格式不对（不是 YYYY-MM-DD）→ 返回空数组。
 */
export function filterByDate(
  records: readonly UsageRecord[],
  date: string
): UsageRecord[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  return records.filter((r) => r.at.slice(0, 10) === date)
}

// ============================================================
// 按项目 / 按章节聚合（P17-A：单章用量统计）
// ============================================================

export interface ProjectUsage {
  projectId: string
  total: number
  cost: number
  calls: number
}

export interface ChapterUsage extends ProjectUsage {
  chapterNumber: number
}

/**
 * P17-A：按 projectId 聚合。没有 projectId 的记录归入 'unknown' 分组。
 * 输出按 cost 降序排序（贵的项目在前）。
 */
export function aggregateByProject(
  records: readonly UsageRecord[],
  pricing: PricingConfig
): ProjectUsage[] {
  const map = new Map<string, ProjectUsage>()
  for (const r of records) {
    const key = r.projectId ?? 'unknown'
    const cost = computeCost(r.inputTokens, r.outputTokens, pricing)
    const e = map.get(key) ?? { projectId: key, total: 0, cost: 0, calls: 0 }
    e.total += r.totalTokens
    e.cost += cost
    e.calls += 1
    map.set(key, e)
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost)
}

/**
 * P17-A：按 projectId + chapterNumber 聚合。
 * 只统计同时有 projectId 和 chapterNumber 的记录（其他跳过）。
 * 输出按 (projectId, chapterNumber) 升序。
 */
export function aggregateByChapter(
  records: readonly UsageRecord[],
  pricing: PricingConfig
): ChapterUsage[] {
  const map = new Map<string, ChapterUsage>()
  for (const r of records) {
    if (r.projectId === undefined || r.chapterNumber === undefined) continue
    const key = `${r.projectId}:${r.chapterNumber}`
    const cost = computeCost(r.inputTokens, r.outputTokens, pricing)
    const e = map.get(key) ?? {
      projectId: r.projectId,
      chapterNumber: r.chapterNumber,
      total: 0,
      cost: 0,
      calls: 0
    }
    e.total += r.totalTokens
    e.cost += cost
    e.calls += 1
    map.set(key, e)
  }
  return [...map.values()].sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId)
    return a.chapterNumber - b.chapterNumber
  })
}

/**
 * P17-A：提取指定项目 + 章节的所有 LLM 调用记录（用于详情面板）。
 */
export function filterByChapter(
  records: readonly UsageRecord[],
  projectId: string,
  chapterNumber: number
): UsageRecord[] {
  return records.filter(
    (r) => r.projectId === projectId && r.chapterNumber === chapterNumber
  )
}
