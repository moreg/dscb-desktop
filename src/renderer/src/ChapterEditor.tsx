import { useEffect, useState } from 'react'
import type { ChapterContent } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
}

export default function ChapterEditor({ projectId, chapterNumber, onBack }: Props) {
  const [data, setData] = useState<ChapterContent | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
    })
  }, [projectId, chapterNumber])

  const save = async () => {
    setSaving(true)
    try {
      const meta = await window.api.updateChapterContent(projectId, chapterNumber, draft)
      setData({ meta, content: draft })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  if (!data) return <p>加载中…</p>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <span style={{ color: '#94a3b8' }}>
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字
        </span>
        <button onClick={save} disabled={!dirty || saving}>
          {saving ? '保存中…' : dirty ? '保存 *' : '已保存'}
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        style={{
          width: '100%',
          height: '60vh',
          marginTop: 12,
          fontFamily: 'inherit',
          fontSize: 15,
          padding: 12
        }}
        placeholder="在此输入正文……"
      />
    </div>
  )
}
