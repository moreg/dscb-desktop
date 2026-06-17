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
    if (!window.confirm(`删除人物「${c.name}」？`)) return
    await window.api.deleteCharacter(projectId, c.id)
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <button onClick={() => setCreating(true)}>+ 新建人物</button>
      </div>
      <h2>人物管理</h2>
      {loading ? (
        <p>加载中…</p>
      ) : characters.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无人物。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {characters.map((c) => (
            <li
              key={c.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>{c.name}</strong>
              {c.role ? <span style={{ color: '#64748b' }}> · {c.role}</span> : null}
              {c.identity ? <div style={{ color: '#475569', fontSize: 14 }}>{c.identity}</div> : null}
              {c.personality ? (
                <div style={{ color: '#64748b', fontSize: 14 }}>性格：{c.personality}</div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => startEdit(c)} style={{ marginRight: 8 }}>
                  编辑
                </button>
                <button onClick={() => remove(c)}>删除</button>
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
  const field = (key: keyof CreateCharacterInput) => ({
    value: (input[key] as string) ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setInput({ ...input, [key]: e.target.value })
  })
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
          名称：<input {...field('name')} style={{ width: '100%' }} />
        </p>
        <p>
          角色：
          <input {...field('role')} placeholder="主角/配角/反派" style={{ width: '100%' }} />
        </p>
        <p>
          身份：<input {...field('identity')} style={{ width: '100%' }} />
        </p>
        <p>
          性格：<input {...field('personality')} style={{ width: '100%' }} />
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
