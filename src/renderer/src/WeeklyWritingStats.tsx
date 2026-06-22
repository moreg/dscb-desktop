import { useEffect, useState } from 'react'
import {
  loadStats,
  saveStats,
  accumulateDelta,
  lastNDays,
  summarizeWeekly,
  heatLevel,
  getLocalStorage,
  type DailyStats
} from './writing-stats'

interface Props {
  projectId: string
  dailyTarget: number
}

/**
 * P19-B：7 日热力图 + 跨章节今日字数。
 * 每次保存时把"今天字数"累加到今日条目（基于 saved wordCount 减去 data.content 字数）。
 *
 * 显示：
 * - 今日字数 / 目标
 * - 7 日小方块（颜色深浅表示完成度）
 * - 7 日累计 / 7 日目标
 */
export default function WeeklyWritingStats({ projectId, dailyTarget }: Props) {
  const [stats, setStats] = useState<DailyStats[]>([])

  // mount + projectId 变化时加载
  useEffect(() => {
    setStats(loadStats(projectId, getLocalStorage()))
  }, [projectId])

  // 自动保存 stats 变化到 localStorage（debounce 200ms）
  useEffect(() => {
    const t = setTimeout(() => saveStats(projectId, stats, getLocalStorage()), 200)
    return () => clearTimeout(t)
  }, [projectId, stats])

  // 暴露累加接口给父组件（保存时调）
  useEffect(() => {
    const onSave = (e: Event) => {
      const detail = (e as CustomEvent<{ delta: number }>).detail
      if (detail && detail.delta > 0) {
        setStats((s) => accumulateDelta(s, detail.delta))
      }
    }
    window.addEventListener('writing-stats:save', onSave as EventListener)
    return () => window.removeEventListener('writing-stats:save', onSave as EventListener)
  }, [])

  const weekly = summarizeWeekly(stats, dailyTarget)
  const today = weekly.days[weekly.days.length - 1] // 最后一天 = 今天
  const todayPct = Math.min(100, (today.words / Math.max(1, dailyTarget)) * 100)

  return (
    <div className="weekly-stats" style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span className="muted">今日</span>
        <span className="num" style={{ fontWeight: 600 }}>{today.words.toLocaleString()}</span>
        <span className="muted">/ {dailyTarget.toLocaleString()} 字</span>
        <span style={{ marginLeft: 8 }} className="muted">7日</span>
        <span className="num" style={{ fontWeight: 600 }}>{weekly.totalWords.toLocaleString()}</span>
        <span className="muted">/ {weekly.totalTarget.toLocaleString()}</span>
      </div>
      <div className="weekly-heatmap" title="最近 7 天每日字数（深色 = 达标）">
        {weekly.days.map((d) => {
          const lvl = heatLevel(d.words, dailyTarget)
          const isToday = d.date === today.date
          return (
            <div
              key={d.date}
              className={`heatmap-cell heat-${lvl}${isToday ? ' today' : ''}`}
              title={`${d.date}: ${d.words} 字`}
            >
              <span className="heatmap-day-label">{d.date.slice(5)}</span>
            </div>
          )
        })}
      </div>
      <div
        className="goal-bar"
        style={{ marginTop: 4 }}
      >
        <div
          className={`fill ${todayPct >= 100 ? 'done' : ''}`}
          style={{ width: `${todayPct}%` }}
        />
      </div>
    </div>
  )
}

/**
 * 派发"writing-stats:save"事件给 WeeklyWritingStats 组件。
 * 在 ChapterEditor 的 save() 里调：const delta = data.content.length - draft.length; ...
 */
export function reportSaveDelta(delta: number): void {
  if (delta <= 0) return
  window.dispatchEvent(new CustomEvent('writing-stats:save', { detail: { delta } }))
}
