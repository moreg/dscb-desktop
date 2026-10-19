import type { DeslopResult } from '../../shared/types'

interface Props {
  result: DeslopResult
  identical: boolean
  staleBaseline: boolean
  onApply: () => void
  onDiscard: () => void
}

/** Manual acceptance belongs to the author; failed checks remain visible beside the candidate. */
export default function DeslopResultActions({ result, identical, staleBaseline, onApply, onDiscard }: Props) {
  const issues = result.dialogueQuality?.passed === false ? result.dialogueQuality.issues : []
  const needsReview = result.dialogueQuality?.passed === false || result.remainingFindings.length > 0
  return (
    <div>
      {needsReview && (
        <div role="status" className="diag-msg" style={{ color: 'var(--ink-2)', marginTop: 8 }}>
          <p>自动验收未通过，原正文尚未修改。请对照候选稿，选择应用或不应用。</p>
          {result.dialogueQuality?.passed === false && (
            <p>候选稿对白占比：{(result.dialogueQuality.afterRatio * 100).toFixed(2)}%。</p>
          )}
          {issues.length > 0 && <ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
          {result.remainingFindings.length > 0 && <p>复扫仍有 {result.remainingFindings.length} 处待核对项。</p>}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onDiscard}>不应用，保留原文</button>
        <button className="btn btn-primary" onClick={onApply} disabled={identical}
          title={identical ? '无改动可应用' : staleBaseline ? '会覆盖润色期间的手动编辑；应用后可撤销' : undefined}>
          {needsReview ? '应用候选稿' : '应用到正文'}
        </button>
      </div>
    </div>
  )
}
