import { useEffect, useRef, useState } from 'react'
import type { ChapterMeta, ChapterSummaryBatchItem, ChapterSummaryBatchProgress } from '../../shared/types'

export function mergeSummaryResults(previous: ChapterSummaryBatchItem[], incoming: ChapterSummaryBatchItem[]) {
  const map = new Map(previous.map((item) => [item.chapterNumber, item]))
  for (const item of incoming) map.set(item.chapterNumber, item)
  return [...map.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export default function BatchSummaryDialog({ projectId, chapters, onClose }: {
  projectId: string; chapters: ChapterMeta[]; onClose: () => void
}) {
  const written = chapters.filter((c) => c.wordCount > 0)
  const [from, setFrom] = useState(String(written.length ? written.reduce((min, c) => Math.min(min, c.chapterNumber), Infinity) : 1))
  const [to, setTo] = useState(String(written.reduce((max, c) => Math.max(max, c.chapterNumber), 1)))
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [results, setResults] = useState<ChapterSummaryBatchItem[]>([])
  const [progress, setProgress] = useState<ChapterSummaryBatchProgress | null>(null)
  const [completion, setCompletion] = useState<'completed' | 'partial' | 'stopped' | null>(null)
  const [error, setError] = useState('')
  const requestRef = useRef<string | null>(null)
  const alive = useRef(true)
  const fromChapter = Number(from), toChapter = Number(to)
  const valid = Number.isSafeInteger(fromChapter) && fromChapter > 0 && Number.isSafeInteger(toChapter) && toChapter >= fromChapter
  const count = written.filter((c) => c.chapterNumber >= fromChapter && c.chapterNumber <= toChapter).length
  const successful = results.filter((r) => r.status === 'generated' || r.status === 'reused')
  const failed = results.filter((r) => r.status === 'failed').length
  const reset = () => { setResults([]); setCompletion(null); setProgress(null); setError('') }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const requestId = requestRef.current
      requestRef.current = null
      if (requestId) void window.api.abortStream(requestId).catch(() => {})
    }
  }, [])

  const start = async (resume = false) => {
    if (!valid || !count || requestRef.current) return
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    const current = () => alive.current && requestRef.current === requestId
    const completed = resume ? successful.filter((r) => r.sourceHash).map((r) => ({
      chapterNumber: r.chapterNumber, sourceHash: r.sourceHash!
    })) : undefined
    if (!resume) setResults([])
    setRunning(true); setStopping(false); setCompletion(null); setError(''); setProgress(null)
    try {
      const response = await window.api.regenerateSummariesBatch(projectId,
        { fromChapter, toChapter, onlyMissing, completed },
        (result) => { if (current()) setResults((old) => mergeSummaryResults(old, [result])) },
        (value) => { if (current()) setProgress(value) }, requestId)
      if (!current()) return
      setResults((old) => mergeSummaryResults(old, response.results))
      setCompletion(response.stopped ? 'stopped' : response.ok ? 'completed' : 'partial')
      if (!response.ok && !response.stopped) setError(response.error || '部分章节未完成，请查看逐章结果。')
    } catch (err) {
      if (!current()) return
      setCompletion('partial')
      setError((err as Error).message || '概要批量生成失败')
    } finally {
      if (current()) { requestRef.current = null; setRunning(false); setStopping(false); setProgress(null) }
    }
  }
  const stop = async () => {
    const requestId = requestRef.current
    if (!requestId || stopping) return
    setStopping(true)
    try { await window.api.abortStream(requestId) }
    catch (err) {
      if (alive.current && requestRef.current === requestId) {
        setStopping(false); setError(`停止失败：${(err as Error).message}`)
      }
    }
  }

  return (
    <div className="dialog-overlay" onClick={running ? undefined : onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="batch-summary-title"
        style={{ width: 720, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h3 id="batch-summary-title">批量重新生成概要</h3>
        <p className="desc">按已保存正文逐章补齐剧情概要、道具归属、人物关系和知情范围。默认选中全书已有正文；每章完成即保存，支持中途停止和继续补齐。</p>
        <p className="meta">此操作会调用当前概要模型并产生用量，保留正文、人物卡和伏笔进度。</p>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="summary-from">起始章号</label>
            <input id="summary-from" className="input" type="number" min={1} value={from} disabled={running}
              onChange={(e) => { setFrom(e.target.value); reset() }} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="summary-to">结束章号</label>
            <input id="summary-to" className="input" type="number" min={1} value={to} disabled={running}
              onChange={(e) => { setTo(e.target.value); reset() }} />
          </div>
        </div>
        <p className={valid ? 'meta' : 'error-text'}>{valid ? `所选范围有 ${count} 章已有正文，按章号顺序处理。` : '请输入有效的起止章号。'}</p>
        <label className="row" style={{ gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={onlyMissing} disabled={running} onChange={(e) => { setOnlyMissing(e.target.checked); reset() }} />
          仅补齐缺失、过期或尚无道具／关系／知情记录的概要
        </label>
        <div className="meta" role="status" aria-live="polite">
          {running ? stopping ? '正在停止；已完成的概要会保留。' : progress
            ? `正在处理第 ${progress.chapter} 章（${progress.index}/${progress.total}）…` : '正在读取已保存章节…'
            : completion ? `${completion === 'completed' ? '本批已完成' : completion === 'stopped' ? '已停止' : '本批尚未全部完成'}：${successful.length} 章已补齐${failed ? `，${failed} 章失败` : ''}。` : null}
        </div>
        {(running || completion) && <progress aria-label="概要处理进度" max={progress?.total || count || 1}
          value={progress ? progress.index - 1 : results.length} style={{ width: '100%', margin: '12px 0' }} />}
        {results.length > 0 && <ul className="batch-chapter-summary-list">
          {results.map((r) => <li key={r.chapterNumber} className={r.status === 'failed' ? 'has-issue' : ''}>
            <span className="batch-chapter-summary-no">第 {r.chapterNumber} 章</span>
            <span>{r.status === 'generated' ? `概要已保存 · 连续性记录 ${r.continuityCount ?? 0} 条`
              : r.status === 'reused' ? '概要及连续性记录有效，已跳过重复生成' : r.error}</span>
          </li>)}
        </ul>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          {running && <button className="btn btn-ghost" disabled={stopping} onClick={() => void stop()}>{stopping ? '停止中…' : '停止'}</button>}
          <button className="btn btn-ghost" disabled={running} onClick={onClose}>关闭</button>
          {!running && completion && completion !== 'completed' && <button className="btn btn-primary" disabled={!valid || !count}
            onClick={() => void start(true)}>继续补齐未完成章节</button>}
          <button className="btn btn-primary" disabled={running || !valid || !count} onClick={() => void start()}>
            {running ? '生成中…' : completion ? '重新处理所选范围' : '开始批量生成概要'}
          </button>
        </div>
      </div>
    </div>
  )
}
