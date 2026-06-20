import { safeHandle } from './safe-handle'
import { UsageRepository } from '../data/usage-repository'
import { SettingsRepository } from '../data/settings-repository'

export interface UsageSummary {
  today: { input: number; output: number; total: number; cost: number }
  month: { input: number; output: number; total: number; cost: number }
  allTime: { input: number; output: number; total: number; cost: number }
  byFeature: { feature: string; total: number; cost: number; calls: number }[]
}

const FEATURE_LABELS: Record<string, string> = {
  'outline-main': '总纲生成',
  'outline-detailed': '细纲生成',
  chapter: '正文续写',
  review: '改稿建议',
  cast: '登场识别',
  relationship: '关系推断',
  other: '其他'
}

function labelOf(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature
}

export function registerUsageIpc(
  usage: UsageRepository,
  settings: SettingsRepository
): void {
  safeHandle('usage:summary', async () => {
    const records = await usage.list()
    const pricing = await settings.getPricing()
    const now = new Date()
    const todayKey = now.toISOString().slice(0, 10)
    const monthKey = now.toISOString().slice(0, 7)

    const acc = () => ({ input: 0, output: 0, total: 0, cost: 0 })
    const today = acc()
    const month = acc()
    const allTime = acc()
    const byFeatureMap = new Map<string, { total: number; cost: number; calls: number }>()

    const costOf = (input: number, output: number) =>
      (input / 1_000_000) * pricing.inputRate + (output / 1_000_000) * pricing.outputRate

    for (const r of records) {
      const cost = costOf(r.inputTokens, r.outputTokens)
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

    const summary: UsageSummary = {
      today,
      month,
      allTime,
      byFeature: [...byFeatureMap.entries()]
        .map(([feature, v]) => ({ feature, ...v }))
        .sort((a, b) => b.total - a.total)
    }
    return summary
  })

  safeHandle('usage:clear', async () => {
    await usage.clear()
    return true
  })
}
