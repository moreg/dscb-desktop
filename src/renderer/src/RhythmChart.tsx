import { useMemo, useState } from 'react'
import type { RhythmEntry, Volume } from '../../shared/types'

interface Props {
  data: RhythmEntry[]
  volumes?: Volume[]
  onSelectChapter?: (n: number) => void
}

const VB_W = 1440
const VB_H = 640
const PAD_L = 64
const PAD_R = 42
const PAD_T = 52
const PAD_B = 76
const PLOT_W = VB_W - PAD_L - PAD_R
const PLOT_H = VB_H - PAD_T - PAD_B

const CLIMAX_COLORS = ['#95a5a6', '#3498db', '#f39c12', '#e74c3c', '#8e44ad', '#c0392b']
const CLIMAX_LABELS = ['无爽点', '小打脸', '中打脸', '大高潮', '卷中决战', '卷终决战']

function climaxIdx(c: number): number {
  if (c >= 4) return 5
  if (c >= 3.25) return 4
  if (c >= 3) return 3
  if (c >= 2) return 2
  if (c >= 1) return 1
  return 0
}

/** 按相邻 actualized 一致性切分段，每段一条折线（实线=实际，虚线=预测） */
function segments(data: RhythmEntry[]): { actualized: boolean; pts: RhythmEntry[] }[] {
  if (data.length === 0) return []
  const out: { actualized: boolean; pts: RhythmEntry[] }[] = []
  let cur = { actualized: data[0].actualized, pts: [data[0]] }
  for (let i = 1; i < data.length; i++) {
    const e = data[i]
    if (e.actualized === cur.actualized) {
      cur.pts.push(e)
    } else {
      out.push(cur)
      cur = { actualized: e.actualized, pts: [e] }
    }
  }
  out.push(cur)
  return out
}

export default function RhythmChart({ data, volumes, onSelectChapter }: Props) {
  const [hovered, setHovered] = useState<RhythmEntry | null>(null)

  const maxCh = data.length > 0 ? data[data.length - 1].chapter : 1
  const xOf = (ch: number) => PAD_L + ((ch - 1) / Math.max(1, maxCh - 1)) * PLOT_W
  const yOf = (em: number) => PAD_T + (1 - em / 10) * PLOT_H

  const segs = useMemo(() => segments(data), [data])

  // 卷分界（章节 1, 31, 61, …）
  const volumeMarks = useMemo(() => {
    const marks: { chapter: number; label: string }[] = []
    if (volumes && volumes.length > 0) {
      for (const v of volumes) {
        marks.push({ chapter: v.chapterStart, label: `卷${v.number}` })
      }
    } else {
      // 无卷信息时，按每 30 章一道
      for (let v = 1; v * 30 < maxCh + 30; v++) {
        marks.push({ chapter: (v - 1) * 30 + 1, label: `卷${v}` })
      }
    }
    return marks.filter((m) => m.chapter >= 1 && m.chapter <= maxCh)
  }, [volumes, maxCh])

  if (data.length === 0) {
    return <p className="empty">暂无节奏数据（需先生成大纲/节奏图谱）。</p>
  }

  return (
    <div className="rhythm-chart-wrap">
      <div className="rhythm-legend">
        {CLIMAX_LABELS.map((label, i) => (
          <span key={label} className="legend-item">
            <span className="legend-dot" style={{ background: CLIMAX_COLORS[i] }} />
            {label}
          </span>
        ))}
        <span className="legend-item">
          <span className="legend-line solid" /> 实际值
        </span>
        <span className="legend-item">
          <span className="legend-line dashed" /> 预测值
        </span>
      </div>

      <div className="rhythm-chart" style={{ position: 'relative' }}>
        <svg
          className="rhythm-chart-svg"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block' }}
        >
          {/* Y 轴网格 + 刻度 */}
          {[0, 2, 4, 6, 8, 10].map((em) => (
            <g key={em}>
              <line
                x1={PAD_L}
                x2={VB_W - PAD_R}
                y1={yOf(em)}
                y2={yOf(em)}
                stroke="var(--line)"
                strokeWidth={0.5}
                strokeDasharray="2,3"
              />
              <text x={PAD_L - 8} y={yOf(em) + 4} textAnchor="end" fontSize={11} fill="var(--ink-light)">
                {em}
              </text>
            </g>
          ))}

          {/* X 轴刻度（每 50 章） */}
          {Array.from({ length: Math.floor(maxCh / 50) + 1 }, (_, i) => (i + 1) * 50)
            .filter((ch) => ch <= maxCh)
            .map((ch) => (
              <text
                key={ch}
                x={xOf(ch)}
                y={VB_H - PAD_B + 18}
                textAnchor="middle"
                fontSize={11}
                fill="var(--ink-light)"
              >
                {ch}
              </text>
            ))}

          {/* 卷分界竖线 + 卷标 */}
          {volumeMarks.map((m) => (
            <g key={m.chapter}>
              <line
                x1={xOf(m.chapter)}
                x2={xOf(m.chapter)}
                y1={PAD_T}
                y2={VB_H - PAD_B}
                stroke="var(--accent)"
                strokeWidth={0.8}
                strokeDasharray="4,4"
                opacity={0.5}
              />
              <text
                x={xOf(m.chapter) + 4}
                y={PAD_T + 12}
                fontSize={10}
                fill="var(--accent)"
              >
                {m.label}
              </text>
            </g>
          ))}

          {/* 情绪折线（按 actualized 分段） */}
          {segs.map((seg, i) => {
            const d = seg.pts
              .map((e, j) => `${j === 0 ? 'M' : 'L'} ${xOf(e.chapter).toFixed(1)} ${yOf(e.emotion).toFixed(1)}`)
              .join(' ')
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={seg.actualized ? '#2c3e50' : '#95a5a6'}
                strokeWidth={seg.actualized ? 2 : 1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={seg.actualized ? undefined : '5,3'}
              />
            )
          })}

          {/* 爽点散点（颜色=类型，填充=实际/预测） */}
          {data.map((e) => {
            const ci = climaxIdx(e.climax)
            const color = CLIMAX_COLORS[ci]
            const filled = e.actualized
            return (
              <circle
                key={e.chapter}
                cx={xOf(e.chapter)}
                cy={yOf(e.emotion)}
                r={e.climax >= 3 ? 4 : 3}
                fill={filled ? color : '#fff'}
                stroke={color}
                strokeWidth={1.5}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered(e)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelectChapter?.(e.chapter)}
              >
                <title>
                  第{e.chapter}章 {e.title}｜情绪 {e.emotion}｜{CLIMAX_LABELS[ci]}｜
                  {e.actualized ? '实际' : '预测'}
                </title>
              </circle>
            )
          })}
        </svg>

        {hovered ? (
          <div
            className="rhythm-tooltip"
            style={{
              left: `${(xOf(hovered.chapter) / VB_W) * 100}%`,
              top: `${(yOf(hovered.emotion) / VB_H) * 100}%`
            }}
          >
            <strong>
              第{hovered.chapter}章 · {hovered.title}
            </strong>
            <span>
              情绪值 {hovered.emotion} · {CLIMAX_LABELS[climaxIdx(hovered.climax)]}
            </span>
            <span className={hovered.actualized ? 'tag-actualized' : 'tag-forecast'}>
              {hovered.actualized ? '✅ 实际值' : '⏳ 预测值'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
