import { useEffect, useState } from 'react'
import type { ChapterContent, ChapterVersion, ChapterSource } from '../../shared/types'

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
  const [versions, setVersions] = useState<ChapterVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [viewing, setViewing] = useState<ChapterVersion | null>(null)
  const [generating, setGenerating] = useState(false)

  const refreshVersions = () => {
    void window.api.listChapterVersions(projectId, chapterNumber).then(setVersions)
  }

  useEffect(() => {
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
    })
    refreshVersions()
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

  const saveAsVersion = async () => {
    const source = window.prompt('版本来源（输入：manual / ai / reviewed）', 'manual') as
      | ChapterSource
      | null
    if (!source) return
    const note = window.prompt('备注（可留空）', '') ?? ''
    setSavingVersion(true)
    try {
      await window.api.createChapterVersion(projectId, chapterNumber, {
        source,
        content: draft,
        note: note.trim() || undefined
      })
      refreshVersions()
    } finally {
      setSavingVersion(false)
    }
  }

  const aiGenerate = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙️ 设置」中配置 MiniMax API Key')
      return
    }
    setGenerating(true)
    setDraft('')
    try {
      await window.api.generateChapterStream(projectId, chapterNumber, (token, done) => {
        if (token) setDraft((d) => d + token)
        if (done) setGenerating(false)
      })
      setDirty(true)
    } catch {
      setGenerating(false)
    }
  }

  const rollback = async (v: ChapterVersion) => {
    if (!window.confirm(`回滚到版本 ${v.versionNumber}（${v.source}）？当前正文将被覆盖。`)) return
    const meta = await window.api.rollbackChapter(projectId, chapterNumber, v.versionNumber)
    setDraft(v.content)
    setData({ meta, content: v.content })
    setDirty(false)
    setViewing(null)
  }

  const removeVersion = async (v: ChapterVersion) => {
    if (!window.confirm(`删除版本 ${v.versionNumber}？`)) return
    await window.api.deleteChapterVersion(projectId, chapterNumber, v.versionNumber)
    refreshVersions()
  }

  if (!data) return <p>加载中…</p>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <button onClick={onBack}>← 返回章节列表</button>
        <span style={{ color: '#94a3b8' }}>
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字 ·{' '}
          {versions.length} 个版本
        </span>
        <div>
          <button onClick={save} disabled={!dirty || saving}>
            {saving ? '保存中…' : dirty ? '保存 *' : '已保存'}
          </button>
          <button onClick={saveAsVersion} disabled={savingVersion} style={{ marginLeft: 8 }}>
            存为版本
          </button>
          <button onClick={() => setShowVersions((s) => !s)} style={{ marginLeft: 8 }}>
            {showVersions ? '收起历史' : '版本历史'}
          </button>
          <button onClick={aiGenerate} disabled={generating} style={{ marginLeft: 8 }}>
            {generating ? '生成中…' : '✨ AI 生成'}
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        style={{
          width: '100%',
          height: '50vh',
          marginTop: 12,
          fontFamily: 'inherit',
          fontSize: 15,
          padding: 12
        }}
        placeholder="在此输入正文，或点「✨ AI 生成」…"
      />

      {showVersions ? (
        <div style={{ marginTop: 16, border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>版本历史（{versions.length}）</h3>
          {versions.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>暂无版本，点「存为版本」创建。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {[...versions].reverse().map((v) => (
                <li
                  key={v.versionNumber}
                  style={{
                    padding: 10,
                    borderBottom: '1px solid #f1f5f9',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  <div>
                    <strong>#{v.versionNumber}</strong>{' '}
                    <span style={{ color: sourceColor(v.source) }}>{v.source}</span>{' '}
                    <span style={{ color: '#94a3b8' }}>
                      {v.wordCount} 字 · {v.createdAt.replace('T', ' ').slice(0, 19)}
                    </span>
                    {v.note ? (
                      <div style={{ color: '#64748b', fontSize: 13 }}>{v.note}</div>
                    ) : null}
                  </div>
                  <div>
                    <button onClick={() => setViewing(v)}>查看</button>
                    <button onClick={() => rollback(v)} style={{ marginLeft: 6 }}>
                      回滚
                    </button>
                    <button onClick={() => removeVersion(v)} style={{ marginLeft: 6 }}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {viewing ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10
          }}
          onClick={() => setViewing(null)}
        >
          <div
            style={{
              background: '#fff',
              padding: 20,
              borderRadius: 12,
              width: 640,
              maxHeight: '80vh',
              overflow: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              版本 #{viewing.versionNumber} · {viewing.source} · {viewing.wordCount} 字
            </h3>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, color: '#334155' }}>
              {viewing.content}
            </pre>
            <div style={{ textAlign: 'right', marginTop: 12 }}>
              <button onClick={() => setViewing(null)} style={{ marginRight: 8 }}>
                关闭
              </button>
              <button onClick={() => rollback(viewing)}>回滚到此版本</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function sourceColor(source: ChapterSource): string {
  if (source === 'ai') return '#7c3aed'
  if (source === 'reviewed') return '#059669'
  return '#475569'
}
