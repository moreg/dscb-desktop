import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoverGenre, CoverLearningLibrarySummary, CoverLearningOptions, CoverLearningRunResult, CoverLearningTaskState } from '../../shared/types'

const GENRES: { value: CoverGenre; label: string }[] = [
  { value: 'xianxia', label: '玄幻 / 仙侠' }, { value: 'urban', label: '都市' },
  { value: 'ancient_romance', label: '古代言情' }, { value: 'modern_romance', label: '现代言情' },
  { value: 'mystery', label: '悬疑' }, { value: 'scifi', label: '科幻' },
  { value: 'western_fantasy', label: '西方奇幻' }, { value: 'historical', label: '历史' },
  { value: 'supernatural', label: '灵异 / 恐怖' }, { value: 'light_novel', label: '轻小说' }
]
const PHASE_LABELS: Record<CoverLearningTaskState['phase'], string> = {
  scanning: '扫描文件夹', analyzing: '分析封面', summarizing: '汇总学习规则', saving: '保存学习结果',
  completed: '学习完成', cancelled: '学习已取消', failed: '学习失败'
}
const RULE_SOURCE_LABELS = { builtin: '内置规则', user: '手动规则', statistics: '本地统计', ai: 'AI 分析' }
const AI_STATUS_LABELS = { off: '纯本地分析', skipped: 'AI 未执行', completed: 'AI 汇总完成', failed: 'AI 汇总失败', unsupported: '当前模型通道不支持看图' }
function isTaskActive(task: CoverLearningTaskState | null): boolean {
  return !!task && !['completed', 'cancelled', 'failed'].includes(task.phase)
}
export function describeCoverLearningPhase(phase: CoverLearningTaskState['phase']): string {
  return PHASE_LABELS[phase]
}
export function describeCoverLearningFeedback(feedback: NonNullable<CoverLearningLibrarySummary['feedbackSummary']>): string {
  return `封面反馈：已采用 ${feedback.adopted} 张 · 已拒绝 ${feedback.rejected} 张 · 已撤销评价 ${feedback.unrated} 张`
}
export function describeCoverLearningResult(result: CoverLearningRunResult): string {
  if (result.cancelled) return `学习已取消，保留已完成分析的 ${result.learned} 张新样本。下次重新选择同一文件夹可继续。`
  const rejected = result.rejected ?? 0
  if (result.learned === 0 && result.aiStatus === 'completed') {
    return `已分析已有样本并更新 AI 规则，未重复新增样本${result.failed + rejected > 0 ? `；失败 ${result.failed} 项、拒收 ${rejected} 张，请查看明细` : ''}。`
  }
  if (result.learned > 0) {
    const localResult = `新增 ${result.learned} 张${result.failed + rejected > 0 ? `，失败 ${result.failed} 项、拒收 ${rejected} 张，请查看明细` : ''}。`
    if (result.aiStatus === 'failed') return `本地学习完成：${localResult}AI 汇总失败，本次未新增 AI 规则。`
    if (result.aiStatus === 'unsupported') return `本地学习完成：${localResult}当前模型通道不支持看图，本次未新增 AI 规则。`
    if (result.aiStatus === 'skipped') return `本地学习完成：${localResult}AI 汇总未执行，请查看原因。`
    return `学习完成：${localResult}`
  }
  if (result.failed + rejected > 0) return `没有新增样本：重复 ${result.duplicates} 张，失败 ${result.failed} 项，拒收 ${rejected} 张，请查看明细。`
  if (result.scanned === 0) return '扫描完成：所选文件夹中没有支持的图片。'
  return `扫描完成：${result.duplicates} 张图片已在库中，已跳过重复样本。`
}

