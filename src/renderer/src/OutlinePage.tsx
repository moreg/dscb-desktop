import { useEffect, useState } from 'react'
import type { MainOutline, DetailedOutlineItem } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

export default function OutlinePage({ projectId, onBack }: Props) {
  const [main, setMain] = useState<MainOutline | null>(null)
  const [items, setItems] = useState<DetailedOutlineItem[]>([])
  const [loadingMain, setLoadingMain] = useState(false)
  const [genChapter, setGenChapter] = useState<number | null>(null)

  const refresh = () => {
    void window.api.getMainOutline(projectId).then(setMain)
    void window.api.listDetailedOutline(projectId).then(setItems)
  }

  useEffect(refresh, [projectId])

  const genMain = async () => {
    setLoadingMain(true)
    try {
      setMain(await window.api.generateMainOutline(projectId))
    } finally {
      setLoadingMain(false)
    }
  }

  const genDetailed = async (n: number) => {
    setGenChapter(n)
    try {
      await window.api.generateDetailedOutline(projectId, n)
      setItems(await window.api.listDetailedOutline(projectId))
    } finally {
      setGenChapter(null)
    }
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        ‹ 章节
      </button>
      <h2 className="section mt">大纲</h2>

      <h3 className="sub">总纲</h3>
      {main ? (
        <pre className="body card">{main.synopsis}</pre>
      ) : (
        <p className="empty">尚无总纲。</p>
      )}
      <button className="btn btn-primary btn-sm" onClick={genMain} disabled={loadingMain} style={{ marginTop: 10 }}>
        {loadingMain ? '运笔中…' : main ? '重新生成总纲' : '✦ AI 生成总纲'}
      </button>

      <h3 className="sub" style={{ marginTop: 28 }}>细纲</h3>
      {items.length === 0 ? (
        <p className="empty">尚无细纲。先建章节，再为每章生成细纲。</p>
      ) : (
        <ul className="bare">
          {items.map((it) => (
            <li key={it.chapterNumber} className="card">
              <div className="row">
                <strong>第 {it.chapterNumber} 章</strong>
                <button
                  className="btn btn-sm"
                  onClick={() => genDetailed(it.chapterNumber)}
                  disabled={genChapter === it.chapterNumber}
                >
                  {genChapter === it.chapterNumber ? '运笔中…' : '重新生成'}
                </button>
              </div>
              <pre className="body">{it.plotSummary}</pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
