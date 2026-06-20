import { useEffect, useMemo, useState } from 'react'
import RhythmChart from './RhythmChart'
import type { RhythmEntry, Volume } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
}

const CLIMAX_LABELS = ['无爽点', '小打脸', '中打脸', '大高潮', '卷中决战', '卷终决战']

function climaxIdx(c: number): number {
  if (c >= 4) return 5
  if (c >= 3.25) return 4
  if (c >= 3) return 3
  if (c >= 2) return 2
  if (c >= 1) return 1
  return 0
}

export default function RhythmChartPage({ projectId, onBack, onOpenChapter }: Props) {
  const [rhythm, setRhythm] = useState<RhythmEntry[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void Promise.all([
      window.api.getRhythm(projectId),
      window.api.getVolumes(projectId)
    ]).then(([r, v]) => {
      setRhythm(r)
      setVolumes(v)
      setLoading(false)
    })
  }, [projectId])

  const stats = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0]
    let actualized = 0
    let avgEmotion = 0
    for (const e of rhythm) {
      counts[climaxIdx(e.climax)]++
      if (e.actualized) actualized++
      avgEmotion += e.emotion
    }
    return {
      total: rhythm.length,
      actualized,
      forecast: rhythm.length - actualized,
      counts,
      avgEmotion: rhythm.length ? (avgEmotion / rhythm.length).toFixed(1) : '0'
    }
  }, [rhythm])

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              ‹ 返回
            </button>
            <h1 style={{ marginTop: 8 }}>节奏图谱</h1>
            <p className="desc">
              {stats.total} 章 · 平均情绪 {stats.avgEmotion} · 已回填 {stats.actualized} / 预测{' '}
              {stats.forecast}
            </p>
          </div>
        </div>
      </div>

      <div className="rhythm-stats">
        {CLIMAX_LABELS.map((label, i) => (
          <span key={label} className="rhythm-stat-chip">
            {label} · {stats.counts[i]}
          </span>
        ))}
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : (
        <div className="card" style={{ padding: 16 }}>
          <RhythmChart data={rhythm} volumes={volumes} onSelectChapter={onOpenChapter} />
          <p className="meta" style={{ marginTop: 12, textAlign: 'center' }}>
            点击节点跳转到对应章节
          </p>
        </div>
      )}
    </div>
  )
}
