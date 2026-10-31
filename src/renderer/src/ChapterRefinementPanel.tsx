import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { REFINEMENT_GOALS, type RefinementInput, type RefinementCandidate, type RefinementGoal,
  type RefinementResult, type RefinementStage } from '../../shared/chapter-refinement'
import type { StreamHandleOf } from '../../shared/types'
import { listRefinementHunks, type TextDiffHunk } from '../../shared/text-diff'
import './chapter-refinement.css'

export interface RefinementPanelPosition { left: number; top: number; width: number; height: number }

export function clampRefinementPanel(
  left: number, top: number, width: number, height: number,
  viewport: { width: number; height: number }
): RefinementPanelPosition {
  const margin = 8
  const w = Math.min(Math.max(280, width), Math.max(280, viewport.width - margin * 2))
  const h = Math.min(Math.max(200, height), Math.max(200, viewport.height - margin * 2))
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, viewport.width - w - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, viewport.height - 80)),
    width: w,
    height: h
  }
}

function viewportSize(): { width: number; height: number } | null {
  if (typeof window.innerWidth !== 'number' || window.innerWidth <= 0) return null
  return { width: window.innerWidth, height: window.innerHeight }
}

function compactViewport(): boolean {
  const view = viewportSize()
  return !!view && view.width <= 600
}

