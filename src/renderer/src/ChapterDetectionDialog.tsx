import { useCallback, useEffect, useRef, useState } from 'react'
import './chapter-detection.css'
import { currentChapterDetection, DETECTION_STATUS_LABELS } from '../../shared/chapter-detection'
import type { ChapterDetectionHistory, DetectionResultInput, DetectionStatus } from '../../shared/chapter-detection'

interface Props {
  projectId: string
  chapterNumber: number
  draft: string
  dirty: boolean
  onClose: () => void
}

export default function ChapterDetectionDialog({ projectId, chapterNumber, draft, dirty, onClose }: Props) {
  const [history, setHistory] = useState<ChapterDetectionHistory>({ currentRevision: '', records: [] })
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState<DetectionStatus>('completed')
  const [ai, setAi] = useState('')
  const [suspected, setSuspected] = useState('')
  const [human, setHuman] = useState('')
  const [evidence, setEvidence] = useState('')
  const [detectedAt, setDetectedAt] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const selected = history.records.find(record => record.id === selectedId)
  const last = selected?.events.at(-1)

  const refresh = useCallback(async () => {
    const next = await window.api.listChapterDetections(projectId, chapterNumber)
    setHistory(next)
    setSelectedId(id => next.records.some(record => record.id === id) ? id : next.records[0]?.id ?? '')
  }, [projectId, chapterNumber])

  useEffect(() => {
    dialog.current?.showModal()
    let live = true
    window.api.listChapterDetections(projectId, chapterNumber).then(next => {
      if (live) { setHistory(next); setSelectedId(next.records[0]?.id ?? '') }
    }).catch(err => { if (live) setError(String(err)) })
    return () => { live = false }
  }, [projectId, chapterNumber])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const capture = () => run(async () => {
    const record = await window.api.captureChapterDetection(projectId, chapterNumber, draft)
    await refresh()
    setSelectedId(record.id)
    setAi(''); setSuspected(''); setHuman(''); setEvidence(''); setDetectedAt(''); setStatus('completed')
    setNotice('整章快照已保存。请复制快照全文，在朱雀完成检测后登记结果。')
  })

  const recordResult = () => run(async () => {
    if (!selected) return
    let input: DetectionResultInput
    if (status === 'completed') {
      if ([ai, suspected, human].some(value => !value.trim()) || !detectedAt || !evidence.trim()) {
        throw new Error('请填写三项分数、实际检测时间和结果证据；空值不能当作 0%。')
      }
      input = { status, ai: Number(ai), suspected: Number(suspected), human: Number(human),
        detectedAt: new Date(detectedAt).toISOString(), evidence }
    } else input = { status, note: evidence }
    await window.api.recordChapterDetection(projectId, chapterNumber, selected.id, input)
    await refresh()
    setNotice('已登记到所选快照；正文变化后，该结果只保留在历史中。')
  })

  const exportRecord = () => {
    if (!selected) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `第${chapterNumber}章-朱雀-${selected.id}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <dialog ref={dialog} className="chapter-detection-dialog" onCancel={onClose} aria-labelledby="detection-title"
    style={{ width: 'min(880px, 92vw)', maxHeight: '90vh', overflow: 'auto', borderRadius: 12, padding: 24,
      background: 'var(--surface, #fff)', color: 'var(--ink, #222)', border: '1px solid var(--line, #ccc)' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 id="detection-title">第 {chapterNumber} 章 · 朱雀复测记录</h2>
      <button className="btn" onClick={onClose}>关闭</button>
    </header>
    <p>当前状态：<strong>{error ? '读取或操作失败，请刷新复核' : busy ? '正在处理' : currentChapterDetection(history, draft)}</strong>。</p>
    <p className="meta">人工登记外部结果。先保存整章，再创建快照、复制全文送检。软件不自动上传，也不将本地检查当作朱雀分数。</p>
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <button className="btn btn-primary" disabled={busy || dirty || !draft.trim()} onClick={capture}>新建整章送检快照</button>
      <button className="btn" disabled={busy} onClick={() => void run(refresh)}>刷新记录</button>
      <a href="https://matrix.tencent.com/ai-detect/ai_gen_txt" target="_blank" rel="noreferrer">打开朱雀检测</a>
    </div>
    {dirty && <p role="status">正文有未保存修改。请先保存，再创建新的送检快照。</p>}
    {error && <p role="alert" style={{ color: '#ba3333' }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {history.records.length > 0 && <>
      <p><label>检测批次：<select value={selectedId} disabled={busy} onChange={event => {
        setSelectedId(event.target.value); setAi(''); setSuspected(''); setHuman(''); setEvidence(''); setDetectedAt('')
      }}>
        {history.records.map(record => <option key={record.id} value={record.id}>
          #{record.attempt} · {new Date(record.createdAt).toLocaleString()} · {record.revision.slice(0, 8)} · {DETECTION_STATUS_LABELS[record.events.at(-1)?.status ?? 'pending']}
        </option>)}
      </select></label></p>
      {selected && <>
        <p>{selected.content === draft && selected.revision === history.currentRevision ? '所选快照与当前正文一致。' : '所选快照与当前正文不同，不能代表当前稿。'}</p>
        <details><summary>查看送检全文与版本信息</summary>
          <p style={{ overflowWrap: 'anywhere' }}>SHA-256：{selected.revision}。规则版本：{selected.policyVersion}。</p>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{selected.content}</pre>
        </details>
        <p style={{ display: 'flex', gap: 10 }}>
          <button className="btn" disabled={busy} onClick={() => void run(async () => {
            await navigator.clipboard.writeText(selected.content); setNotice('已复制所选快照的整章原文。')
          })}>复制送检全文</button>
          <button className="btn" onClick={exportRecord}>导出快照与记录</button>
        </p>
        {last?.status === 'completed' ? <section>
          <p>AI {last.ai}% · 疑似 AI {last.suspected}% · 人工 {last.human}%（人工登记）。</p>
          <p>检测时间：{new Date(last.detectedAt).toLocaleString()}。</p>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{last.evidence}</pre>
          <p className="meta">已完成结果不覆盖；需要纠正或复测时新建快照。</p>
        </section> : <fieldset disabled={busy} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <legend>登记所选快照的实际结果</legend>
          <label>状态：<select value={status} onChange={event => setStatus(event.target.value as DetectionStatus)}>
            {Object.entries(DETECTION_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{value === 'completed' ? '检测已完成，登记分数' : label}</option>)}
          </select></label>
          {status === 'completed' && <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {([['AI', ai, setAi], ['疑似 AI', suspected, setSuspected], ['人工', human, setHuman]] as const).map(([label, value, setter]) =>
                <label key={label}>{label}（%）：<input aria-label={`${label}百分比`} style={{ width: 85 }} type="number" min="0" max="100" step="0.01" value={value} onChange={event => setter(event.target.value)} /></label>)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <label>实际检测时间：<input type="datetime-local" step="1" value={detectedAt} onChange={event => setDetectedAt(event.target.value)} /></label>
              <button className="btn btn-sm" onClick={() => {
                const now = new Date()
                setDetectedAt(new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19))
              }}>填入当前时间</button>
            </div>
          </>}
          <label>结果证据／情况说明：<textarea rows={3} style={{ display: 'block', width: '100%' }} value={evidence}
            onChange={event => setEvidence(event.target.value)} placeholder="粘贴检测报告摘录、报告链接或已保存截图的路径。" /></label>
          <button className="btn btn-primary" onClick={recordResult}>保存本次登记</button>
        </fieldset>}
        <details style={{ marginTop: 16 }}><summary>查看本次状态记录</summary>
          {selected.events.map((event, index) => <p key={index}>{new Date(event.recordedAt).toLocaleString()} · {DETECTION_STATUS_LABELS[event.status]}。
            {event.status !== 'completed' && event.note}</p>)}
        </details>
      </>}
    </>}
  </dialog>
}
