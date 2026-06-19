import { useEffect, useState } from 'react'

interface Props {
  onBack: () => void
}

export default function SettingsPage({ onBack }: Props) {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = () => void window.api.hasLlmKey().then(setHasKey)
  useEffect(refresh, [])

  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    try {
      await window.api.configureLlm(key.trim())
      setKey('')
      setMsg('已保存（系统级加密存储）')
      refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        ‹ 返回
      </button>
      <h2 className="section mt">设置</h2>

      <div className="card" style={{ maxWidth: 520 }}>
        <h3 className="sub">MiniMax API Key</h3>
        <p className="muted">
          {hasKey ? '✓ 已配置，可使用 AI 续写与大纲生成' : '未配置，AI 功能不可用'}
        </p>
        <div className="field">
          <label>API Key</label>
          <input
            className="input"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving || !key.trim()}>
          {saving ? '保存中…' : '保存'}
        </button>
        {msg ? <p style={{ color: 'var(--success)', marginTop: 12 }}>{msg}</p> : null}
        <p className="meta" style={{ marginTop: 16 }}>
          Key 经 Electron safeStorage（Windows DPAPI / macOS Keychain）加密后存于本地{' '}
          <code>config/providers.enc</code>，源码不含任何密钥。
        </p>
      </div>
    </div>
  )
}
