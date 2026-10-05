import { useEffect, useRef, useState } from 'react'
import type { StreamHandleOf } from '../../shared/types'
import { shortStoryIdeaBrief } from '../../shared/short-story'
import type { ShortStoryBrainstormResult, ShortStoryIdea, ShortStoryIdeaRewrite, ShortStoryRewriteFocus } from '../../shared/short-story'
import { shortStoryIdeaKey } from '../../shared/short-story-idea-utils'
import {
  allowShortStoryBrainstormRecoveryWrite, appendShortStoryBrainstormBatch, emptyShortStoryBrainstormRecovery,
  isValidShortStoryRewrite, readShortStoryBrainstormRecovery, releaseActiveShortStoryBrainstormRecovery,
  shortStoryBrainstormSourceMatches, toggleShortStoryBrainstormFavorite,
  updateActiveShortStoryBrainstormRecovery, validShortStoryBrainstormBatch, writeShortStoryBrainstormRecovery
} from './short-story-brainstorm-library'
import type { BrainstormRecovery, BrainstormStatus } from './short-story-brainstorm-library'
import './short-story-brainstorm.css'

interface Props {
  genre: string
  requirements: string
  targetWords: number
  sourceBrief?: string
  recoveryKey: string
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onAdopt: (idea: ShortStoryIdea) => boolean
}
type LibraryTab = 'current' | 'history' | 'favorites'
const STATUS_LABELS: Record<BrainstormStatus, string> = {
  idle: '尚未生成', generating: '正在生成', completed: '生成完成', stopped: '生成已停止', failed: '生成失败'
}
const FOCUS_LABELS: Record<ShortStoryRewriteFocus, string> = { twist: '反转', ending: '结局', emotion: '情绪', custom: '自定义要求' }
const FOCUS_HELP: Record<ShortStoryRewriteFocus, string> = {
  twist: '只修改关键反转，保留人物设定、开篇和结局。', ending: '只修改结局，保留人物设定、开篇和反转。',
  emotion: '加强情绪与人物选择，保留标题、核心设定和开篇。', custom: '按你的要求改写，保留标题与核心设定。'
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isAborted(error: unknown): boolean { return /\bLLM_ABORTED\b/.test(errorText(error)) }
function signature(genre: string, requirements: string, targetWords: number, brief: string, direction: string): string {
  return JSON.stringify({ genre, requirements, targetWords, brief, direction })
}
function dateLabel(value: string): string { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '之前保存的方案' }

export default function ShortStoryBrainstorm({
  genre, requirements, targetWords, sourceBrief = '', recoveryKey, disabled = false, onBusyChange, onAdopt
}: Props): React.ReactElement {
  const [state, setState] = useState<BrainstormRecovery>(emptyShortStoryBrainstormRecovery)
  const [view, setView] = useState<LibraryTab>('current')
  const [batchId, setBatchId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [stopping, setStopping] = useState(false)
  const mountedRef = useRef(false)
  const stateRef = useRef(state)
  const activeKeyRef = useRef(recoveryKey)
  const handleRef = useRef<StreamHandleOf<ShortStoryBrainstormResult> | null>(null)
  const runRef = useRef(0)
  const stoppingRunRef = useRef<number | null>(null)
  const busyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const busyCallbackRef = useRef(onBusyChange)
  busyCallbackRef.current = onBusyChange
  const generating = state.status === 'generating'
  const locked = disabled || generating || activeKeyRef.current !== recoveryKey
  const currentSource = signature(genre, requirements, targetWords, sourceBrief, state.direction)
  const selectedBatch = state.batches.find(batch => batch.id === batchId) ?? state.batches[0]
  const visibleSource = view === 'history' ? selectedBatch?.source ?? '' : state.source
  const visibleIdeas = view === 'history' ? selectedBatch?.ideas ?? [] : state.ideas
  const stale = view !== 'favorites' && visibleIdeas.length > 0 && !shortStoryBrainstormSourceMatches(visibleSource, currentSource, state.adoptedBrief)
  const directionId = `ss-brainstorm-direction-${recoveryKey}`
  const rawId = `ss-brainstorm-raw-${recoveryKey}`
  const rewriteFocusId = `ss-brainstorm-rewrite-focus-${recoveryKey}`
  const rewriteInstructionId = `ss-brainstorm-rewrite-instruction-${recoveryKey}`

  function commit(update: BrainstormRecovery | ((current: BrainstormRecovery) => BrainstormRecovery)): void {
    const next = typeof update === 'function' ? update(stateRef.current) : update
    stateRef.current = next
    allowShortStoryBrainstormRecoveryWrite(activeKeyRef.current)
    updateActiveShortStoryBrainstormRecovery(activeKeyRef.current, next)
    setState(next)
  }
  function flush(): void {
    if (mountedRef.current) setStorageError(!writeShortStoryBrainstormRecovery(activeKeyRef.current, stateRef.current))
  }
  function setBusy(value: boolean): void { busyRef.current = value; busyCallbackRef.current?.(value) }
  useEffect(() => {
    mountedRef.current = true
    activeKeyRef.current = recoveryKey
    const loaded = readShortStoryBrainstormRecovery(recoveryKey)
    stateRef.current = loaded.recovery
    updateActiveShortStoryBrainstormRecovery(recoveryKey, loaded.recovery)
    setState(loaded.recovery); setView('current'); setBatchId('')
    setWarning(loaded.warning); setStorageError(false); setError(''); setStopping(false)
    setMessage(loaded.recovery.status === 'stopped' && loaded.recovery.raw ? '已恢复上次中断前收到的文本，原有方案仍保留。'
      : loaded.recovery.ideas.length || loaded.recovery.favorites.length ? '已恢复上次的候选、历史与收藏。' : '')
    return () => {
      mountedRef.current = false; runRef.current += 1
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      writeShortStoryBrainstormRecovery(recoveryKey, stateRef.current)
      releaseActiveShortStoryBrainstormRecovery(recoveryKey)
      const handle = handleRef.current; handleRef.current = null
      void handle?.abort().catch(() => undefined)
      busyRef.current = false; stoppingRunRef.current = null
      busyCallbackRef.current?.(false)
    }
  }, [recoveryKey])
  useEffect(() => {
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (mountedRef.current) setStorageError(!writeShortStoryBrainstormRecovery(activeKeyRef.current, stateRef.current))
    }, 500)
  }, [state, recoveryKey])

  function markStopped(): void {
    commit(current => ({ ...current, status: 'stopped' }))
    setError(''); setMessage('已停止生成，原有方案仍保留。收到的文本可在下方查看和复制。')
  }
  async function generate(rewrite?: ShortStoryIdeaRewrite): Promise<void> {
    if (disabled || busyRef.current || !mountedRef.current || activeKeyRef.current !== recoveryKey) return
    if (!Number.isInteger(targetWords) || targetWords < 1000 || targetWords > 120000) { setError('请先填写 1000—120000 字之间的全文目标，再生成脑洞。'); return }
    if (genre.length > 200 || requirements.length > 10000 || sourceBrief.length > 10000) { setError('题材最多 200 字，梗概与写作要求各最多 10000 字，请缩短后生成。'); return }
    if (rewrite?.focus === 'custom' && !rewrite.instruction.trim()) { setError('请填写这次改写的具体要求。'); return }
    const requestRun = ++runRef.current; stoppingRunRef.current = null
    const direction = stateRef.current.direction
    const source = signature(genre, requirements, targetWords, sourceBrief, direction)
    const rewriteSnapshot = rewrite ? { idea: { ...rewrite.idea }, focus: rewrite.focus, instruction: rewrite.instruction } : undefined
    const rewriteWorkspace = rewriteSnapshot && stateRef.current.rewrite ? { ...stateRef.current.rewrite, original: { ...rewriteSnapshot.idea } } : null
    const excludedIdeas = stateRef.current.history.slice(-30)
    const previousIdeas = stateRef.current.previousIdeas.slice(-30).map(item => ({ ...item }))
    commit(current => ({ ...current, raw: '', status: 'generating', task: rewrite ? 'rewrite' : 'batch', responseWarning: '' }))
    setError(''); setMessage(''); setStopping(false); setBusy(true)
    if (!rewrite) setView('current')
    try {
      const seed = window.crypto.randomUUID()
      const handle = window.api.brainstormShortStory({ genre, requirements, targetWords, sourceBrief, direction,
        excludedIdeas, previousIdeas, rewrite: rewriteSnapshot, variationSeed: seed }, (token, done) => {
        if (!mountedRef.current || runRef.current !== requestRun) return
        if (!done && typeof token === 'string' && token) commit(current => ({ ...current, raw: current.raw + token }))
      })
      handleRef.current = handle
      const result = await handle
      if (!mountedRef.current || runRef.current !== requestRun) return
      if (result && !result.ok && isAborted(result.error)) { markStopped(); return }
      if (!result?.ok || !validShortStoryBrainstormBatch(result.ideas) || (rewriteSnapshot &&
        (result.ideas.length !== 1 || !isValidShortStoryRewrite(rewriteSnapshot.idea, result.ideas[0], rewriteSnapshot.focus)))) {
        commit(current => ({ ...current, status: 'failed' }))
        setError(`生成失败，原有方案与收到的文本仍保留：${typeof result?.error === 'string' ? result.error : rewriteSnapshot ? '改写结果未按指定范围修改，请重试。' : '没有收到完整的脑洞方案，请重试。'}`)
        return
      }
      const ideas = result.ideas.map(idea => ({ title: idea.title, premise: idea.premise, hook: idea.hook, twist: idea.twist, ending: idea.ending }))
      const responseWarning = typeof result.warning === 'string' ? result.warning : ''
      const createdAt = new Date().toISOString()
      if (rewriteSnapshot && rewriteWorkspace) {
        commit(current => ({ ...current, status: 'completed', responseWarning, raw: current.raw || JSON.stringify(ideas, null, 2),
          rewrite: { ...rewriteWorkspace, candidate: { idea: ideas[0], focus: rewriteSnapshot.focus, instruction: rewriteSnapshot.instruction, source, createdAt } } }))
        setMessage('改写候选已生成。请对照原方案，再采用或收藏。')
      } else {
        commit(current => ({ ...appendShortStoryBrainstormBatch(current, ideas, source, createdAt, seed), status: 'completed',
          responseWarning, raw: current.raw || JSON.stringify(ideas, null, 2) }))
        setMessage(`已生成 ${ideas.length} 个脑洞。喜欢的方案可以先收藏，也可以直接采用。`)
      }
    } catch (error) {
      if (!mountedRef.current || runRef.current !== requestRun) return
      if (isAborted(error)) markStopped()
      else { commit(current => ({ ...current, status: 'failed' })); setError(`生成失败，原有方案与收到的文本仍保留：${errorText(error)}`) }
    } finally {
      if (mountedRef.current && runRef.current === requestRun) {
        handleRef.current = null
        if (stoppingRunRef.current === requestRun) stoppingRunRef.current = null
        setStopping(false); setBusy(false); flush()
      }
    }
  }
  async function stop(): Promise<void> {
    const handle = handleRef.current
    if (!handle || stopping) return
    const requestRun = runRef.current; stoppingRunRef.current = requestRun; setStopping(true)
    try {
      const result = await handle.abort()
      if (!mountedRef.current || runRef.current !== requestRun || handleRef.current !== handle || !busyRef.current) return
      if (!result.ok) { setError('暂时无法停止生成，请稍后重试。'); return }
      runRef.current += 1; handleRef.current = null; stoppingRunRef.current = null
      markStopped(); setStopping(false); setBusy(false); flush()
    } catch (error) { if (mountedRef.current && runRef.current === requestRun) setError(`停止失败：${errorText(error)}`) }
    finally {
      if (mountedRef.current && activeKeyRef.current === recoveryKey && stoppingRunRef.current === requestRun) { stoppingRunRef.current = null; setStopping(false) }
    }
  }
  function adopt(idea: ShortStoryIdea): void {
    if (locked || !onAdopt({ ...idea })) return
    commit(current => ({ ...current, adoptedBrief: shortStoryIdeaBrief(idea) }))
    flush(); setMessage('脑洞已采用为故事梗概，可以继续编辑作品设定。')
  }
  function favorite(idea: ShortStoryIdea, source: string): void {
    if (locked) return
    const wasFavorite = stateRef.current.favorites.some(item => shortStoryIdeaKey(item.idea) === shortStoryIdeaKey(idea))
    const result = toggleShortStoryBrainstormFavorite(stateRef.current, idea, source, new Date().toISOString())
    if (result.error) { setError(result.error); return }
    allowShortStoryBrainstormRecoveryWrite(activeKeyRef.current)
    if (!writeShortStoryBrainstormRecovery(activeKeyRef.current, result.recovery)) { setStorageError(true); setError('收藏更改未能保存，原收藏列表仍保留。请复制需要的方案后再离开。'); return }
    commit(result.recovery); setStorageError(false); setError(''); setMessage(wasFavorite ? '已取消收藏。' : '脑洞已收藏，可在“收藏”中回看。')
  }
  function chooseRewrite(idea: ShortStoryIdea, source: string): void {
    if (locked) return
    const current = stateRef.current.rewrite
    if (current && shortStoryIdeaKey(current.original) === shortStoryIdeaKey(idea)) return
    const priorCandidate = current?.candidate
    if (priorCandidate && !stateRef.current.favorites.some(item => shortStoryIdeaKey(item.idea) === shortStoryIdeaKey(priorCandidate.idea)) &&
      stateRef.current.adoptedBrief !== shortStoryIdeaBrief(priorCandidate.idea) && !window.confirm('当前改写候选尚未采用或收藏。确定切换到另一个方案？')) return
    commit(value => ({ ...value, rewrite: { original: { ...idea }, originalSource: source, focus: 'twist', instruction: '', candidate: null } }))
    setError(''); setMessage('')
  }
  async function copyRaw(): Promise<void> {
    try { await navigator.clipboard.writeText(stateRef.current.raw); if (mountedRef.current) setMessage('生成文本已复制。') }
    catch (error) { if (mountedRef.current) setError(`无法自动复制，请选择文本手动复制：${errorText(error)}`) }
  }
  function ideaCard(idea: ShortStoryIdea, source: string, index: number, canRewrite = true): React.ReactElement {
    const isFavorite = state.favorites.some(item => shortStoryIdeaKey(item.idea) === shortStoryIdeaKey(idea))
    return <article className="ss-brainstorm-idea" key={`${index}-${shortStoryIdeaKey(idea)}`}>
      <div className="ss-brainstorm-idea-head"><span>{index + 1}</span><h3>{idea.title}</h3></div>
      <dl><div><dt>故事设定</dt><dd>{idea.premise}</dd></div><div><dt>开篇钩子</dt><dd>{idea.hook}</dd></div><div><dt>关键反转</dt><dd>{idea.twist}</dd></div><div><dt>结局</dt><dd>{idea.ending}</dd></div></dl>
      <div className="ss-brainstorm-card-actions"><button className="btn" type="button" disabled={locked} onClick={() => adopt(idea)}>采用这个脑洞</button><button className={`btn btn-sm ${isFavorite ? 'ss-brainstorm-favorited' : ''}`} type="button" disabled={locked} aria-pressed={isFavorite} onClick={() => favorite(idea, source)}>{isFavorite ? '取消收藏' : '收藏'}</button>{canRewrite && <button className="btn btn-ghost btn-sm" type="button" disabled={locked} onClick={() => chooseRewrite(idea, source)}>定向改写</button>}</div>
    </article>
  }
  return <section className="ss-brainstorm" aria-label="短篇脑洞生成">
    <div className="ss-brainstorm-head"><div><h2>脑洞生成</h2><p>根据题材、写作要求和全文预算，找一个能讲完的故事。</p></div><span className="ss-brainstorm-status" role="status">{generating && state.task === 'rewrite' ? '正在改写' : STATUS_LABELS[state.status]}{generating && state.raw ? ` · 已收到 ${state.raw.replace(/\s/g, '').length} 字` : ''}</span></div>
    <div className="field"><label htmlFor={directionId}>脑洞方向（可选）</label><textarea id={directionId} className="textarea" rows={2} maxLength={2000} disabled={locked} placeholder="例如：一个只能听见谎话的调查员，遇到了从不说谎的嫌疑人。" value={state.direction} onChange={event => { commit(current => ({ ...current, direction: event.target.value })); setError(''); setMessage('') }} /></div>
    <div className="ss-brainstorm-actions"><button className="btn btn-primary" type="button" disabled={locked} onClick={() => void generate()}>{generating ? '正在生成…' : state.ideas.length ? '换一批' : '生成 3 个脑洞'}</button>{generating && <button className="btn btn-danger" type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? '停止中…' : '停止生成'}</button>}<span className="muted">只生成创意。保留最近 5 批，最多收藏 30 个方案。</span></div>
    {error && <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">{error}</p>}
    {message && <p className="ss-brainstorm-notice ss-brainstorm-success" role="status">{message}</p>}
    {(warning || state.responseWarning) && <p className="ss-brainstorm-notice" role="status">{warning}{warning && state.responseWarning ? ' ' : ''}{state.responseWarning}</p>}
    {storageError && <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">无法保存脑洞恢复记录。离开前请复制需要的方案或生成文本。</p>}
    <nav className="ss-brainstorm-library-tabs" aria-label="脑洞库"><button className={`btn btn-sm ${view === 'current' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'current' ? 'page' : undefined} onClick={() => setView('current')}>当前候选 · {state.ideas.length}</button><button className={`btn btn-sm ${view === 'history' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}>历史 · {state.batches.length} 批</button><button className={`btn btn-sm ${view === 'favorites' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'favorites' ? 'page' : undefined} onClick={() => setView('favorites')}>收藏 · {state.favorites.length}</button></nav>
    {view === 'history' && state.batches.length > 0 && <div className="field ss-brainstorm-batch-picker"><label htmlFor={`ss-brainstorm-batch-${recoveryKey}`}>选择历史批次</label><select id={`ss-brainstorm-batch-${recoveryKey}`} className="select" disabled={locked} value={selectedBatch?.id ?? ''} onChange={event => setBatchId(event.target.value)}>{state.batches.map((batch, index) => <option key={batch.id} value={batch.id}>{index === 0 ? '最近一批 · ' : ''}{dateLabel(batch.createdAt)} · {batch.ideas.length} 个方案</option>)}</select></div>}
    {stale && <p className="ss-brainstorm-notice">题材、方向、梗概、写作要求或字数预算已变化，请核对这批候选后再采用，也可以换一批。</p>}
    {generating && state.task === 'batch' && state.ideas.length > 0 && <p className="muted ss-brainstorm-help">正在生成新的一批，原有候选会保留到新批次成功。</p>}
    {view === 'favorites' ? state.favorites.length > 0 ? <div className="ss-brainstorm-ideas">{state.favorites.map((item, index) => ideaCard(item.idea, item.source, index))}</div> : <p className="muted ss-brainstorm-library-empty">还没有收藏。遇到喜欢的脑洞，可以先收藏再换一批。</p>
      : visibleIdeas.length > 0 ? <div className="ss-brainstorm-ideas">{visibleIdeas.map((idea, index) => ideaCard(idea, visibleSource, index))}</div> : view === 'history' ? <p className="muted ss-brainstorm-library-empty">生成成功后，这里会保留最近的完整方案。</p> : null}
    {state.rewrite && <section className="ss-brainstorm-rewrite" aria-label="定向改写工作台">
      <div className="ss-brainstorm-head"><div><h3>定向改写 · {state.rewrite.original.title}</h3><p>改写结果单独展示，原方案会保留。</p></div><button className="btn btn-ghost btn-sm" type="button" disabled={locked} onClick={() => { if (!state.rewrite?.candidate || window.confirm('关闭改写工作台会丢弃当前改写候选，确定继续？')) commit(current => ({ ...current, rewrite: null })) }}>关闭改写</button></div>
      <div className="ss-brainstorm-rewrite-controls"><div className="field"><label htmlFor={rewriteFocusId}>改写重点</label><select id={rewriteFocusId} className="select" disabled={locked} value={state.rewrite.focus} onChange={event => commit(current => ({ ...current, rewrite: current.rewrite ? { ...current.rewrite, focus: event.target.value as ShortStoryRewriteFocus } : null }))}>{(Object.keys(FOCUS_LABELS) as ShortStoryRewriteFocus[]).map(value => <option key={value} value={value}>{FOCUS_LABELS[value]}</option>)}</select></div><div className="field"><label htmlFor={rewriteInstructionId}>改写要求{state.rewrite.focus === 'custom' ? '（必填）' : '（可选）'}</label><textarea id={rewriteInstructionId} className="textarea" rows={2} maxLength={2000} disabled={locked} value={state.rewrite.instruction} placeholder="例如：保留公平线索，让反转改变主角的选择。" onChange={event => commit(current => ({ ...current, rewrite: current.rewrite ? { ...current.rewrite, instruction: event.target.value } : null }))} /></div></div>
      <div className="ss-brainstorm-actions"><button className="btn btn-primary" type="button" disabled={locked} onClick={() => { const rewrite = stateRef.current.rewrite; if (rewrite) void generate({ idea: rewrite.original, focus: rewrite.focus, instruction: rewrite.instruction }) }}>生成改写候选</button><span className="muted">{FOCUS_HELP[state.rewrite.focus]}</span></div>
      {state.rewrite.candidate && (state.rewrite.candidate.focus !== state.rewrite.focus || state.rewrite.candidate.instruction !== state.rewrite.instruction) && <p className="ss-brainstorm-notice">改写要求已有变化，下方仍保留之前一次成功生成的候选。</p>}
      {state.rewrite.candidate && !shortStoryBrainstormSourceMatches(state.rewrite.candidate.source, currentSource, state.adoptedBrief) && <p className="ss-brainstorm-notice">生成条件已有变化，请核对改写候选后再采用。</p>}
      <div className="ss-brainstorm-rewrite-comparison"><div><h4>原方案</h4>{ideaCard(state.rewrite.original, state.rewrite.originalSource, 0, false)}</div><div><h4>改写候选{state.rewrite.candidate ? ` · ${FOCUS_LABELS[state.rewrite.candidate.focus]}` : ''}</h4>{state.rewrite.candidate ? ideaCard(state.rewrite.candidate.idea, state.rewrite.candidate.source, 1, false) : <p className="muted ss-brainstorm-library-empty">选择重点并生成后，在这里对照采用。</p>}</div></div>
    </section>}
    {(state.raw || state.status === 'failed' || state.status === 'stopped') && <details className="ss-brainstorm-raw" open={state.status === 'failed' || state.status === 'stopped'}>
      <summary>{state.status === 'failed' || state.status === 'stopped' ? '恢复文本（未采用）' : '查看原始生成文本'}</summary><div className="ss-brainstorm-raw-head"><p className="muted">停止或失败时，已经收到的文本会保留在这里。</p><button className="btn btn-sm" type="button" disabled={!state.raw} onClick={() => void copyRaw()}>复制生成文本</button></div><label className="ss-brainstorm-sr-only" htmlFor={rawId}>脑洞原始生成文本</label><textarea id={rawId} className="textarea" rows={10} readOnly value={state.raw} placeholder="这次尚未收到可恢复的文本。" />
    </details>}
  </section>
}
