import { useEffect, useState, type FormEvent } from 'react'
import type { RendererApi } from '../../shared/types'
import { createRendererApi } from '../../preload/api'
import App from './App'
import { createWebTransport, whenWebTransportReady } from './web-transport'
import './web-gate.css'

export default function WebGate() {
  const [phase, setPhase] = useState<'login' | 'ready'>('login')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function connect(): Promise<void> {
    createWebTransport()
    await whenWebTransportReady()
    window.api = createRendererApi(createWebTransport()) as RendererApi
    setPhase('ready')
  }

  useEffect(() => {
    let cancelled = false
    void fetch('/api/session').then(async (response) => {
      if (cancelled || !response.ok) return
      await connect()
    }).catch(() => {
      if (!cancelled) setError('无法连接服务器')
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      })
      const body = await response.json().catch(() => ({ error: '登录失败' })) as { error?: string }
      if (!response.ok) {
        setError(body.error || '口令不正确')
        return
      }
      await connect()
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接服务器')
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'ready') return <App />

  return (
    <div className="web-gate">
      <form className="web-gate-card" onSubmit={(event) => void submit(event)}>
        <h1>大神持笔</h1>
        <p>输入服务器口令后继续写作。作品和模型密钥都保存在这台服务器上。</p>
        <label htmlFor="web-access-token">访问口令</label>
        <input
          id="web-access-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoFocus
        />
        <p className="web-gate-error" role="alert">{error}</p>
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? '正在进入…' : '进入'}
        </button>
      </form>
    </div>
  )
}
