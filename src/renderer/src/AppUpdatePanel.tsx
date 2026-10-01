import { useEffect, useRef, useState } from 'react'
import type { AppUpdateState } from '../../shared/app-update'

export default function AppUpdatePanel({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [dismissed, setDismissed] = useState('')
  const revision = useRef(0)
  useEffect(() => {
    let alive = true
    const initialRevision = revision.current
    const unsubscribe = window.api.onAppUpdateState(next => {
      revision.current++
      setState(next)
    })
    void window.api.getAppUpdateState().then(next => {
      if (alive && revision.current === initialRevision) setState(next)
    }).catch(() => { if (alive) setError('无法读取更新状态') })
    return () => { alive = false; unsubscribe() }
  }, [])

  async function run(action: () => Promise<AppUpdateState>) {
    setPending(true)
    setError('')
    try { setState(await action()) } catch { setError('操作失败，请稍后重试') }
    finally { setPending(false) }
  }
  if (!state) return compact ? null : <p className="muted">{error || '加载更新信息…'}</p>
  const noticeKey = `${state.version}:${state.status}`
  if (compact && (!['available', 'downloading', 'downloaded'].includes(state.status) || dismissed === noticeKey)) return null
  const busy = pending || state.status === 'checking' || state.status === 'downloading'
  const message = !state.supported ? '自动更新仅在安装后的 Windows 应用中启用。'
    : state.status === 'checking' ? '正在检查更新…'
    : state.status === 'available' ? `发现新版本 ${state.version}`
    : state.status === 'current' ? '当前已是最新版本'
    : state.status === 'downloading' ? `正在下载 ${state.version} · ${Math.round(state.percent ?? 0)}%`
    : state.status === 'downloaded' ? `版本 ${state.version} 已下载，正常退出应用后安装。请先保存内容并结束正在进行的任务。`
    : state.status === 'error' ? state.error
    : '更新来自 GitHub Releases'

  return (
    <section className="card" aria-label="应用更新" style={{ marginBottom: 16 }}>
      {!compact && <h3 className="sub">应用更新 · 当前版本 {state.currentVersion}</h3>}
      <p role="status" style={{ fontSize: 13 }}>{message}</p>
      {!compact && <label style={{ display: 'block', margin: '12px 0', fontSize: 13 }}>
        <input type="checkbox" checked={state.autoCheck} disabled={pending}
          onChange={e => { void run(() => window.api.setAppUpdateAutoCheck(e.target.checked)) }} /> 启动时自动检查更新
      </label>}
      <div className="row" style={{ gap: 8 }}>
        {!compact && <button className="btn btn-ghost" disabled={!state.supported || busy || state.status === 'downloaded'}
          onClick={() => { void run(() => window.api.checkAppUpdate()) }}>检查更新</button>}
        {(state.status === 'available' || (state.status === 'error' && state.version)) &&
          <button className="btn" disabled={busy} onClick={() => {
            if (window.confirm('下载完成后会在正常退出应用时安装更新。退出前请保存写作内容，并结束正在进行的任务。是否下载？')) {
              void run(() => window.api.downloadAppUpdate())
            }
          }}>下载更新</button>}
        {compact && <button className="btn btn-ghost" onClick={() => setDismissed(noticeKey)}>收起</button>}
      </div>
      {state.status === 'downloading' && <progress aria-label="更新下载进度" value={state.percent ?? 0} max={100} style={{ width: '100%', marginTop: 12 }} />}
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
    </section>
  )
}
