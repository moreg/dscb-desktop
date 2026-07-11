import { useState } from 'react'
import type {
  FeatureCategory,
  FeatureRoutingEntry,
  ProviderSummary
} from '../../shared/types'

const FEATURE_CATEGORIES: { key: FeatureCategory; label: string; hint: string }[] = [
  { key: 'chapter', label: '正文生成', hint: '续写 / 追问改写' },
  { key: 'review', label: '审稿质检', hint: '审稿 / 细纲对照 / 节奏评估' },
  { key: 'humanize', label: '去AI味改写', hint: '去AI味 / 改写' },
  { key: 'opening', label: '开局大纲', hint: '开局 / 大纲 / 登场识别 / 关系推断' },
  { key: 'auxiliary', label: '辅助提取', hint: '记忆 / 图解 / 结尾状态 / 拆书' }
]

/**
 * 功能模型分配表单：为每个功能大类选择 provider 与可选模型覆盖。
 * routing 变化时由父组件通过 key 重挂载以同步草稿（见 SettingsPage 调用处）。
 */
export default function FeatureRoutingForm({
  providers,
  routing,
  onSaved
}: {
  providers: ProviderSummary[]
  routing?: Partial<Record<FeatureCategory, FeatureRoutingEntry>>
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Record<string, { providerId: string; model: string }>>(
    () => {
      const init: Record<string, { providerId: string; model: string }> = {}
      for (const cat of FEATURE_CATEGORIES) {
        const entry = routing?.[cat.key]
        init[cat.key] = { providerId: entry?.providerId ?? '', model: entry?.model ?? '' }
      }
      return init
    }
  )
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const update = (cat: string, field: 'providerId' | 'model', value: string) => {
    setDraft((d) => ({ ...d, [cat]: { ...d[cat], [field]: value } }))
  }

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const payload: Record<string, { providerId: string; model?: string }> = {}
      for (const [cat, entry] of Object.entries(draft)) {
        if (entry.providerId) {
          payload[cat] = entry.model.trim()
            ? { providerId: entry.providerId, model: entry.model.trim() }
            : { providerId: entry.providerId }
        }
      }
      await window.api.setFeatureRouting(payload)
      setMsg({ kind: 'ok', text: '已保存' })
      onSaved()
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        marginTop: 14,
        padding: 14,
        background: 'var(--surface-1, rgba(0,0,0,0.03))',
        borderRadius: 8
      }}
    >
      <h4 className="sub" style={{ fontSize: 14, margin: 0 }}>
        功能模型分配
      </h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        为不同任务分配不同 provider/模型（如正文用强模型、审稿用便宜模型）。留空「默认」的走当前
        provider；模型留空用 provider 自带。
      </p>
      <div>
        {FEATURE_CATEGORIES.map((cat) => {
          const entry = draft[cat.key]
          const selectedProvider = providers.find((p) => p.id === entry.providerId)
          return (
            <div
              key={cat.key}
              className="row"
              style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <div style={{ width: 130, flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{cat.label}</div>
                <div className="meta" style={{ fontSize: 11 }}>
                  {cat.hint}
                </div>
              </div>
              <select
                className="input"
                style={{ flex: 1, minWidth: 150 }}
                value={entry.providerId}
                onChange={(e) => update(cat.key, 'providerId', e.target.value)}
              >
                <option value="">默认（当前 provider）</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}（{p.protocol}）
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ flex: 1, minWidth: 150 }}
                value={entry.model}
                onChange={(e) => update(cat.key, 'model', e.target.value)}
                placeholder={
                  selectedProvider
                    ? `留空用 ${selectedProvider.model || 'provider 默认'}`
                    : '选 provider 后可覆盖模型'
                }
                disabled={!entry.providerId}
              />
            </div>
          )
        })}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn btn-sm" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存路由'}
        </button>
        {msg ? (
          <span
            style={{
              color: msg.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
              fontSize: 12
            }}
          >
            {msg.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}
