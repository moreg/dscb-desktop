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
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 记忆中心
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          + 新建
        </button>
      </div>
      <h2 className="section mt">{label}</h2>
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : items.length === 0 ? (
        <p className="empty">尚无{label}。</p>
      ) : (
        <ul className="bare">
          {items.map((e) => (
            <li key={e.id} className="card">
              <strong>{e.name}</strong>
              {e.category ? <span className="chip" style={{ marginLeft: 8 }}>{e.category}</span> : null}
              {e.notes ? <pre className="body">{e.notes}</pre> : null}
              <div className="btn-group" style={{ marginTop: 10 }}>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setEditing({
                      id: e.id,
                      input: { name: e.name, category: e.category ?? '', notes: e.notes ?? '' }
                    })
                  }
                >
                  编辑
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(e)}>
                  删除
                </button>
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
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="field">
          <label>名称</label>
          <input className="input" value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} />
        </div>
        <div className="field">
          <label>分类</label>
          <input className="input" value={input.category} onChange={(e) => setInput({ ...input, category: e.target.value })} />
        </div>
        <div className="field">
          <label>详情</label>
          <textarea className="textarea" value={input.notes} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={4} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
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