export default function CoverLearningLibraryPage(): React.ReactElement {
  const [library, setLibrary] = useState<CoverLearningLibrarySummary | null>(null)
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [task, setTask] = useState<CoverLearningTaskState | null>(null)
  const [taskReady, setTaskReady] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [lastResult, setLastResult] = useState<CoverLearningRunResult | null>(null)
  const [mode, setMode] = useState<NonNullable<CoverLearningOptions['aiMode']>>('off')
  const [genre, setGenre] = useState<CoverGenre | ''>('')
  const [ruleSaving, setRuleSaving] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const handledTask = useRef('')
  const busy = starting || isTaskActive(task)
  const mutating = saving || !!ruleSaving
  const applySummary = useCallback((summary: CoverLearningLibrarySummary): void => {
    if (!mounted.current) return
    setLibrary(summary)
    setDirectory(summary.directory)
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (!mounted.current) return
    setLoading(true)
    try { applySummary(await window.api.getCoverLearningLibrary()) }
    catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setLoading(false) }
  }, [applySummary])

  useEffect(() => {
    mounted.current = true
    void refresh()
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const current = await window.api.getCoverLearningTask()
        if (!mounted.current) return
        setTask(current)
        setTaskReady(true)
        setTaskError('')
        if (current && !isTaskActive(current) && handledTask.current !== `${current.id}:${current.phase}`) {
          handledTask.current = `${current.id}:${current.phase}`
          setCancelling(false)
          if (current.result) {
            setLastResult(current.result)
            setMessage(describeCoverLearningResult(current.result))
            void refresh()
          }
          if (current.phase === 'failed') setError(current.error ?? '学习失败，请重试。')
        }
      } catch (err) {
        if (mounted.current) {
          setTaskReady(false)
          setTaskError(`无法读取学习进度：${(err as Error).message}`)
        }
      } finally { polling = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 800)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [refresh])

  const chooseDirectory = async (): Promise<void> => {
    setSaving(true); setError(''); setMessage('')
    try {
      const selected = await window.api.chooseCoverLearningLibraryDirectory()
      if (!selected || !mounted.current) return
      applySummary(selected); setLastResult(null)
      setMessage(selected.status === 'ready' ? '学习库位置已更新，所有项目共用这里的规则。' : '')
    } catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setSaving(false) }
  }
  const saveDirectory = async (): Promise<void> => {
    if (!directory.trim()) { setError('学习库目录不能为空'); return }
    setSaving(true); setError(''); setMessage('')
    try {
      const selected = await window.api.setCoverLearningLibraryDirectory(directory.trim())
      if (!mounted.current) return
      applySummary(selected); setLastResult(null)
      setMessage(selected.status === 'ready' ? '学习库位置已保存，所有项目立即生效。' : '')
    } catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setSaving(false) }
  }
  const learnFolder = async (): Promise<void> => {
    setStarting(true); setError(''); setMessage('')
    try {
      const result = await window.api.chooseAndLearnCoverFolder({ aiMode: mode, ...(genre ? { genre } : {}) })
      if (!result || !mounted.current) return
      setLastResult(result); setMessage(describeCoverLearningResult(result))
      await refresh()
    } catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setStarting(false) }
  }
  const cancelLearning = async (): Promise<void> => {
    setCancelling(true); setError('')
    try {
      const result = await window.api.cancelCoverLearningTask()
      if (!mounted.current) return
      if (!result.ok) { setCancelling(false); setMessage('当前任务已结束，正在刷新结果。') }
    } catch (err) { if (mounted.current) { setCancelling(false); setError((err as Error).message) } }
  }
  const changeRule = async (id: string, enabled: boolean): Promise<void> => {
    setRuleSaving(id); setError('')
    try {
      applySummary(await window.api.setCoverLearningRuleEnabled({ id, enabled }))
      if (mounted.current) setMessage(enabled ? '规则已启用，下次生成封面时生效。' : '规则已停用，下次生成封面时生效。')
    } catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setRuleSaving('') }
  }
  const rollbackRules = async (): Promise<void> => {
    setRuleSaving('rollback'); setError('')
    try {
      applySummary(await window.api.rollbackCoverLearningRules())
      if (mounted.current) setMessage('已恢复上一次学习前的规则，样本指纹仍保留。')
    } catch (err) { if (mounted.current) setError((err as Error).message) }
    finally { if (mounted.current) setRuleSaving('') }
  }

  return (
    <div>
      <div className="page-head"><h1>学习库</h1><p className="desc">跨项目共享的本地创作知识，不属于任何一本书的工作区</p></div>
      {loading ? <p className="empty">正在读取学习库…</p> : null}
      {error ? <p role="alert" className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      {taskError ? <p role="alert" className="diag-msg" style={{ color: 'var(--danger)' }}>{taskError}</p> : null}
      {message ? <p role="status" className="diag-msg">{message}</p> : null}
      {library ? <>
        <div className="card" style={{ margin: '16px 0' }}>
          <div className="row row-wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
            <div><h2 style={{ margin: '0 0 6px' }}>番茄封面学习库</h2><p className="meta" style={{ margin: 0 }}>按题材采用有来源的学习规则，下一次提炼提示词或生成封面时生效。</p></div>
            <span className={`badge ${library.status === 'ready' ? '' : 'badge-alert'}`}>{library.status === 'ready' ? '● 正常加载' : '● 使用内置回退'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 12, marginTop: 20 }}>
            <Stat value={library.analyzedSampleCount ?? 0} label="已分析本地样本" suffix="张" />
            <Stat value={library.legacySampleCount ?? 0} label="内置参考样本" suffix="张" />
            <Stat value={Object.values(library.genreSampleCounts ?? {}).filter((count) => !!count).length} label="本地标注题材" suffix="个" />
            <Stat value={library.trackedSampleCount} label="已记录去重指纹" suffix="张" />
          </div>
          <p className="meta" style={{ marginBottom: 0 }}>内置参考样本与导入样本分开统计。已记录 {library.learningRunCount} 次学习，提供 {library.styleCount} 种预设风格。</p>
          {library.feedbackSummary ? <p className="meta" style={{ marginBottom: 0 }}>{describeCoverLearningFeedback(library.feedbackSummary)}</p> : null}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
          <div className="card" style={{ minWidth: 0 }}>
            <h2 style={{ margin: '0 0 6px' }}>学习新封面</h2>
            <p className="meta">递归读取 PNG、JPG、WEBP、BMP、GIF。改名、移动和标准化像素一致的缩放副本自动去重；不适合作为封面的图片会列出拒收原因。</p>
            <div className="field"><label htmlFor="cover-learning-mode">学习方式</label>
              <select id="cover-learning-mode" className="input" value={mode} disabled={busy || mutating} onChange={(event) => setMode(event.target.value as NonNullable<CoverLearningOptions['aiMode']>)}>
                <option value="off">纯本地统计（默认）</option><option value="summary">本地统计 + AI 总结</option><option value="vision">本地统计 + AI 看图</option>
              </select>
            </div>
            <p className="meta">{mode === 'off' ? '只在本机分析像素和指纹，不调用模型，也不上传图片。' : mode === 'summary' ? '调用“学习库”功能配置的模型，只发送统计指标与规则，不发送图片。模型可能产生费用；失败时保留本地结果。' : '调用“学习库”功能配置的视觉模型，会发送代表样本的缩略图。请选择支持看图的模型，模型可能产生费用；不支持看图时会显示原因。'}</p>
            <div className="field"><label htmlFor="cover-learning-genre">本批题材（可选）</label>
              <select id="cover-learning-genre" className="input" value={genre} disabled={busy || mutating} onChange={(event) => setGenre(event.target.value as CoverGenre | '')}>
                <option value="">未标注 / 混合题材</option>{GENRES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select><p className="meta">同一题材的图片放在一个文件夹中学习，能让规则更贴合当前作品。</p>
            </div>
            <button className="btn btn-primary" disabled={!taskReady || busy || mutating || library.status !== 'ready'} onClick={() => void learnFolder()}>{busy ? '学习任务进行中…' : !taskReady ? '正在读取任务状态…' : '选择封面文件夹并学习'}</button>
            {isTaskActive(task) && task ? <div className="placeholder" role="status" style={{ marginTop: 16, textAlign: 'left', padding: 16 }}>
              <div className="row row-wrap"><strong>{describeCoverLearningPhase(task.phase)}</strong><button className="btn btn-ghost" disabled={cancelling || task.phase === 'saving'} onClick={() => void cancelLearning()}>{cancelling ? '正在取消…' : '取消学习'}</button></div>
              {task.phase === 'analyzing' && task.scanned > 0 ? <progress aria-label="封面分析进度" value={task.processed} max={task.scanned} style={{ width: '100%', marginTop: 12 }} /> : null}
              <p className="meta">已扫描 {task.scanned} 张 · 已处理 {task.processed} 张 · 新增 {task.learned} 张 · 重复 {task.duplicates} 张 · 拒收 {task.rejected} 张 · 失败 {task.failed} 项</p>
              <p className="meta" style={{ overflowWrap: 'anywhere' }}>{task.currentFile ?? task.directory}</p>
              <p className="meta" style={{ marginBottom: 0 }}>可以切换页面，返回后会恢复任务进度。取消会保留已完成分析的样本。</p>
            </div> : null}
            {lastResult ? <div style={{ marginTop: 16 }}>
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>最近任务：扫描 {lastResult.scanned} 张 · 新增 {lastResult.learned} 张 · 重复 {lastResult.duplicates} 张 · 拒收 {lastResult.rejected ?? 0} 张 · 失败 {lastResult.failed} 项</p>
              <p className="meta" style={{ overflowWrap: 'anywhere' }}>{lastResult.directory} · {new Date(lastResult.completedAt).toLocaleString()}</p>
              {lastResult.aiStatus ? <p className="diag-msg" style={{ color: ['failed', 'unsupported'].includes(lastResult.aiStatus) ? 'var(--danger)' : undefined }}>{AI_STATUS_LABELS[lastResult.aiStatus]}{lastResult.aiMessage ? `：${lastResult.aiMessage}` : ''}</p> : null}
              <ul className="diag-list" style={{ margin: 0 }}>{lastResult.observations.map((observation, index) => <li key={index} className="diag-item"><span className="diag-msg">{observation}</span></li>)}</ul>
              {lastResult.issues?.length ? <details style={{ marginTop: 12 }}><summary>失败 / 拒收明细（{lastResult.issues.length} 项）</summary>
                <ul className="diag-list">{lastResult.issues.map((issue, index) => <li key={index} className="diag-item" style={{ display: 'block', overflowWrap: 'anywhere' }}><strong>{issue.kind === 'failed' ? '失败' : '拒收'}：{issue.path}</strong><p className="diag-msg" style={{ margin: '4px 0 0' }}>{issue.reason}</p></li>)}</ul>
              </details> : null}
            </div> : library.lastLearnedAt ? <p className="meta">最近一次学习：{new Date(library.lastLearnedAt).toLocaleString()}</p> : null}
          </div>
          <div className="card" style={{ minWidth: 0 }}>
            <h2 style={{ marginTop: 0 }}>本地保存位置</h2><p className="meta">新目录没有库文件时会复制当前库；已有库文件时先校验再切换。可放到备份盘或同步盘。</p>
            <div className="field"><label htmlFor="cover-learning-library-directory">学习库目录</label>
              <input id="cover-learning-library-directory" className="input" value={directory} disabled={busy || mutating} onChange={(event) => setDirectory(event.target.value)} />
              <div className="row row-wrap" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn btn-ghost" disabled={busy || mutating} onClick={() => void chooseDirectory()}>选择目录</button><button className="btn btn-primary" disabled={busy || mutating || directory.trim() === library.directory} onClick={() => void saveDirectory()}>{saving ? '保存中…' : '保存位置'}</button></div>
            </div>
            <p className="meta" style={{ overflowWrap: 'anywhere' }}>当前文件：{library.filePath}</p>
            {library.status === 'fallback' ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>原学习库没有被覆盖。当前已安全回退：{library.error ?? '文件格式异常'}</p> : null}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-ghost" disabled={loading || mutating} onClick={() => { setError(''); void refresh() }}>重新读取</button></div>
          </div>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row row-wrap" style={{ alignItems: 'flex-start' }}><div><h2 style={{ margin: '0 0 6px' }}>学习规则</h2><p className="meta" style={{ margin: 0 }}>查看来源、题材与证据。停用不合适的规则，或恢复最近一次学习前的规则。</p></div><button className="btn btn-ghost" disabled={busy || mutating || !library.canRollbackRules || library.status !== 'ready'} onClick={() => void rollbackRules()}>{ruleSaving === 'rollback' ? '恢复中…' : '回退最近学习规则'}</button></div>
          {library.rules?.length ? <ul className="diag-list" style={{ marginBottom: 0 }}>{library.rules.map((rule) => <li key={rule.id} className="diag-item" style={{ display: 'block' }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}><div style={{ flex: 1, minWidth: 0, opacity: rule.enabled ? 1 : 0.55 }}>
              <p className="diag-msg" style={{ margin: 0, overflowWrap: 'anywhere' }}>{rule.text}</p>
              <p className="meta" style={{ margin: '6px 0 0' }}>{RULE_SOURCE_LABELS[rule.source]} · {rule.genre ? GENRES.find((item) => item.value === rule.genre)?.label : '通用'} · 依据 {rule.sampleCount} 张样本{!rule.enabled ? ' · 已停用' : ''}</p>
              {rule.evidence?.length ? <details style={{ marginTop: 6 }}><summary className="meta">查看证据</summary><ul className="meta">{rule.evidence.map((evidence, index) => <li key={index} style={{ overflowWrap: 'anywhere' }}>{evidence}</li>)}</ul></details> : null}
            </div><label className="meta" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" aria-label={`启用规则：${rule.text}`} checked={rule.enabled} disabled={busy || mutating || library.status !== 'ready'} onChange={(event) => void changeRule(rule.id, event.target.checked)} /> 启用</label></div>
          </li>)}</ul> : <p className="meta">暂时没有可预览的学习规则。选择封面文件夹后会展示分析结果。</p>}
        </div>
      </> : !loading ? <button className="btn btn-ghost" onClick={() => { setError(''); void refresh() }}>重新读取学习库</button> : null}
    </div>
  )
}

function Stat({ value, label, suffix }: { value: number; label: string; suffix: string }): React.ReactElement {
  return <div className="placeholder" style={{ padding: 16 }}><div style={{ fontSize: 26, fontWeight: 700 }}>{value}{suffix}</div><div className="meta">{label}</div></div>
}
