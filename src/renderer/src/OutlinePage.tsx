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
      <button onClick={onBack}>← 返回章节列表</button>
      <h2>大纲</h2>
      <h3>总纲</h3>
      {main ? (
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12, borderRadius: 8 }}>
          {main.synopsis}
        </pre>
      ) : (
        <p style={{ color: '#94a3b8' }}>暂无总纲。</p>
      )}
      <button onClick={genMain} disabled={loadingMain}>
        {loadingMain ? '生成中…' : main ? '重新生成总纲' : '✨ AI 生成总纲'}
      </button>

      <h3 style={{ marginTop: 24 }}>细纲</h3>
      {items.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>暂无细纲。先创建章节，再为每章生成细纲。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((it) => (
            <li
              key={it.chapterNumber}
              style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, margin: '8px 0' }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <strong>第 {it.chapterNumber} 章</strong>
                <button
                  onClick={() => genDetailed(it.chapterNumber)}
                  disabled={genChapter === it.chapterNumber}
                >
                  {genChapter === it.chapterNumber ? '生成中…' : '重新生成'}
                </button>
              </div>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  margin: '8px 0 0',
                  fontSize: 14,
                  color: '#334155'
                }}
              >
                {it.plotSummary}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
