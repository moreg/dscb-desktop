import { useEffect, useState } from 'react'

export default function AutoDeslopSetting() {
  const [enabled, setEnabled] = useState<boolean>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void window.api.getAutoDeslopAfterContinue().then(value => {
      if (active) setEnabled(value)
    }).catch(() => {
      if (active) setError('无法读取自动去 AI 味设置，请重新打开设置。')
    })
    return () => { active = false }
  }, [])

  async function change(value: boolean): Promise<void> {
    setSaving(true)
    setError('')
    try {
      setEnabled(await window.api.setAutoDeslopAfterContinue(value))
    } catch {
      setError('保存自动去 AI 味设置失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <input type="checkbox" role="switch" checked={enabled === true} disabled={enabled === undefined || saving}
          onChange={e => void change(e.target.checked)} /> 续写完成后自动去 AI 味
      </label>
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
        默认关闭，适用于单章和批量续写。章节页「续写」按钮旁的勾选框只调整本次续写。
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
