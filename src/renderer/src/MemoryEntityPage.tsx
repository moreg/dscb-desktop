import { useEffect, useState } from 'react'
import type { MemoryEntity, MemoryEntityType, CreateMemoryEntityInput } from '../../shared/types'

interface Props {
  projectId: string
  type: MemoryEntityType
  label: string
  onBack: () => void
}

const EMPTY: CreateMemoryEntityInput = { name: '', category: '', notes: '' }

export default function MemoryEntityPage({ projectId, type, label, onBack }: Props) {
  const [items, setItems] = useState<MemoryEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateMemoryEntityInput } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listMemoryEntities(projectId, type).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId, type])

  const remove = async (e: MemoryEntity) => {
    if (!window.confirm(`删除「${e.name}」？`)) return
    await window.api.deleteMemoryEntity(projectId, type, e.id)
    refresh()
  }

  return (
    <div>
      <button onClick={onBack}>← 返回记忆中心</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{label}</h2>
        <button onClick={() => setCreating(true)}>+ 新建</button>
      </div>
      {loading ? (
        <p>加载中…</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无{label}。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((e) => (
            <li
              key={e.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>{e.name}</strong>
              {e.category ? <span style={{ color: '#64748b' }}> · {e.category}</span> : null}
              {e.notes ? (
                <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>{e.notes}</div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() =>
                    setEditing({
                      id: e.id,
                      input: { name: e.name, category: e.category ?? '', notes: e.notes ?? '' }
                    })
                  }
                  style={{ marginRight: 8 }}
                >
                  编辑
                </button>
                <button onClick={() => remove(e)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <EntityDialog
          title={`新建${label}`}
          initial={EMPTY}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createMemoryEntity(projectId, type, trim(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <EntityDialog
          title={`编辑${label}`}
          initial={editing.input}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateMemoryEntity(projectId, type, editing.id, trim(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trim(input: CreateMemoryEntityInput): CreateMemoryEntityInput {
  return {
    name: input.name.trim(),
    category: input.category?.trim() || undefined,
    notes: input.notes?.trim() || undefined
  }
}

function EntityDialog({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateMemoryEntityInput
  onClose: () => void
  onSubmit: (input: CreateMemoryEntityInput) => Promise<void>
}) {
  const [input, setInput] = useState<CreateMemoryEntityInput>(initial)
  const [saving, setSaving] = useState(false)
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div style={{ background: '#fff', padding: 24, borderRadius: 12, width: 420 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p>
          名称：
          <input
            value={input.name}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
            style={{ width: '100%' }}
          />
        </p>
        <p>
          分类：
          <input
            value={input.category}
            onChange={(e) => setInput({ ...input, category: e.target.value })}
            style={{ width: '100%' }}
          />
        </p>
        <p>
          详情：
          <textarea
            value={input.notes}
            onChange={(e) => setInput({ ...input, notes: e.target.value })}
            rows={4}
            style={{ width: '100%' }}
          />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>
            取消
          </button>
          <button
            disabled={saving || !input.name.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit(input)
              } finally {
                setSaving(false)
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
