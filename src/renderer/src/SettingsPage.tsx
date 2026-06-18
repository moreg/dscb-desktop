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
      setMsg('已保存（加密存储）')
      refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <button onClick={onBack}>← 返回</button>
      <h2>设置</h2>
      <h3>MiniMax API Key</h3>
      <p style={{ color: hasKey ? '#059669' : '#d97706' }}>
        {hasKey ? '✓ 已配置' : '未配置（AI 生成不可用）'}
      </p>
      <p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          style={{ width: '100%' }}
        />
      </p>
      <button onClick={save} disabled={saving || !key.trim()}>
        保存
      </button>
      {msg ? <p style={{ color: '#059669' }}>{msg}</p> : null}
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 12 }}>
        Key 用 AES-256-GCM 加密后存在本地 <code>config/providers.enc</code>。
      </p>
    </div>
  )
}
