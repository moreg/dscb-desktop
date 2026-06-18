import { useEffect, useState } from 'react'
import type { Character, Relationship } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

export default function RelationshipPage({ projectId, onBack }: Props) {
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    setLoading(true)
    void Promise.all([
      window.api.listRelationships(projectId),
      window.api.listCharacters(projectId)
    ]).then(([rels, chars]) => {
      setRelationships(rels)
      setCharacters(chars)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? '（已删除）'

  const remove = async (r: Relationship) => {
    if (!window.confirm('删除该关系？')) return
    await window.api.deleteRelationship(projectId, r.id)
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回记忆中心</button>
        <button onClick={() => setCreating(true)} disabled={characters.length < 2}>
          + 新建关系
        </button>
      </div>
      <h2>人物关系</h2>
      {characters.length < 2 ? (
        <p style={{ color: '#d97706' }}>至少需要 2 个人物才能建立关系。</p>
      ) : null}
      {loading ? (
        <p>加载中…</p>
      ) : relationships.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无关系。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {relationships.map((r) => (
            <li
              key={r.id}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <strong>
                {nameOf(r.characterAId)} ↔ {nameOf(r.characterBId)}
              </strong>
              <span style={{ color: '#64748b' }}> · {r.relationType}</span>
              {r.strength != null ? (
                <span style={{ color: '#94a3b8' }}> · 强度 {r.strength}</span>
              ) : null}
              {r.description ? (
                <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>{r.description}</div>
              ) : null}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => remove(r)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <Dialog
          characters={characters}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createRelationship(projectId, input)
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function Dialog({
  characters,
  onClose,
  onSubmit
}: {
  characters: Character[]
  onClose: () => void
  onSubmit: (input: {
    characterAId: string
    characterBId: string
    relationType: string
    description?: string
    strength?: number
  }) => Promise<void>
}) {
  const [a, setA] = useState(characters[0]?.id ?? '')
  const [b, setB] = useState(characters[1]?.id ?? '')
  const [relationType, setRelationType] = useState('')
  const [description, setDescription] = useState('')
  const [strength, setStrength] = useState('')
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
        <h3 style={{ marginTop: 0 }}>新建关系</h3>
        <p>
          人物A：
          <select value={a} onChange={(e) => setA(e.target.value)} style={{ width: '100%' }}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </p>
        <p>
          人物B：
          <select value={b} onChange={(e) => setB(e.target.value)} style={{ width: '100%' }}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </p>
        <p>
          关系类型：
          <input
            value={relationType}
            onChange={(e) => setRelationType(e.target.value)}
            placeholder="师徒/敌对/恋人/兄弟…"
            style={{ width: '100%' }}
          />
        </p>
        <p>
          描述：
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: '100%' }}
          />
        </p>
        <p>
          强度（0-100，可留空）：
          <input
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            style={{ width: '100%' }}
          />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>
            取消
          </button>
          <button
            disabled={saving || !a || !b || a === b || !relationType.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit({
                  characterAId: a,
                  characterBId: b,
                  relationType: relationType.trim(),
                  description: description.trim() || undefined,
                  strength: strength ? Number(strength) : undefined
                })
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
