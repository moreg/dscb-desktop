import { useEffect, useState } from 'react'
import type { ProjectMeta } from '../../shared/types'

interface Props {
  onOpenProject: (projectId: string) => void
}

export default function ProjectListPage({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const refresh = () => {
    setLoading(true)
    void window.api.listProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [])

  return (
    <div>
      <div className="row">
        <h2 className="section">我的书案</h2>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 新建项目
        </button>
      </div>
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : projects.length === 0 ? (
        <p className="empty">书案空空，点右上角落笔写下第一部吧。</p>
      ) : (
        <ul className="bare">
          {projects.map((p) => (
            <li
              key={p.id}
              className="card card-hover"
              onClick={() => onOpenProject(p.id)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <strong style={{ fontSize: 16 }}>{p.name}</strong>
                {p.genre ? <span className="chip chip-accent" style={{ marginLeft: 10 }}>{p.genre}</span> : null}
              </div>
              <span className="muted">翻开 ›</span>
            </li>
          ))}
        </ul>
      )}
      {showNew ? (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [genre, setGenre] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await window.api.createProject({
        name: name.trim(),
        genre: genre.trim() || undefined,
        description: description.trim() || undefined
      })
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建项目</h3>
        <div className="field">
          <label>名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>题材</label>
          <input
            className="input"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="玄幻 / 都市 / 科幻…"
          />
        </div>
        <div className="field">
          <label>简介</label>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving || !name.trim()}>
            {saving ? '创建中…' : '落笔'}
          </button>
        </div>
      </div>
    </div>
  )
}
