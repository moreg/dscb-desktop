import { useEffect, useState } from 'react'
import type { ProjectMeta } from '../../shared/types'

export default function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void window.api.listProjects().then((list) => {
      setProjects(list)
      setLoading(false)
    })
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 01 脚手架 · 项目库（读取本地 library.json）</p>
      <h2>我的项目</h2>
      {loading ? (
        <p>加载中…</p>
      ) : projects.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无项目（首次启动，library.json 还没创建）</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>
              {p.genre ? <span style={{ color: '#64748b' }}> · {p.genre}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
