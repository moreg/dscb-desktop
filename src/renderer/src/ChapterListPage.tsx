import { useEffect, useState } from 'react'
import type { ChapterMeta } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenCharacters: () => void
  onOpenMemoryCenter: () => void
}

export default function ChapterListPage({
  projectId,
  onBack,
  onOpenChapter,
  onOpenCharacters,
  onOpenMemoryCenter
}: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    void window.api.listChapters(projectId).then((list) => {
      setChapters(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const createChapter = async () => {
    const title = window.prompt('章节标题', `第 ${chapters.length + 1} 章`)
    if (!title) return
    await window.api.createChapter(projectId, { title })
    refresh()
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回项目列表</button>
        <div>
          <button onClick={onOpenCharacters} style={{ marginRight: 8 }}>
            📝 人物
          </button>
          <button onClick={onOpenMemoryCenter} style={{ marginRight: 8 }}>
            🧠 记忆中心
          </button>
          <button onClick={createChapter}>+ 新建章节</button>
        </div>
      </div>
      <h2>章节列表</h2>
      {loading ? (
        <p>加载中…</p>
      ) : chapters.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无章节，点击右上角新建。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {chapters.map((c) => (
            <li
              key={c.chapterNumber}
              style={{
                padding: '10px',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                margin: '6px 0',
                cursor: 'pointer'
              }}
              onClick={() => onOpenChapter(c.chapterNumber)}
            >
              <strong>
                第 {c.chapterNumber} 章 · {c.title}
              </strong>
              <span style={{ color: '#94a3b8', marginLeft: 12 }}>
                {c.wordCount} 字 · {c.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