function readPanelPosition(projectId: string): RefinementPanelPosition | null {
  try {
    const raw = localStorage.getItem(`refinement:pos:${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RefinementPanelPosition>
    if ([parsed.left, parsed.top, parsed.width, parsed.height].some(value => typeof value !== 'number' || !Number.isFinite(value))) return null
    const view = viewportSize()
    const position = parsed as RefinementPanelPosition
    return view ? clampRefinementPanel(position.left, position.top, position.width, position.height, view) : position
  } catch { return null }
}

function writePanelPosition(projectId: string, position: RefinementPanelPosition): void {
  try { localStorage.setItem(`refinement:pos:${projectId}`, JSON.stringify(position)) } catch { /* 位置仅在本次会话有效 */ }
}

interface Props {
  projectId: string
  chapterNumber: number
  content: string
  selection?: { start: number; end: number }
  styleProfileId?: string | null
  open: boolean
  disabled: boolean
  autoTrigger: number
  autoAlreadyPolished: boolean
  onOpen: () => void
  onClose: () => void
  beforeRun: () => Promise<boolean>
  onBusyChange: (busy: boolean, committing?: boolean) => void
  onCommitted: (before: string, content: string) => Promise<void>
  onUsage: () => void
}
const STAGES: Record<RefinementStage, string> = {
  planning: '正在整理修改方案', generating: '正在生成独立候选稿', verifying: '正在核验事实与改进目标', repairing: '正在补救未通过项（最后一次）'
}
const STATUS = { generating: '未完成', verifying: '待核验', ready: '自动核验通过', rejected: '未通过核验', cancelled: '已停止', failed: '未完成', applying: '采用处理中', accepted: '已采用', undone: '已撤销' }
function changes(before: string, after: string): TextDiffHunk[] {
  return listRefinementHunks(before, after)
}

export default function ChapterRefinementPanel(props: Props) {
  const current = useRef(props); current.current = props
  const mounted = useRef(true)
  const body = useRef<HTMLDivElement>(null)
  const stream = useRef<StreamHandleOf<RefinementResult> | null>(null)
  const runId = useRef(0)
  const [source, setSource] = useState(props.content)
  const [goal, setGoal] = useState<RefinementGoal>('expression')
  const [instruction, setInstruction] = useState('')
  const [scope, setScope] = useState<'chapter' | 'selection'>(props.selection ? 'selection' : 'chapter')
  const [plan, setPlan] = useState('')
  const [record, setRecord] = useState<RefinementCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [stage, setStage] = useState<RefinementStage>('generating')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [view, setView] = useState<'changes' | 'full'>('changes')
  const [auto, setAuto] = useState(() => {
    try { return localStorage.getItem(`refinement:auto:${props.projectId}`) === '1' } catch { return false }
  })
  const handledTrigger = useRef(props.autoTrigger)
  const selected = scope === 'selection' && props.selection ? props.selection : undefined
  const baseline = record ? (record.status === 'accepted' ? record.candidate : (record.adoptedContent ?? record.input.content)) : props.content
  const stale = !!record && props.content !== baseline
  const sourceChanged = source !== props.content
  const hunks = useMemo(() => record?.candidate && view === 'changes' ? changes(record.adoptedContent ?? record.input.content, record.candidate) : [], [record, view])
  const canPickHunk = !busy && !props.disabled && !stale && !!record?.candidate && (record.status === 'ready' || record.status === 'rejected')
  const canAdopt = canPickHunk && record?.status === 'ready' && !!record.verdict?.passed && record.candidate !== baseline
  const canUndo = !busy && !stale && !props.disabled && (record?.status === 'accepted' || typeof record?.adoptedContent === 'string')

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (stream.current) void stream.current.abort().catch(() => undefined)
      if (busyRef.current) current.current.onBusyChange(false)
    }
  }, [])
  useEffect(() => {
    if (!props.open || busyRef.current) return
    let alive = true
    const requestRun = runId.current
    setSource(current.current.content)
    setScope(current.current.selection ? 'selection' : 'chapter')
    void window.api.loadRefinement(props.projectId, props.chapterNumber).then(value => {
      if (!alive || busyRef.current || requestRun !== runId.current) return
      setRecord(value)
      if (value) { setGoal(value.input.goal); setInstruction(value.input.instruction); setPlan(value.input.content === current.current.content ? value.input.plan ?? '' : '') }
    }).catch(e => { if (alive && requestRun === runId.current) setError(String(e.message || e)) })
    return () => { alive = false }
  }, [props.open, props.projectId, props.chapterNumber])
  useEffect(() => {
    if (!busy) return
    const start = Date.now(); setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  function setWorking(value: boolean, committing = false): void {
    busyRef.current = value
    setBusy(value)
    current.current.onBusyChange(value, committing)
  }
  async function run(action: 'plan' | 'generate', automatic = false): Promise<void> {
    if (busyRef.current || current.current.disabled) return
    setError(''); setNotice('')
    const text = automatic ? current.current.content : source
    if (!text.trim()) { setError('请先写入正文。'); return }
    if (!automatic && text !== current.current.content) { setError('正文已变化，请先点击“使用当前正文重新开始”。'); return }
    const input: RefinementInput = { projectId: props.projectId, chapterNumber: props.chapterNumber, content: text,
      goal: automatic ? 'expression' : goal, instruction: automatic ? '' : instruction,
      selection: automatic ? undefined : selected, plan: automatic ? undefined : plan.trim() || undefined, styleProfileId: props.styleProfileId }
    if (input.goal === 'custom' && !input.instruction.trim()) { setError('请填写具体精修要求。'); return }
    if (action === 'generate' && input.goal === 'scene' && !input.plan) { setError('场景精修请先生成并确认修改方案。'); return }
    const id = ++runId.current
    setWorking(true)
    try {
      if (!await current.current.beforeRun() || !mounted.current || id !== runId.current) return
      setStage(action === 'plan' ? 'planning' : 'generating')
      const handle = window.api.refineChapter(input, action, next => { if (mounted.current && id === runId.current) setStage(next) })
      stream.current = handle
      const result = await handle
      if (!mounted.current || id !== runId.current) return
      if (!result.ok) setError(result.error?.includes('LLM_ABORTED') ? '已停止，正文未修改。' : result.error || '精修未完成')
      if (result.plan) setPlan(result.plan)
      if (result.candidate) { setRecord(result.candidate); setSource(input.content); setView('changes') }
      current.current.onUsage()
    } catch (e) { if (mounted.current && id === runId.current) setError((e as Error).message) }
    finally {
      if (mounted.current && id === runId.current) { stream.current = null; setWorking(false) }
    }
  }
  const runRef = useRef(run); runRef.current = run
  useEffect(() => {
    const latest = current.current
    if (latest.autoTrigger === handledTrigger.current) return
    handledTrigger.current = latest.autoTrigger
    if (!auto || !latest.autoTrigger || latest.autoAlreadyPolished) return
    latest.onOpen()
    setSource(latest.content); setScope('chapter'); setGoal('expression'); setInstruction(''); setPlan('')
    void runRef.current('generate', true)
  }, [props.autoTrigger, auto])

  const panelRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null)
  const [position, setPosition] = useState<RefinementPanelPosition | null>(() => readPanelPosition(props.projectId))
  const positionRef = useRef(position)
  positionRef.current = position
  const [dragging, setDragging] = useState(false)
  const compact = compactViewport()

  function startPanelDrag(event: ReactMouseEvent<HTMLElement>): void {
    if (compactViewport()) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, select, textarea')) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    const view = viewportSize()
    if (!view) return
    dragRef.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height }
    const next = clampRefinementPanel(rect.left, rect.top, rect.width, rect.height, view)
    positionRef.current = next
    setPosition(next)
    setDragging(true)
    event.preventDefault()
  }

  useEffect(() => {
    if (!dragging) return
    const handleMove = (event: MouseEvent) => {
      const drag = dragRef.current
      const view = viewportSize()
      if (!drag || !view) return
      const next = clampRefinementPanel(event.clientX - drag.offsetX, event.clientY - drag.offsetY, drag.width, drag.height, view)
      positionRef.current = next
      setPosition(next)
    }
    const handleUp = () => {
      setDragging(false)
      dragRef.current = null
      if (positionRef.current) writePanelPosition(current.current.projectId, positionRef.current)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragging])

  useEffect(() => {
    const handleResize = () => {
      const currentPosition = positionRef.current
      const view = viewportSize()
      if (!currentPosition || !view) return
      const next = clampRefinementPanel(currentPosition.left, currentPosition.top, currentPosition.width, currentPosition.height, view)
      positionRef.current = next
      setPosition(next)
    }
    window.addEventListener?.('resize', handleResize)
    return () => window.removeEventListener?.('resize', handleResize)
  }, [])

  async function commit(undo: boolean, hunkIndex?: number): Promise<void> {
    if (!record || busyRef.current || props.disabled || stale) return
    ++runId.current
    const before = current.current.content
    setWorking(true, true); setError(''); setNotice('')
    try {
      const result = hunkIndex === undefined
        ? await window.api.commitRefinement(props.projectId, props.chapterNumber, record.id, before, undo)
        : await window.api.commitRefinement(props.projectId, props.chapterNumber, record.id, before, undo, hunkIndex)
      if (!mounted.current) return
      setRecord(result.candidate ?? { ...record, status: undo ? 'undone' : 'accepted' })
      await current.current.onCommitted(before, result.content)
      if (!mounted.current) return
      setSource(result.content)
      setNotice(result.warning || (undo
        ? (result.candidate?.status === 'ready' ? '已恢复精修前正文，候选仍可继续挑选，并保留历史版本。' : '已恢复精修前正文，并保留历史版本。')
        : hunkIndex !== undefined && result.content !== record.candidate
          ? `已采用第 ${hunkIndex + 1} 条并保存。其余改动仍可继续挑选。本章概要会按新正文判定是否过期，后续章节状态不重放。`
          : '已采用并保存。本章概要会按新正文判定是否过期，后续章节状态不重放。'))
    } catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setWorking(false) }
  }
  async function rejectHunk(hunkIndex: number): Promise<void> {
    if (!record || busyRef.current || !canPickHunk) return
    ++runId.current
    setWorking(true); setError(''); setNotice('')
    try {
      const next = await window.api.rejectRefinementHunk(props.projectId, props.chapterNumber, record.id, current.current.content, hunkIndex)
      if (!mounted.current) return
      setRecord(next)
      setNotice(`已不采纳第 ${hunkIndex + 1} 条，保留该处原文。其余改动仍可继续挑选。`)
    } catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setWorking(false) }
  }
  async function discard(): Promise<void> {
    if (!record || busyRef.current) return
    ++runId.current
    const kept = typeof record.adoptedContent === 'string'
    setWorking(true); setError('')
    try { await window.api.discardRefinement(props.projectId, props.chapterNumber, record.id); if (mounted.current) { setRecord(null); setNotice(kept ? '已放弃剩余候选，已采用的改动保留在正文中。' : '已放弃候选，正文保持不变。') } }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setWorking(false) }
  }
  if (!props.open) return null
  const floating = position && !compact
  return <aside ref={panelRef} className={`refinement-panel${dragging ? ' refinement-dragging' : ''}${floating ? ' refinement-floating' : ''}`}
    role="dialog" aria-label="正文精修" aria-modal="false"
    style={floating ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto', width: position.width, height: position.height } : undefined}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}>
    <header className="refinement-header" onMouseDown={startPanelDrag} title="拖动标题栏移动窗口">
      <div><span className="refinement-eyebrow">第 {props.chapterNumber} 章 · 独立候选稿</span><h2>正文精修</h2></div>
      <button className="btn btn-sm" onClick={props.onClose} title="收起面板，候选记录会保留">收起</button></header>
    <div className="refinement-body" ref={body}>
      <p className="desc">原文保留，采用后才替换。默认保留剧情事实、人物关系和章节结局。</p>
      <fieldset disabled={busy || props.disabled} className="refinement-controls"><legend>本次精修</legend>
        <label>范围<select value={scope} onChange={e => { setScope(e.target.value as typeof scope); setPlan('') }}>
          <option value="chapter">整章 · {source.length} 字符</option><option value="selection" disabled={!props.selection}>选区{props.selection ? ` · ${props.selection.end - props.selection.start} 字符` : '（请先选中文字）'}</option></select></label>
        <label>主要目标<select value={goal} onChange={e => { setGoal(e.target.value as RefinementGoal); setPlan('') }}>
          {Object.entries(REFINEMENT_GOALS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <p className="desc">{REFINEMENT_GOALS[goal].description}</p>
        <label>补充要求{goal !== 'custom' && '（可选）'}<textarea className="textarea" rows={3} maxLength={10000} value={instruction} onChange={e => { setInstruction(e.target.value); setPlan('') }} placeholder="例如：保留双方和解的结果，减少直白解释，让试探更自然。" /></label>
        {plan && <label>修改方案 · 可编辑，生成候选即按此方案执行<textarea className="textarea" rows={6} maxLength={20000} value={plan} onChange={e => setPlan(e.target.value)} /></label>}
        <div className="refinement-actions"><button className="btn" onClick={() => void run('plan')} disabled={sourceChanged}>先看修改方案</button>
          <button className="btn btn-primary" onClick={() => void run('generate')} disabled={sourceChanged || (goal === 'scene' && !plan.trim())}>{record ? '重新生成候选' : '生成精修候选'}</button></div>
      </fieldset>
      {(sourceChanged || stale) && <div className="refinement-warning" role="status">正文已变化，旧候选不能直接采用。<button className="btn btn-sm" disabled={busy} onClick={() => { setSource(props.content); setPlan(''); setNotice('已使用当前正文，请重新生成候选。') }}>使用当前正文重新开始</button></div>}
      <label className="refinement-auto"><input type="checkbox" checked={auto} onChange={e => {
        setAuto(e.target.checked)
        try { localStorage.setItem(`refinement:auto:${props.projectId}`, e.target.checked ? '1' : '0') } catch { setError('无法保存自动精修偏好，本次设置仅在当前页面有效。') }
      }} />完整单章写完后，为未通过表达验收的正文自动生成候选（额外调用模型，手动采用）</label>
      <p className="desc">最多一次精修、一次补救。不会再次进入完整自动去 AI 味流程。</p>
      {busy && <div className="refinement-progress" role="status"><span>{stream.current ? STAGES[stage] : '正在处理'} · {elapsed} 秒</span>
        {stream.current && <button className="btn btn-sm" onClick={() => void stream.current?.abort().catch(e => setError(e.message))}>停止</button>}</div>}
      {error && <div className="refinement-warning" role="alert">{error}</div>}
      {notice && <div className="refinement-notice" role="status">{notice}</div>}
      {record && <section className="refinement-result">
        <div className="refinement-result-heading"><h3>候选与核验</h3><span className={`chip ${record.status === 'ready' ? 'refinement-passed' : ''}`}>{STATUS[record.status]}</span></div>
        <p className="desc">{REFINEMENT_GOALS[record.input.goal].label} · {record.input.selection ? '选区' : '整章'} · 已修订 {record.attempts} 次</p>
        {!!record.changes.length && <ul>{record.changes.map((change, i) => <li key={i}>{change}</li>)}</ul>}
        {record.error && <div className="refinement-warning">{record.error}</div>}
        {record.verdict && <div className="refinement-verdict"><strong>独立核验</strong><p>{record.verdict.assessment}</p>
          <p>事实保留：{record.verdict.factsPreserved ? '通过' : '未通过'} · 目标达成：{record.verdict.goalMet ? '通过' : '未通过'}</p>
          {!!record.verdict.issues.length && <ul>{record.verdict.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
          <details><summary>查看核验依据</summary>{record.verdict.evidence.map((e, i) => <div key={i}><p>原文：{e.before}</p><p>候选：{e.after}</p><p className="desc">{e.reason}</p></div>)}</details>
        </div>}
        {record.candidate && <><div className="refinement-actions" aria-label="对比视图">
          <button className="btn btn-sm" aria-pressed={view === 'changes'} onClick={() => setView('changes')}>修改位置</button><button className="btn btn-sm" aria-pressed={view === 'full'} onClick={() => setView('full')}>完整对比</button></div>
          {view === 'changes' ? <><p className="desc">显示前 {hunks.length} 处改动，完整内容见“完整对比”。每条可单独采用或不采纳，核验未通过时也可以单条采用。</p>{hunks.length ? hunks.map((hunk, i) => <details className="refinement-diff" key={`${hunk.line}:${hunk.index}:${i}`} open={i === 0}>
            <summary><span>改动 {i + 1}</span>{(record.status === 'ready' || record.status === 'rejected') && <span className="refinement-actions">
              <button type="button" className="btn btn-sm" disabled={!canPickHunk} aria-label={`不采纳改动 ${i + 1}`} onClick={event => { event?.preventDefault(); event?.stopPropagation(); void rejectHunk(i) }}>不采纳此条</button>
              <button type="button" className="btn btn-sm" disabled={!canPickHunk} aria-label={`采用改动 ${i + 1}`} onClick={event => { event?.preventDefault(); event?.stopPropagation(); void commit(false, i) }}>采用此条</button>
            </span>}</summary>
            <div><section><h4>原文</h4><pre>{hunk.before || '（新增）'}</pre></section><section><h4>候选</h4><pre>{hunk.after || '（删除）'}</pre></section></div>
          </details>) : <p>没有剩余改动，候选与当前正文相同。</p>}</>
            : <div className="refinement-full"><section><h4>原文</h4><pre>{record.adoptedContent ?? record.input.content}</pre></section><section><h4>候选</h4><pre>{record.candidate}</pre></section></div>}</>}
      </section>}
    </div>
    <footer className="refinement-footer"><span className="desc">每条改动都能单独采用或不采纳，不采纳时保留该处原文。整章采用需核验通过。</span><div className="refinement-actions">
      {record?.status === 'accepted' ? <button className="btn" disabled={!canUndo} onClick={() => void commit(true)}>撤销本次精修</button> : <>
        {typeof record?.adoptedContent === 'string' && <button className="btn" disabled={!canUndo} onClick={() => void commit(true)}>撤销已采用条目</button>}
        {record && <button className="btn" disabled={busy} onClick={() => { body.current?.scrollTo({ top: 0, behavior: 'smooth' }); setNotice('修改目标或补充要求后重新生成。新一轮仍以原文为事实基线。') }}>继续调整</button>}
        <button className="btn" disabled={!record || busy || props.disabled} onClick={() => void discard()}>{typeof record?.adoptedContent === 'string' ? '放弃剩余候选' : '放弃候选'}</button>
        <button className="btn btn-primary" disabled={!canAdopt} onClick={() => void commit(false)}>{typeof record?.adoptedContent === 'string' ? '采用剩余并保存' : '采用并保存'}</button></>}
    </div></footer>
  </aside>
}
