import { useEffect, useRef, useState } from 'react'

export default function ChapterNotificationSetting() {
  const [enabled, setEnabled] = useState(true)
  const [pending, setPending] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void window.api.getChapterCompletionNotification().then(value => {
      if (alive.current) setEnabled(value)
    }).catch(() => { if (alive.current) setError('无法读取通知设置，请重新打开设置。') })
      .finally(() => { if (alive.current) setPending(false) })
    return () => { alive.current = false }
  }, [])
  async function change(value: boolean): Promise<void> {
    if (pending) return
    setPending(true); setError(''); setMessage('')
    try {
      const saved = await window.api.setChapterCompletionNotification(value)
      if (alive.current) { setEnabled(saved); setMessage(saved ? '已开启续写完成通知' : '已关闭续写完成通知') }
    } catch { if (alive.current) setError('保存失败，通知设置未更改，请重试。') }
    finally { if (alive.current) setPending(false) }
  }
  return <div className="field" style={{ marginTop: 12 }}>
    <label><input type="checkbox" checked={enabled} disabled={pending} onChange={e => void change(e.target.checked)} /> 续写完成后显示 Windows 系统通知</label>
    <p className="muted" style={{ fontSize: 11.5 }}>默认开启，仅 Windows 桌面版生效。本轮续写通过交稿前检查后通知，失败或停止时不发送完成通知；点击通知可返回应用。后台记忆同步可能仍在进行。</p>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
