import { useEffect, useRef, useState } from 'react'
import type { StreamHandleOf } from '../../shared/types'
import { longStoryIdeaBrief, longStoryIdeaKey } from '../../shared/long-story-brainstorm'
import type { LongStoryBrainstormResult, LongStoryIdea } from '../../shared/long-story-brainstorm'
import {
  allowLongStoryBrainstormRecoveryWrite, appendLongStoryBrainstormBatch, emptyLongStoryBrainstormRecovery,
  longStoryBrainstormSourceMatches, readLongStoryBrainstormRecovery, releaseActiveLongStoryBrainstormRecovery,
  toggleLongStoryBrainstormFavorite, updateActiveLongStoryBrainstormRecovery, validLongStoryBrainstormBatch,
  writeLongStoryBrainstormRecovery
} from './long-story-brainstorm-library'
import type { LongBrainstormRecovery, LongBrainstormStatus } from './long-story-brainstorm-library'
import './short-story-brainstorm.css'
import './long-story-brainstorm.css'

interface Props {
  genre: string
  requirements?: string
  targetChapters?: number
  sourceBrief?: string
  recoveryKey: string
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onAdopt: (idea: LongStoryIdea) => boolean
}
type LibraryTab = 'current' | 'history' | 'favorites'
const STATUS_LABELS: Record<LongBrainstormStatus, string> = {
  idle: '尚未生成', generating: '正在生成', completed: '生成完成', stopped: '生成已停止', failed: '生成失败'
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isAborted(error: unknown): boolean { return /\bLLM_ABORTED\b/.test(errorText(error)) }
function signature(genre: string, requirements: string, targetChapters: number | undefined, brief: string, direction: string): string {
  return JSON.stringify({ genre, requirements, targetChapters, brief, direction })
}
function dateLabel(value: string): string { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '之前保存的方案' }
function mergeRequirements(external: string, local: string): string { return [external.trim(), local.trim()].filter(Boolean).join('\n') }

export default function LongStoryBrainstorm({
  genre, requirements = '', targetChapters, sourceBrief = '', recoveryKey, disabled = false, onBusyChange, onAdopt
}: Props): React.ReactElement {
  const [state, setState] = useState<LongBrainstormRecovery>(emptyLongStoryBrainstormRecovery)
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
  const handleRef = useRef<StreamHandleOf<LongStoryBrainstormResult> | null>(null)
  const runRef = useRef(0)
  const stoppingRunRef = useRef<number | null>(null)
  const busyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const busyCallbackRef = useRef(onBusyChange)
  busyCallbackRef.current = onBusyChange
  const generating = state.status === 'generating'
  const locked = disabled || generating || activeKeyRef.current !== recoveryKey
  const currentSource = signature(genre, mergeRequirements(requirements, state.requirements), targetChapters, sourceBrief, state.direction)
  const selectedBatch = state.batches.find(batch => batch.id === batchId) ?? state.batches[0]
  const visibleSource = view === 'history' ? selectedBatch?.source ?? '' : state.source
  const visibleIdeas = view === 'history' ? selectedBatch?.ideas ?? [] : state.ideas
  const stale = view !== 'favorites' && visibleIdeas.length > 0 && !longStoryBrainstormSourceMatches(visibleSource, currentSource, state.adoptedBrief)
  const directionId = `ls-brainstorm-direction-${recoveryKey}`
  const requirementsId = `ls-brainstorm-requirements-${recoveryKey}`
  const rawId = `ls-brainstorm-raw-${recoveryKey}`

  function commit(update: LongBrainstormRecovery | ((current: LongBrainstormRecovery) => LongBrainstormRecovery)): void {
    const next = typeof update === 'function' ? update(stateRef.current) : update
    stateRef.current = next
    allowLongStoryBrainstormRecoveryWrite(activeKeyRef.current)
    updateActiveLongStoryBrainstormRecovery(activeKeyRef.current, next)
    setState(next)
  }
  function flush(): void {
    if (mountedRef.current) setStorageError(!writeLongStoryBrainstormRecovery(activeKeyRef.current, stateRef.current))
  }
  function setBusy(value: boolean): void { busyRef.current = value; busyCallbackRef.current?.(value) }
  useEffect(() => {
    mountedRef.current = true
    activeKeyRef.current = recoveryKey
    const loaded = readLongStoryBrainstormRecovery(recoveryKey)
    stateRef.current = loaded.recovery
    updateActiveLongStoryBrainstormRecovery(recoveryKey, loaded.recovery)
    setState(loaded.recovery); setView('current'); setBatchId('')
    setWarning(loaded.warning); setStorageError(false); setError(''); setStopping(false)
    setMessage(loaded.recovery.status === 'stopped' && loaded.recovery.raw ? '已恢复上次中断前收到的文本，原有方案仍保留。'
      : loaded.recovery.ideas.length || loaded.recovery.favorites.length ? '已恢复上次的候选、历史与收藏。' : '')
    return () => {
      mountedRef.current = false; runRef.current += 1
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      writeLongStoryBrainstormRecovery(recoveryKey, stateRef.current)
      releaseActiveLongStoryBrainstormRecovery(recoveryKey)
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
      if (mountedRef.current) setStorageError(!writeLongStoryBrainstormRecovery(activeKeyRef.current, stateRef.current))
    }, 500)
  }, [state, recoveryKey])

  function markStopped(): void {
    commit(current => ({ ...current, status: 'stopped' }))
    setError(''); setMessage('已停止生成，原有方案仍保留。收到的文本可在下方查看和复制。')
  }
  async function generate(): Promise<void> {
    if (disabled || busyRef.current || !mountedRef.current || activeKeyRef.current !== recoveryKey) return
    if (targetChapters !== undefined && (!Number.isInteger(targetChapters) || targetChapters < 1 || targetChapters > 100000)) {
      setError('预计章数须为 1—100000 之间的整数，也可以暂不填写。'); return
    }
    const direction = stateRef.current.direction
    const combinedRequirements = mergeRequirements(requirements, stateRef.current.requirements)
    if (genre.length > 200 || direction.length > 2000 || combinedRequirements.length > 10000 || sourceBrief.length > 10000) {
      setError('题材最多 200 字，方向最多 2000 字，梗概与合并后的脑洞要求各最多 10000 字，请缩短后生成。'); return
    }
    const requestRun = ++runRef.current; stoppingRunRef.current = null
    const source = signature(genre, combinedRequirements, targetChapters, sourceBrief, direction)
    const previousIdeas = stateRef.current.previousIdeas.slice(-30).map(item => ({ ...item }))
    commit(current => ({ ...current, raw: '', status: 'generating', responseWarning: '' }))
    setError(''); setMessage(''); setStopping(false); setBusy(true); setView('current')
    try {
      const seed = window.crypto.randomUUID()
      const handle = window.api.brainstormLongStory({ genre, requirements: combinedRequirements, targetChapters, sourceBrief, direction,
        previousIdeas, variationSeed: seed }, (token, done) => {
        if (!mountedRef.current || runRef.current !== requestRun) return
        if (!done && typeof token === 'string' && token) commit(current => ({ ...current, raw: current.raw + token }))
      })
      handleRef.current = handle
      const result = await handle
      if (!mountedRef.current || runRef.current !== requestRun) return
      if (result && !result.ok && isAborted(result.error)) { markStopped(); return }
      if (!result?.ok || !validLongStoryBrainstormBatch(result.ideas)) {
        commit(current => ({ ...current, status: 'failed' }))
        setError(`生成失败，原有方案与收到的文本仍保留：${typeof result?.error === 'string' ? result.error : '没有收到完整的脑洞方案，请重试。'}`)
        return
      }
      const ideas = result.ideas.map(idea => ({ title: idea.title, premise: idea.premise, hook: idea.hook, mainLine: idea.mainLine,
        progression: idea.progression, twist: idea.twist, ending: idea.ending }))
      const responseWarning = typeof result.warning === 'string' ? result.warning : ''
      commit(current => ({ ...appendLongStoryBrainstormBatch(current, ideas, source, new Date().toISOString(), seed), status: 'completed',
        responseWarning, raw: current.raw || JSON.stringify(ideas, null, 2) }))
      setMessage(`已生成 ${ideas.length} 个脑洞。喜欢的方案可以先收藏，也可以直接采用。`)
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
    if (!handle || stopping || stoppingRunRef.current === runRef.current) return
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
  function adopt(idea: LongStoryIdea): void {
    if (locked || busyRef.current || !mountedRef.current || !onAdopt({ ...idea })) return
    commit(current => ({ ...current, adoptedBrief: longStoryIdeaBrief(idea) }))
    flush(); setMessage('脑洞已采用为故事梗概，可以继续编辑作品设定。')
  }
  function favorite(idea: LongStoryIdea, source: string): void {
    if (locked || busyRef.current || !mountedRef.current) return
    const wasFavorite = stateRef.current.favorites.some(item => longStoryIdeaKey(item.idea) === longStoryIdeaKey(idea))
    const result = toggleLongStoryBrainstormFavorite(stateRef.current, idea, source, new Date().toISOString())
    if (result.error) { setError(result.error); return }
    allowLongStoryBrainstormRecoveryWrite(activeKeyRef.current)
    if (!writeLongStoryBrainstormRecovery(activeKeyRef.current, result.recovery)) {
      setStorageError(true); setError('收藏更改未能保存，原收藏列表仍保留。请复制需要的方案后再离开。'); return
    }
    commit(result.recovery); setStorageError(false); setError(''); setMessage(wasFavorite ? '已取消收藏。' : '脑洞已收藏，可在“收藏”中回看。')
  }
  async function copyText(text: string, success: string): Promise<void> {
    const requestRun = runRef.current; const key = activeKeyRef.current
    try { await navigator.clipboard.writeText(text); if (mountedRef.current && runRef.current === requestRun && activeKeyRef.current === key) setMessage(success) }
    catch (error) { if (mountedRef.current && runRef.current === requestRun && activeKeyRef.current === key) setError(`无法自动复制，请选择文本手动复制：${errorText(error)}`) }
  }
  function ideaCard(idea: LongStoryIdea, source: string, index: number): React.ReactElement {
    const isFavorite = state.favorites.some(item => longStoryIdeaKey(item.idea) === longStoryIdeaKey(idea))
    return <article className="ss-brainstorm-idea" key={`${index}-${longStoryIdeaKey(idea)}`}>
      <div className="ss-brainstorm-idea-head"><span>{index + 1}</span><h3>{idea.title}</h3></div>
      <dl><div><dt>故事设定</dt><dd>{idea.premise}</dd></div><div><dt>开篇钩子</dt><dd>{idea.hook}</dd></div><div><dt>长篇主线</dt><dd>{idea.mainLine}</dd></div><div><dt>成长与升级</dt><dd>{idea.progression}</dd></div><div><dt>关键反转</dt><dd>{idea.twist}</dd></div><div><dt>终局方向</dt><dd>{idea.ending}</dd></div></dl>
      <div className="ss-brainstorm-card-actions"><button className="btn" type="button" disabled={locked} onClick={() => adopt(idea)}>采用这个脑洞</button><button className={`btn btn-sm ${isFavorite ? 'ss-brainstorm-favorited' : ''}`} type="button" disabled={locked} aria-pressed={isFavorite} onClick={() => favorite(idea, source)}>{isFavorite ? '取消收藏' : '收藏'}</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => void copyText(`${idea.title}\n\n${longStoryIdeaBrief(idea)}`, '脑洞方案已复制。')}>复制方案</button></div>
    </article>
  }
  return <section className="ss-brainstorm ls-brainstorm" aria-label="长篇脑洞生成">
    <div className="ss-brainstorm-head"><div><h2>脑洞生成</h2><p>根据题材、故事设定和预计章数，生成能展开成长篇的故事创意。</p></div><span className="ss-brainstorm-status" role="status">{STATUS_LABELS[state.status]}{generating && state.raw ? ` · 已收到 ${state.raw.replace(/\s/g, '').length} 字` : ''}</span></div>
    <div className="field"><label htmlFor={directionId}>脑洞方向（可选）</label><textarea id={directionId} className="textarea" rows={2} maxLength={2000} disabled={locked} placeholder="例如：被逐出宗门的药师，能从废弃丹药中看见炼丹人的记忆。" value={state.direction} onChange={event => { commit(current => ({ ...current, direction: event.target.value })); setError(''); setMessage('') }} /></div>
    <div className="field"><label htmlFor={requirementsId}>脑洞要求（可选）</label><textarea id={requirementsId} className="textarea" rows={2} maxLength={10000} disabled={locked} placeholder="例如：主角靠谋略破局，每一卷都有新目标，感情线慢热。" value={state.requirements} onChange={event => { commit(current => ({ ...current, requirements: event.target.value })); setError(''); setMessage('') }} /></div>
    <div className="ss-brainstorm-actions"><button className="btn btn-primary" type="button" disabled={locked} onClick={() => void generate()}>{generating ? '正在生成…' : state.ideas.length ? '换一批' : '生成 3 个脑洞'}</button>{generating && <button className="btn btn-danger" type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? '停止中…' : '停止生成'}</button>}<span className="muted">只生成创意。保留最近 5 批，最多收藏 30 个方案。</span></div>
    {error && <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">{error}</p>}
    {message && <p className="ss-brainstorm-notice ss-brainstorm-success" role="status">{message}</p>}
    {(warning || state.responseWarning) && <p className="ss-brainstorm-notice" role="status">{warning}{warning && state.responseWarning ? ' ' : ''}{state.responseWarning}</p>}
    {storageError && <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">无法保存脑洞恢复记录。离开前请复制需要的方案或生成文本。</p>}
    <nav className="ss-brainstorm-library-tabs" aria-label="脑洞库"><button className={`btn btn-sm ${view === 'current' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'current' ? 'page' : undefined} onClick={() => setView('current')}>当前候选 · {state.ideas.length}</button><button className={`btn btn-sm ${view === 'history' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}>历史 · {state.batches.length} 批</button><button className={`btn btn-sm ${view === 'favorites' ? 'ss-brainstorm-tab-active' : 'btn-ghost'}`} type="button" disabled={locked} aria-current={view === 'favorites' ? 'page' : undefined} onClick={() => setView('favorites')}>收藏 · {state.favorites.length}</button></nav>
    {view === 'history' && state.batches.length > 0 && <div className="field ss-brainstorm-batch-picker"><label htmlFor={`ls-brainstorm-batch-${recoveryKey}`}>选择历史批次</label><select id={`ls-brainstorm-batch-${recoveryKey}`} className="select" disabled={locked} value={selectedBatch?.id ?? ''} onChange={event => setBatchId(event.target.value)}>{state.batches.map((batch, index) => <option key={batch.id} value={batch.id}>{index === 0 ? '最近一批 · ' : ''}{dateLabel(batch.createdAt)} · {batch.ideas.length} 个方案</option>)}</select></div>}
    {stale && <p className="ss-brainstorm-notice">题材、方向、梗概、脑洞要求或预计章数已变化，请核对这批候选后再采用，也可以换一批。</p>}
    {generating && state.ideas.length > 0 && <p className="muted ss-brainstorm-help">正在生成新的一批，原有候选会保留到新批次成功。</p>}
    {view === 'favorites' ? state.favorites.length > 0 ? <div className="ss-brainstorm-ideas">{state.favorites.map((item, index) => ideaCard(item.idea, item.source, index))}</div> : <p className="muted ss-brainstorm-library-empty">还没有收藏。遇到喜欢的脑洞，可以先收藏再换一批。</p>
      : visibleIdeas.length > 0 ? <div className="ss-brainstorm-ideas">{visibleIdeas.map((idea, index) => ideaCard(idea, visibleSource, index))}</div> : view === 'history' ? <p className="muted ss-brainstorm-library-empty">生成成功后，这里会保留最近的完整方案。</p> : null}
    {(state.raw || state.status === 'failed' || state.status === 'stopped') && <details className="ss-brainstorm-raw" open={state.status === 'failed' || state.status === 'stopped'}>
      <summary>{state.status === 'failed' || state.status === 'stopped' ? '恢复文本（未采用）' : '查看原始生成文本'}</summary><div className="ss-brainstorm-raw-head"><p className="muted">停止或失败时，已经收到的文本会保留在这里。</p><button className="btn btn-sm" type="button" disabled={!state.raw} onClick={() => void copyText(stateRef.current.raw, '生成文本已复制。')}>复制生成文本</button></div><label className="ss-brainstorm-sr-only" htmlFor={rawId}>脑洞原始生成文本</label><textarea id={rawId} className="textarea" rows={10} readOnly value={state.raw} placeholder="这次尚未收到可恢复的文本。" />
    </details>}
  </section>
}
