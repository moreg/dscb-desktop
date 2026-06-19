import { useEffect, useState } from 'react'
import type { Character, CreateCharacterInput } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

const EMPTY: CreateCharacterInput = { name: '', role: '', identity: '', personality: '' }

export default function CharacterManagerPage({ projectId, onBack }: Props) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateCharacterInput } | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listCharacters(projectId).then((list) => {
      setCharacters(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const startEdit = (c: Character) =>
    setEditing({
      id: c.id,
      input: {
        name: c.name,
        role: c.role ?? '',
        identity: c.identity ?? '',
        personality: c.personality ?? ''
      }
    })

  const remove = async (c: Character) => {
    if (!window.confirm(`删除「${c.name}」？`)) return
    await window.api.deleteCharacter(projectId, c.id)
    refresh()
  }

  return (
    <div>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 记忆中心
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          + 新人物
        </button>
      </div>
      <h2 className="section mt">人物</h2>
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : characters.length === 0 ? (
        <p className="empty">尚无人物。</p>
      ) : (
        <ul className="bare">
          {characters.map((c) => (
            <li key={c.id} className="card">
              <strong style={{ fontSize: 16 }}>{c.name}</strong>
              {c.role ? <span className="chip chip-accent" style={{ marginLeft: 8 }}>{c.role}</span> : null}
              {c.identity ? <div className="muted" style={{ marginTop: 6 }}>{c.identity}</div> : null}
              {c.personality ? (
                <div className="muted">性格：{c.personality}</div>
              ) : null}
              <div className="btn-group" style={{ marginTop: 10 }}>
                <button className="btn btn-sm" onClick={() => startEdit(c)}>
                  编辑
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <CharacterDialog
          title="新建人物"
          initial={EMPTY}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createCharacter(projectId, trimInput(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <CharacterDialog
          title="编辑人物"
          initial={editing.input}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateCharacter(projectId, editing.id, trimInput(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trimInput(input: CreateCharacterInput): CreateCharacterInput {
  return {
    name: input.name.trim(),
    role: input.role?.trim() || undefined,
    identity: input.identity?.trim() || undefined,
    personality: input.personality?.trim() || undefined
  }
}

function CharacterDialog({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateCharacterInput
  onClose: () => void
  onSubmit: (input: CreateCharacterInput) => Promise<void>
}) {
  const [input, setInput] = useState<CreateCharacterInput>(initial)
  const [saving, setSaving] = useState(false)
  const f = (key: keyof CreateCharacterInput) => ({
    value: (input[key] as string) ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setInput({ ...input, [key]: e.target.value })
  })
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="field">
          <label>名称</label>
          <input className="input" {...f('name')} />
        </div>
        <div className="field">
          <label>角色</label>
          <input className="input" {...f('role')} placeholder="主角 / 配角 / 反派" />
        </div>
        <div className="field">
          <label>身份</label>
          <input className="input" {...f('identity')} />
        </div>
        <div className="field">
          <label>性格</label>
          <input className="input" {...f('personality')} />
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
