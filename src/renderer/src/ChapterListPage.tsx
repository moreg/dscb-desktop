import { useEffect, useState } from 'react'
import type { ChapterMeta } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenCharacters: () => void
  onOpenMemoryCenter: () => void
  onOpenOutline: () => void
}

export default function ChapterListPage({
  projectId,
  onBack,
  onOpenChapter,
  onOpenCharacters,
  onOpenMemoryCenter,
  onOpenOutline
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
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 项目
        </button>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={onOpenOutline}>
            📜 大纲
          </button>
          <button className="btn btn-sm" onClick={onOpenCharacters}>
            🧑 人物
          </button>
          <button className="btn btn-sm" onClick={onOpenMemoryCenter}>
            🧠 记忆
          </button>
          <button className="btn btn-primary btn-sm" onClick={createChapter}>
            + 新章
          </button>
        </div>
      </div>
      <h2 className="section mt">章节</h2>
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : chapters.length === 0 ? (
        <p className="empty">尚无章节，点「+ 新章」开篇。</p>
      ) : (
        <ul className="bare">
          {chapters.map((c) => (
            <li
              key={c.chapterNumber}
              className="card card-hover"
              onClick={() => onOpenChapter(c.chapterNumber)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <strong>
                第 {c.chapterNumber} 章 · {c.title}
              </strong>
              <span className="meta">
                {c.wordCount} 字 · {c.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
