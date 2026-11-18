import { useEffect, useState } from 'react'
import type { ChapterDirections, ChapterDirectionChoice } from '../../shared/chapter-directions'

interface Props {
  candidates: ChapterDirections | null
  loading: boolean
  error: string
  onCancel: () => void
  onRegenerate: () => void
  onChoose: (choice: ChapterDirectionChoice) => void
}

export default function ChapterDirectionsDialog({ candidates, loading, error, onCancel, onRegenerate, onChoose }: Props) {
  const [selected, setSelected] = useState(candidates?.recommendedId ?? '')
  const [adjustment, setAdjustment] = useState('')
  useEffect(() => { setSelected(candidates?.recommendedId ?? '') }, [candidates?.token, candidates?.recommendedId])
  return (
    <div className="dialog-overlay" style={{ position: 'fixed', inset: 0, zIndex: 10010, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="chapter-directions-title"
        style={{ width: 760, maxWidth: '100%', maxHeight: '90dvh', overflowY: 'auto', padding: 20, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <strong id="chapter-directions-title">选择本章走向{candidates ? ` · 第 ${candidates.chapterNumber} 章` : ''}</strong>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>取消</button>
        </header>
        <p className="muted" style={{ fontSize: 12.5 }}>
          {candidates?.missingPreviousProse
            ? '未找到上一章正文，本次依据全书大纲与可用资料规划。'
            : '本章暂无有效细纲，将结合大纲与已有正文规划五个方向。'}
          写完后自动生成本章细纲、概要并同步记忆，未经你明确要求不会写全书完结。
        </p>
        {loading ? <p role="status">正在生成五个方向和推荐理由…</p> : null}
        {error ? <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p> : null}
        <div role="radiogroup" aria-label="本章写作方向" style={{ display: 'grid', gap: 10 }}>
          {candidates?.directions.map((direction, index) => (
            <label key={direction.id} style={{ display: 'block', padding: 12, cursor: loading ? 'wait' : 'pointer', borderRadius: 8,
              border: `1px solid ${selected === direction.id ? 'var(--accent)' : 'var(--line)'}`, background: 'var(--surface)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="radio" name="chapter-direction" value={direction.id} checked={selected === direction.id}
                  disabled={loading} onChange={() => setSelected(direction.id)} />
                <strong>{index + 1}. {direction.title}</strong>
                {direction.id === candidates.recommendedId ? <span style={{ color: 'var(--accent)', fontSize: 12 }}>推荐</span> : null}
              </span>
              <dl style={{ fontSize: 12.5, lineHeight: 1.7, margin: '8px 0 0' }}>
                {[
                  ['承接点', direction.connection],
                  ['主要冲突', direction.conflict],
                  ...(direction.tension?.trim() ? [['场面张力', direction.tension] as const] : []),
                  ['本章推进', direction.progression],
                  ['本章落点', direction.ending],
                  ['章末悬念', direction.hook],
                  ['大纲依据', direction.outlineReason]
                ].map(([label, value]) => <div key={label}><dt style={{ display: 'inline', color: 'var(--ink-2)' }}>{label}：</dt><dd style={{ display: 'inline', margin: 0, whiteSpace: 'pre-wrap' }}>{value}</dd></div>)}
              </dl>
              {direction.id === candidates.recommendedId ? <p style={{ fontSize: 12.5, marginBottom: 0 }}><strong>推荐理由：</strong>{candidates.recommendationReason}</p> : null}
            </label>
          ))}
        </div>
        <label style={{ display: 'block', marginTop: 14, fontSize: 12.5 }}>调整选定方向（选填）。
          <textarea className="textarea" value={adjustment} onChange={e => setAdjustment(e.target.value)} maxLength={6000}
            disabled={loading} placeholder="可补充人物行动、调整冲突或章末落点。" style={{ display: 'block', width: '100%', minHeight: 80, marginTop: 6 }} />
        </label>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={onRegenerate} disabled={loading}>重新生成五个方向</button>
          <button className="btn btn-primary btn-sm" disabled={loading || !candidates || !selected}
            onClick={() => candidates && onChoose({ token: candidates.token, directionId: selected, adjustment: adjustment.trim() || undefined })}>
            按此方向续写
          </button>
        </footer>
      </div>
    </div>
  )
}
