import { useEffect, useState } from 'react'
import type {
  FeatureCategory,
  FeatureRoutingEntry,
  ProviderSummary
} from '../../shared/types'

const FEATURE_CATEGORIES: { key: FeatureCategory; label: string; hint: string }[] = [
  { key: 'chapter', label: '正文生成', hint: '续写 / 追问改写' },
  { key: 'ask', label: '正文追问', hint: '💬 追问 / 全书视野只答不改' },
  { key: 'review', label: '审稿质检', hint: '审稿 / 细纲对照 / 节奏评估' },
  { key: 'humanize', label: '去AI味改写', hint: '去AI味 / 改写' },
  {
    key: 'auxiliary',
    label: '辅助提取',
    hint: '记忆提取 / 写后自动同步 / 图解 / 结尾状态 / 拆书'
  }
]

function draftFromRouting(
  routing?: Partial<Record<FeatureCategory, FeatureRoutingEntry>>
): Record<string, { providerId: string; model: string }> {
  const init: Record<string, { providerId: string; model: string }> = {}
  for (const cat of FEATURE_CATEGORIES) {
    const entry = routing?.[cat.key]
    init[cat.key] = { providerId: entry?.providerId ?? '', model: entry?.model ?? '' }
  }
  return init
}

/**
 * 功能模型分配表单：为每个功能大类选择 provider 与可选模型覆盖。
 * 外部 routing 变化时用 effect 同步草稿（不再靠 key 重挂载，避免保存成功提示被立刻清掉）。
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
  const [draft, setDraft] = useState(() => draftFromRouting(routing))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 父组件 refresh 后 routing 更新 → 同步草稿；不整表 remount，成功提示能留下来
  useEffect(() => {
    setDraft(draftFromRouting(routing))
  }, [routing])

  // 成功提示几秒后自动消失
  useEffect(() => {
    if (!msg || msg.kind !== 'ok') return
    const t = setTimeout(() => setMsg(null), 2500)
    return () => clearTimeout(t)
  }, [msg])

  const update = (cat: string, field: 'providerId' | 'model', value: string) => {
    setDraft((d) => ({ ...d, [cat]: { ...d[cat], [field]: value } }))
    // 改动后清掉旧的成功提示，避免「已改未存」仍显示已保存
    setMsg((m) => (m?.kind === 'ok' ? null : m))
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
      // 先出提示，再让父组件刷新；不再 key 重挂载，msg 会保留
      setMsg({ kind: 'ok', text: '路由已保存' })
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
        background: 'var(--surface-2)',
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
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="btn btn-sm" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存路由'}
        </button>
        {msg ? (
          <span
            role="status"
            style={{
              color: msg.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
              fontSize: 13,
              fontWeight: msg.kind === 'ok' ? 600 : 400
            }}
          >
            {msg.kind === 'ok' ? `✓ ${msg.text}` : msg.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}
