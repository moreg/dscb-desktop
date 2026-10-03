import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterMeta, SavedChapterPolishResult } from '../../shared/types'
import { getBatchRangeError, MAX_BATCH_CHAPTERS } from '../../shared/batch-range'
import { useProjectStyleData } from './style-profile/hooks/useProjectStyleData'

export interface BatchPolishRange {
  from: number
  to: number
}

/** 默认处理最近已有正文的十章；章号缺口很大时仍遵守单次范围上限。 */
export function resolveBatchPolishRange(chapters: ChapterMeta[]): BatchPolishRange {
  const written = chapters.filter((chapter) => chapter.wordCount > 0)
    .map((chapter) => chapter.chapterNumber).sort((a, b) => a - b)
  if (written.length === 0) return { from: 1, to: 1 }
  const to = written[written.length - 1]
  return { from: Math.max(written[Math.max(0, written.length - 10)], to - MAX_BATCH_CHAPTERS + 1), to }
}

export function mergeBatchPolishResults(
  previous: SavedChapterPolishResult[],
  incoming: SavedChapterPolishResult[]
): SavedChapterPolishResult[] {
  const byChapter = new Map(previous.map((result) => [result.chapterNumber, result]))
  for (const result of incoming) byChapter.set(result.chapterNumber, result)
  return [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export function describeBatchPolishResult(result: SavedChapterPolishResult): string {
  if (result.autoDeslop.status === 'applied') return `去 AI 味已完成，正文已保存${result.error ? `；${result.error}` : ''}`
  if (result.autoDeslop.status === 'unchanged') return '无需修改，已保留原文'
  return result.error || result.autoDeslop.message
}

interface Props {
  projectId: string
  chapters: ChapterMeta[]
  preset?: BatchPolishRange
  onClose: () => void
  onChapterCompleted: () => void
}

export default function BatchPolishDialog({
  projectId,
  chapters,
  preset,
  onClose,
  onChapterCompleted
}: Props) {
  const [defaultRange] = useState(() => preset ?? resolveBatchPolishRange(chapters))
  const [fromStr, setFromStr] = useState(String(defaultRange.from))
  const [toStr, setToStr] = useState(String(defaultRange.to))
  const [styleProfileId, setStyleProfileId] = useState<string | null>(null)
  const { projectData, styleProfiles } = useProjectStyleData(projectId)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [results, setResults] = useState<SavedChapterPolishResult[]>([])
  const [progress, setProgress] = useState<{ chapter: number; step: string } | null>(null)
  const [error, setError] = useState('')
  const [completion, setCompletion] = useState<'completed' | 'stopped' | 'failed' | null>(null)
  const requestRef = useRef<string | null>(null)
  const aliveRef = useRef(true)
  const stopRequestedRef = useRef(false)
  const from = Number(fromStr)
  const to = Number(toStr)
  const rangeError = getBatchRangeError(from, to)?.replace('生成', '处理') ?? null
  const writtenInRange = useMemo(() => chapters.filter((chapter) =>
    chapter.wordCount > 0 && chapter.chapterNumber >= from && chapter.chapterNumber <= to
  ).length, [chapters, from, to])
  const appliedCount = results.filter((result) => result.autoDeslop.status === 'applied').length
  const attentionCount = results.filter((result) =>
    result.autoDeslop.status === 'review_required' || result.autoDeslop.status === 'failed'
  ).length
  const savedWithErrorCount = results.filter((result) => result.changed && result.error).length

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      const requestId = requestRef.current
      requestRef.current = null
      if (requestId) void window.api.abortStream(requestId).catch(() => {})
    }
  }, [])

  const start = async (): Promise<void> => {
    if (rangeError || writtenInRange === 0 || requestRef.current) return
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    stopRequestedRef.current = false
    setRunning(true)
    setStopping(false)
    setResults([])
    setProgress(null)
    setCompletion(null)
    setError('')
    const isCurrent = (): boolean => aliveRef.current && requestRef.current === requestId
    try {
      const response = await window.api.polishChaptersBatch(
        projectId,
        from,
        to,
        styleProfileId,
        (_chapter, result) => {
          if (!isCurrent()) return
          setResults((previous) => mergeBatchPolishResults(previous, [result]))
          if (result.changed) onChapterCompleted()
        },
        (chapter, step) => {
          if (isCurrent()) setProgress({ chapter, step })
        },
        requestId
      )
      if (!isCurrent()) return
      if (response.results) {
        setResults((previous) => mergeBatchPolishResults(previous, response.results!))
        if (response.results.some((result) => result.changed)) onChapterCompleted()
      }
      setCompletion(response.ok ? 'completed' : stopRequestedRef.current ? 'stopped' : 'failed')
      if (!response.ok && !stopRequestedRef.current) setError(response.error || '本批处理未完成，请查看逐章结果后重试。')
    } catch (err) {
      if (!isCurrent()) return
      setCompletion(stopRequestedRef.current ? 'stopped' : 'failed')
      if (!stopRequestedRef.current) setError((err as Error).message || '批量去 AI 味失败')
    } finally {
      if (isCurrent()) {
        requestRef.current = null
        setRunning(false)
        setStopping(false)
        setProgress(null)
      }
    }
  }

  const stop = async (): Promise<void> => {
    const requestId = requestRef.current
    if (!requestId || stopping) return
    stopRequestedRef.current = true
    setStopping(true)
    try {
      await window.api.abortStream(requestId)
    } catch (err) {
      if (!aliveRef.current || requestRef.current !== requestId) return
      stopRequestedRef.current = false
      setStopping(false)
      setError(`停止失败：${(err as Error).message || '请重试'}`)
    }
  }

  return (
    <div className="dialog-overlay" onClick={running ? undefined : onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-polish-title"
        style={{ width: 720, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="batch-polish-title">批量去 AI 味</h3>
        <p className="desc">
          检查所选范围内已保存的正文并轻度润色。核对事实后自动保存；发现差异会自动修复，最多两轮，仍未通过的章节保留原文。
        </p>
        {preset ? (
          <p className="meta">已选中本批次范围；会检查范围内全部已有正文，剧情按原文保留。</p>
        ) : <p className="meta">默认选中最近已有正文的 10 章，可调整范围。</p>}
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="batch-polish-from">起始章号</label>
            <input id="batch-polish-from" type="number" min={1} className="input" value={fromStr}
              disabled={running} onChange={(event) => setFromStr(event.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="batch-polish-to">结束章号</label>
            <input id="batch-polish-to" type="number" min={1} className="input" value={toStr}
              disabled={running} onChange={(event) => setToStr(event.target.value)} />
          </div>
        </div>
        <p className={rangeError ? 'error-text' : 'meta'}>
          {rangeError ?? `第 ${from}—${to} 章中有 ${writtenInRange} 章已有正文；单次最多处理 ${MAX_BATCH_CHAPTERS} 章。`}
        </p>
        <div className="field">
          <label htmlFor="batch-polish-style">文风</label>
          <select id="batch-polish-style" className="select" value={styleProfileId ?? '__project_default__'}
            disabled={running} onChange={(event) => setStyleProfileId(event.target.value === '__project_default__' ? null : event.target.value)}>
            <option value="__project_default__">
              使用项目默认{projectData?.defaultStyleProfileId ? `（${styleProfiles.find((profile) => profile.id === projectData.defaultStyleProfileId)?.name ?? '已设置'}）` : ''}
            </option>
            {styleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </div>
        <div aria-live="polite" className="meta" style={{ margin: '12px 0' }}>
          {running
            ? stopping ? '正在停止；已保存的章节会保留。'
              : progress ? `第 ${progress.chapter} 章：${progress.step === 'saving' ? '正在保存正文' : progress.step === 'summary' ? '正在更新章节概要' : '正在去 AI 味并核对事实'}… 已处理 ${results.length} 章。`
                : '正在开始批量去 AI 味…'
            : completion ? `${completion === 'completed' ? '本批处理完成' : completion === 'stopped' ? '已停止，已完成的章节保留' : '本批处理未完成'}。共处理 ${results.length} 章，已润色 ${appliedCount} 章${attentionCount ? `，${attentionCount} 章未通过，已保留原文` : ''}${savedWithErrorCount ? `，${savedWithErrorCount} 章正文已保存，后续更新需检查` : ''}。`
              : null}
        </div>
        {results.length > 0 ? (
          <ul className="batch-chapter-summary-list">
            {results.map((result) => {
              const needsAttention = !!result.error || result.autoDeslop.status === 'review_required' || result.autoDeslop.status === 'failed'
              return (
                <li key={result.chapterNumber} className={needsAttention ? 'has-issue' : ''}>
                  <span className="batch-chapter-summary-no">第 {result.chapterNumber} 章</span>
                  <span style={{ color: needsAttention ? 'var(--warn)' : undefined }}>{describeBatchPolishResult(result)}</span>
                  <span>自动修复 {result.autoDeslop.repairAttempts ?? 0} 次</span>
                  {result.autoDeslop.issues?.length ? <span style={{ color: 'var(--warn)' }}>{result.autoDeslop.issues.join('；')}</span> : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        {error ? <div className="error-text" role="alert">{error}</div> : null}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          {running ? (
            <button className="btn btn-ghost" disabled={stopping} onClick={() => void stop()}>
              {stopping ? '停止中…' : '停止'}
            </button>
          ) : null}
          <button className="btn btn-ghost" disabled={running} onClick={onClose}>关闭</button>
          <button className="btn btn-primary" disabled={running || !!rangeError || writtenInRange === 0} onClick={() => void start()}>
            {running ? '处理中…' : completion ? '再次处理所选范围' : '开始批量去 AI 味'}
          </button>
        </div>
      </div>
    </div>
  )
}
