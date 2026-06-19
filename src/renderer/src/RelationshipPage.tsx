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
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 记忆中心
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)} disabled={characters.length < 2}>
          + 新关系
        </button>
      </div>
      <h2 className="section mt">人物关系</h2>
      {characters.length < 2 ? (
        <p className="empty" style={{ color: 'var(--warning)' }}>
          至少需要 2 个人物才能建立关系。
        </p>
      ) : null}
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : relationships.length === 0 ? (
        <p className="empty">尚无关系。</p>
      ) : (
        <ul className="bare">
          {relationships.map((r) => (
            <li key={r.id} className="card">
              <strong>
                {nameOf(r.characterAId)} ⇄ {nameOf(r.characterBId)}
              </strong>
              <span className="chip chip-accent" style={{ marginLeft: 8 }}>{r.relationType}</span>
              {r.strength != null ? (
                <span className="chip" style={{ marginLeft: 6 }}>强度 {r.strength}</span>
              ) : null}
              {r.description ? <pre className="body">{r.description}</pre> : null}
              <div className="btn-group" style={{ marginTop: 10 }}>
                <button className="btn btn-sm btn-danger" onClick={() => remove(r)}>
                  删除
                </button>
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
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建关系</h3>
        <div className="field">
          <label>人物甲</label>
          <select className="select" value={a} onChange={(e) => setA(e.target.value)}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>人物乙</label>
          <select className="select" value={b} onChange={(e) => setB(e.target.value)}>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>关系类型</label>
          <input
            className="input"
            value={relationType}
            onChange={(e) => setRelationType(e.target.value)}
            placeholder="师徒 / 敌对 / 恋人 / 兄弟…"
          />
        </div>
        <div className="field">
          <label>描述</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label>强度（0-100，可留空）</label>
          <input className="input" value={strength} onChange={(e) => setStrength(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
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
