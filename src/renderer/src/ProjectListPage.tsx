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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>我的项目</h2>
        <button onClick={() => setShowNew(true)}>+ 新建项目</button>
      </div>
      {loading ? (
        <p>加载中…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无项目，点击右上角新建。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {projects.map((p) => (
            <li
              key={p.id}
              style={{
                padding: '12px',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                margin: '8px 0',
                cursor: 'pointer'
              }}
              onClick={() => onOpenProject(p.id)}
            >
              <strong>{p.name}</strong>
              {p.genre ? <span style={{ color: '#64748b' }}> · {p.genre}</span> : null}
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
      <div style={{ background: '#fff', padding: 24, borderRadius: 12, width: 380 }}>
        <h3 style={{ marginTop: 0 }}>新建项目</h3>
        <p>
          名称：<input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        </p>
        <p>
          题材：
          <input
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="玄幻/都市/科幻…"
            style={{ width: '100%' }}
          />
        </p>
        <p>
          简介：
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ width: '100%' }}
          />
        </p>
        <div style={{ textAlign: 'right' }}>
          <button onClick={onClose} style={{ marginRight: 8 }}>
            取消
          </button>
          <button onClick={submit} disabled={saving || !name.trim()}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
