import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { REFINEMENT_GOALS, type RefinementInput, type RefinementCandidate, type RefinementGoal,
  type RefinementResult, type RefinementStage } from '../../shared/chapter-refinement'
import type { StreamHandleOf } from '../../shared/types'
import { detectionRanges } from '../../shared/refinement-detection'
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
    top: Math.min(Math.max(margin, top), Math.max(margin, viewport.height - h - margin)),
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
  const [excerpts, setExcerpts] = useState<string[]>([''])
  const [baselineScore, setBaselineScore] = useState('')
  const [testStatus, setTestStatus] = useState<'green' | 'flagged'>('flagged')
  const [testScore, setTestScore] = useState('')
  const [testNote, setTestNote] = useState('')
  const [testConfirmed, setTestConfirmed] = useState(false)
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
  const [tab, setTab] = useState<'setup' | 'result'>('setup')
  function selectTab(next: 'setup' | 'result'): void {
    setTab(next)
    body.current?.scrollTo({ top: 0 })
  }
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
      selectTab(value?.candidate ? 'result' : 'setup')
      if (value) { setExcerpts(value.input.detection?.excerpts ?? ['']); setBaselineScore(value.input.detection?.score?.toString() ?? ''); setGoal(value.input.goal); setInstruction(value.input.instruction); setPlan(value.input.content === current.current.content ? value.input.plan ?? '' : '') }
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
      selection: automatic || goal === 'detection' ? undefined : selected,
      detection: !automatic && goal === 'detection' ? { excerpts, ...(baselineScore.trim() ? { score: Number(baselineScore) } : {}) } : undefined, plan: automatic ? undefined : plan.trim() || undefined, styleProfileId: props.styleProfileId }
    try { detectionRanges(input) } catch (e) { setError((e as Error).message); return }
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
      if (result.candidate) { setTestConfirmed(false); setTestStatus('flagged'); setTestScore(''); setTestNote(''); setRecord(result.candidate); setSource(input.content); setView('changes'); selectTab('result') }
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
    try { await window.api.discardRefinement(props.projectId, props.chapterNumber, record.id); if (mounted.current) { setRecord(null); selectTab('setup'); setNotice(kept ? '已放弃剩余候选，已采用的改动保留在正文中。' : '已放弃候选，正文保持不变。') } }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setWorking(false) }
  }
  if (!props.open) return null
  const floating = position && !compact
  async function copyDetectionCandidate(): Promise<void> {
    if (!record?.candidate) return
    try { await navigator.clipboard.writeText(record.candidate); setNotice('已复制完整候选。请到朱雀复测，再登记真实结果。') }
    catch { setError('复制失败，请切换“完整对比”手动复制完整候选。') }
  }
  async function recordDetection(): Promise<void> {
    if (!record || busyRef.current || props.disabled || !testConfirmed) return
    const id = ++runId.current
    setWorking(true); setError('')
    try {
      const updated = await window.api.recordRefinementDetection(props.projectId, props.chapterNumber, record.id, record.candidate,
        { status: testStatus, ...(testScore.trim() ? { score: Number(testScore) } : {}), note: testNote })
      if (mounted.current && id === runId.current) { setRecord(updated); setTestConfirmed(false); setNotice('已保存人工复测结果，仅适用于这份完整候选。') }
    } catch (e) { if (mounted.current && id === runId.current) setError((e as Error).message) }
    finally { if (mounted.current && id === runId.current) setWorking(false) }
  }

  return <aside ref={panelRef} className={`refinement-panel${dragging ? ' refinement-dragging' : ''}${floating ? ' refinement-floating' : ''}`}
    role="dialog" aria-label="正文精修" aria-modal="false"
    style={floating ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto', width: position.width, height: position.height } : undefined}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}>
    <header className="refinement-header" onMouseDown={startPanelDrag} title="拖动标题栏移动窗口">
      <div><span className="refinement-eyebrow">第 {props.chapterNumber} 章 · 独立候选稿</span><h2>正文精修</h2></div>
      <button className="btn btn-sm" onClick={props.onClose} title="收起面板，候选记录会保留">收起</button></header>
    <div className="refinement-tabs" role="tablist" aria-label="精修步骤" onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const focused = (event.target as HTMLElement).id === 'refinement-tab-setup' ? 'setup' : 'result'
        const next = event.key === 'Home' ? 'setup' : event.key === 'End' ? 'result' : focused === 'setup' ? 'result' : 'setup'
        selectTab(next)
        panelRef.current?.querySelector<HTMLButtonElement>(`#refinement-tab-${next}`)?.focus()
      }
    }}>
      <button type="button" id="refinement-tab-setup" role="tab" aria-selected={tab === 'setup'} aria-controls="refinement-setup"
        tabIndex={tab === 'setup' ? 0 : -1} onClick={() => selectTab('setup')}>精修设置</button>
      <button type="button" id="refinement-tab-result" role="tab" aria-selected={tab === 'result'} aria-controls="refinement-result"
        tabIndex={tab === 'result' ? 0 : -1} onClick={() => selectTab('result')}>候选对照</button>
    </div>
    <div className="refinement-body" ref={body}>
      {busy && <div className="refinement-progress" role="status"><span><i className="refinement-activity" aria-hidden="true" />{stream.current ? STAGES[stage] : '正在处理'} · {elapsed} 秒</span>
        {stream.current && <button className="btn btn-sm" onClick={() => void stream.current?.abort().catch(e => setError(e.message))}>停止</button>}</div>}
      {error && <div className="refinement-warning" role="alert">{error}</div>}
      {notice && <div className="refinement-notice" role="status">{notice}</div>}
      {(sourceChanged || stale) && <div className="refinement-warning" role="status">正文已变化，旧候选不能直接采用。<button className="btn btn-sm" disabled={busy} onClick={() => { setSource(props.content); setPlan(''); selectTab('setup'); setNotice('已使用当前正文，请重新生成候选。') }}>使用当前正文重新开始</button></div>}
      <section id="refinement-setup" role="tabpanel" aria-labelledby="refinement-tab-setup" hidden={tab !== 'setup'}>
      <div className="refinement-intro"><strong>让表达更好，保留故事本身</strong><p>默认保留剧情事实、人物关系和章节结局。先生成独立候选，对照满意后再采用。</p></div>
      <fieldset disabled={busy || props.disabled} className="refinement-controls"><legend>本次精修</legend>
        <div className="refinement-form-row"><label>范围<select disabled={goal === 'detection'} value={goal === 'detection' ? 'chapter' : scope} onChange={e => { setScope(e.target.value as typeof scope); setPlan('') }}>
          <option value="chapter">整章 · {source.length} 字符</option><option value="selection" disabled={!props.selection}>选区{props.selection ? ` · ${props.selection.end - props.selection.start} 字符` : '（请先选中文字）'}</option></select></label>
        <label>主要目标<select value={goal} onChange={e => { setGoal(e.target.value as RefinementGoal); setPlan('') }}>
          {Object.entries(REFINEMENT_GOALS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label></div>
        <p className="refinement-goal-hint">{REFINEMENT_GOALS[goal].description}</p>
        {goal === 'detection' && <section aria-label="朱雀标黄反馈">
          <p className="desc">从当前正文逐字复制标黄片段，每个输入框一段，支持多个相隔片段。其余文字逐字保留。每个片段至少 8 字符，重复出现的短句请附上相邻原文。</p>
          {excerpts.map((excerpt, index) => <label key={index}>标黄原文 {index + 1}<textarea className="textarea" rows={3} maxLength={40000} value={excerpt}
            onChange={e => { setExcerpts(values => values.map((value, i) => i === index ? e.target.value : value)); setPlan('') }} />
            {excerpts.length > 1 && <button type="button" className="btn btn-sm" onClick={() => { setExcerpts(values => values.filter((_, i) => i !== index)); setPlan('') }}>移除片段 {index + 1}</button>}</label>)}
          <button type="button" className="btn btn-sm" disabled={excerpts.length >= 20} onClick={() => { setExcerpts(values => [...values, '']); setPlan('') }}>添加标黄片段</button>
          <label>原稿 AI 生成概率（0–100，选填）<input type="number" min={0} max={100} value={baselineScore} onChange={e => setBaselineScore(e.target.value)} /></label>
        </section>}
        <label>补充要求{goal !== 'custom' && '（可选）'}<textarea className="textarea" rows={3} maxLength={10000} value={instruction} onChange={e => { setInstruction(e.target.value); setPlan('') }} placeholder="例如：保留双方和解的结果，减少直白解释，让试探更自然。" /></label>
        {plan && <label>修改方案 · 可编辑，生成候选即按此方案执行<textarea className="textarea" rows={6} maxLength={20000} value={plan} onChange={e => setPlan(e.target.value)} /></label>}
        {goal === 'scene' && !plan.trim() && <p className="refinement-goal-hint">场景精修需要先查看修改方案，再生成候选。</p>}
      </fieldset>
      <details className="refinement-preferences"><summary>自动精修设置<span>{auto ? '已开启' : '未开启'}</span></summary>
      <label className="refinement-auto"><input type="checkbox" checked={auto} onChange={e => {
        setAuto(e.target.checked)
        try { localStorage.setItem(`refinement:auto:${props.projectId}`, e.target.checked ? '1' : '0') } catch { setError('无法保存自动精修偏好，本次设置仅在当前页面有效。') }
      }} />完整单章写完后，为未通过表达验收的正文自动生成候选（额外调用模型，手动采用）</label>
      <p className="desc">最多一次精修、一次补救。自动候选仍需手动采用。</p></details>
      </section>
      <section id="refinement-result" role="tabpanel" aria-labelledby="refinement-tab-result" hidden={tab !== 'result'}>
      {!record && <div className="refinement-empty"><span className="refinement-empty-mark" aria-hidden="true">文</span><h3>候选将在这里展示</h3><p>设置精修目标并生成候选后，可逐条对照改动、查看核验结果，再决定是否采用。</p><button className="btn" onClick={() => selectTab('setup')}>前往精修设置</button></div>}
      {record && <section className="refinement-result">
        <div className="refinement-result-heading"><h3>候选与核验</h3><span className={`refinement-status refinement-status-${record.status}`}>{STATUS[record.status]}</span></div>
        <p className="desc">{REFINEMENT_GOALS[record.input.goal].label} · {record.input.goal === 'detection' ? `${record.input.detection?.excerpts.length ?? 0} 个标黄片段，其余文字保留` : record.input.selection ? '选区' : '整章'} · 已修订 {record.attempts} 次</p>
        {!!record.changes.length && <details className="refinement-summary"><summary>修改摘要 <span>{record.changes.length} 项</span></summary><ul>{record.changes.map((change, i) => <li key={i}>{change}</li>)}</ul></details>}
        {record.error && <div className="refinement-warning">{record.error}</div>}
        {record.verdict && <div className="refinement-verdict"><strong>独立核验</strong><p>{record.verdict.assessment}</p>
          <div className="refinement-checks"><span className={record.verdict.factsPreserved ? 'is-passed' : 'is-failed'}>事实保留 <b>{record.verdict.factsPreserved ? '通过' : '未通过'}</b></span><span className={record.verdict.goalMet ? 'is-passed' : 'is-failed'}>目标达成 <b>{record.verdict.goalMet ? '通过' : '未通过'}</b></span></div>
          {!!record.verdict.issues.length && <ul>{record.verdict.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
          <details><summary>查看核验依据</summary>{record.verdict.evidence.map((e, i) => <div key={i}><p>原文：{e.before}</p><p>候选：{e.after}</p><p className="desc">{e.reason}</p></div>)}</details>
        </div>}
        {record.input.goal === 'detection' && record.candidate && <section className="refinement-verdict" aria-label="朱雀候选复测">
          <strong>朱雀候选复测 · 人工登记</strong>
          <p>{record.detectionCheck ? `人工登记：${record.detectionCheck.status === 'green' ? '全绿' : '仍有标黄'}${record.detectionCheck.score === undefined ? '' : `，分数 ${record.detectionCheck.score}`}；登记时间 ${record.detectionCheck.recordedAt}` : '候选尚未登记朱雀复测；本地核验只评价保真与表达。'}</p>
          {record.detectionCheck?.note && <p>{record.detectionCheck.note}</p>}
          {record.input.detection?.score !== undefined && <p>原稿分数：{record.input.detection.score}{record.detectionCheck?.score === undefined ? '' : `；候选分数：${record.detectionCheck.score}；变化：${record.detectionCheck.score - record.input.detection.score > 0 ? '+' : ''}${record.detectionCheck.score - record.input.detection.score}（数值越低越好）`}</p>}
          {record.input.detection?.score !== undefined && record.detectionCheck?.score !== undefined && record.detectionCheck.score >= record.input.detection.score && <p role="status">本轮概率未下降，建议保留原稿并检查修改效果。不会自动追加修订。</p>}
          <p className="desc">结果绑定完整候选；当前正文{props.content === record.candidate ? '与候选一致' : '与候选不同，当前稿需单独检测'}。新一轮标黄请按复测原文重新指定范围。</p>
          <button className="btn" disabled={busy} onClick={() => void copyDetectionCandidate()}>复制完整候选去朱雀复测</button>
          <fieldset className="refinement-controls" disabled={busy || props.disabled || !['ready', 'rejected', 'accepted'].includes(record.status)}><legend>登记实际复测结果</legend>
            <label>结果<select value={testStatus} onChange={e => setTestStatus(e.target.value as typeof testStatus)}><option value="flagged">仍有标黄</option><option value="green">全绿</option></select></label>
            <label>候选 AI 生成概率（0–100，选填）<input type="number" min={0} max={100} value={testScore} onChange={e => setTestScore(e.target.value)} /></label>
            <label>复测说明（选填）<textarea className="textarea" rows={2} maxLength={2000} value={testNote} onChange={e => setTestNote(e.target.value)} /></label>
            <label><input type="checkbox" checked={testConfirmed} onChange={e => setTestConfirmed(e.target.checked)} />我已将这份完整候选送到朱雀，以上为实际结果</label>
            <button className="btn" disabled={!testConfirmed || busy} onClick={() => void recordDetection()}>保存人工复测结果</button>
          </fieldset>
        </section>}
        <div className="refinement-result-tools">
          <button className="btn btn-sm" disabled={busy} onClick={() => { selectTab('setup'); setNotice('修改目标或补充要求后重新生成。新一轮仍以原文为事实基线。') }}>继续调整</button>
          {typeof record.adoptedContent === 'string' && record.status !== 'accepted' && <button className="btn btn-sm" disabled={!canUndo} onClick={() => void commit(true)}>撤销已采用条目</button>}
        </div>
        {record.candidate && <><div className="refinement-view-switch" role="group" aria-label="对比视图">
          <button className="btn btn-sm" aria-pressed={view === 'changes'} onClick={() => setView('changes')}>修改位置</button><button className="btn btn-sm" aria-pressed={view === 'full'} onClick={() => setView('full')}>完整对比</button></div>
          {view === 'changes' ? <><p className="desc">显示前 {hunks.length} 处改动，完整内容见“完整对比”。{record.input.goal === 'detection' ? '标黄精修须通过核验后整体采用；需要缩小范围时请调整片段后重新生成。' : '每条可单独采用或不采纳，核验未通过时也可以单条采用。'}</p>{hunks.length ? hunks.map((hunk, i) => <details className="refinement-diff" key={`${hunk.line}:${hunk.index}:${i}`} open={i === 0}>
            <summary><span className="refinement-diff-title">改动 {i + 1}<small>原文第 {hunk.line} 段</small></span>{record.input.goal !== 'detection' && (record.status === 'ready' || record.status === 'rejected') && <span className="refinement-actions">
              <button type="button" className="btn btn-sm" disabled={!canPickHunk} aria-label={`不采纳改动 ${i + 1}`} onClick={event => { event?.preventDefault(); event?.stopPropagation(); void rejectHunk(i) }}>不采纳此条</button>
              <button type="button" className="btn btn-sm" disabled={!canPickHunk} aria-label={`采用改动 ${i + 1}`} onClick={event => { event?.preventDefault(); event?.stopPropagation(); void commit(false, i) }}>采用此条</button>
            </span>}</summary>
            <div><section><h4>原文</h4><pre>{hunk.before || '（新增）'}</pre></section><section><h4>候选</h4><pre>{hunk.after || '（删除）'}</pre></section></div>
          </details>) : <p>没有剩余改动，候选与当前正文相同。</p>}</>
            : <div className="refinement-full"><section><h4>原文</h4><pre>{record.adoptedContent ?? record.input.content}</pre></section><section><h4>候选</h4><pre>{record.candidate}</pre></section></div>}</>}
      </section>}
      </section>
    </div>
    <footer className="refinement-footer">
      <p className="refinement-footer-note">{tab === 'setup' ? '原文保留，生成候选不会覆盖正文。' : stale ? '正文已变化，请重新精修后采用。' : record?.status === 'accepted' ? '候选已保存，可撤销本次精修。' : record?.input.goal === 'detection' ? '标黄精修需整体核验通过；朱雀结果以人工复测为准。' : '逐条采用由你决定，整章采用须核验通过。'}</p>
      <div className="refinement-actions refinement-setup-actions" hidden={tab !== 'setup'}>
        <button className="btn" onClick={() => void run('plan')} disabled={busy || props.disabled || sourceChanged}>先看修改方案</button>
        <button className="btn btn-primary" onClick={() => void run('generate')} disabled={busy || props.disabled || sourceChanged || (goal === 'scene' && !plan.trim())}>{record ? '重新生成候选' : '生成精修候选'}</button>
      </div>
      <div className="refinement-actions refinement-adopt-actions" hidden={tab !== 'result' || !record}>
      {record?.status === 'accepted' ? <button className="btn" disabled={!canUndo} onClick={() => void commit(true)}>撤销本次精修</button> : <>
        <button className="btn" disabled={!record || busy || props.disabled} onClick={() => void discard()}>{typeof record?.adoptedContent === 'string' ? '放弃剩余候选' : '放弃候选'}</button>
        <button className="btn btn-primary" disabled={!canAdopt} onClick={() => void commit(false)}>{typeof record?.adoptedContent === 'string' ? '采用剩余并保存' : '采用并保存'}</button></>}
    </div></footer>
  </aside>
}
