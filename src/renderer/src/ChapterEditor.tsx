import { useEffect, useRef, useState } from 'react'
import type { ChapterContent, ChapterVersion, ChapterSource } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
}

const SOURCE_LABEL: Record<ChapterSource, string> = {
  manual: '手写',
  ai: 'AI',
  reviewed: '润色'
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
  const genRef = useRef(0)

  const refreshVersions = () => {
    void window.api.listChapterVersions(projectId, chapterNumber).then(setVersions)
  }

  useEffect(() => {
    ++genRef.current
    setGenerating(false)
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
    const source = window.prompt('版本来源（manual / ai / reviewed）', 'manual') as
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
      window.alert('请先在「⚙ 设置」中配置 MiniMax API Key')
      return
    }
    setGenerating(true)
    setDraft('')
    const myGen = ++genRef.current
    try {
      const result = await window.api.generateChapterStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (genRef.current !== myGen) return
          if (token) setDraft((d) => d + token)
          if (done) setGenerating(false)
        }
      )
      if (genRef.current !== myGen) return
      if (!result.ok) {
        setGenerating(false)
        const msg =
          result.error === 'LLM_AUTH_FAILED'
            ? '认证失败，请检查 API Key'
            : result.error === 'LLM_RATE_LIMIT'
              ? '请求过于频繁，请稍后再试'
              : '生成失败，请重试'
        window.alert(msg)
        return
      }
      setDirty(true)
    } catch {
      if (genRef.current === myGen) setGenerating(false)
    }
  }

  const rollback = async (v: ChapterVersion) => {
    if (!window.confirm(`回滚到版本 ${v.versionNumber}（${SOURCE_LABEL[v.source]}）？当前正文将被覆盖。`))
      return
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

  if (!data) return <p className="empty">展卷中…</p>

  return (
    <div>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="meta">
          第 {data.meta.chapterNumber} 章 · {data.meta.title} · {data.meta.wordCount} 字 ·{' '}
          {versions.length} 版
        </span>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={save} disabled={!dirty || saving}>
            {saving ? '保存中…' : dirty ? '保存 ·' : '已存'}
          </button>
          <button className="btn btn-sm" onClick={saveAsVersion} disabled={savingVersion}>
            存版本
          </button>
          <button className="btn btn-sm" onClick={() => setShowVersions((s) => !s)}>
            {showVersions ? '收起' : '版本'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={aiGenerate} disabled={generating}>
            {generating ? '落墨中…' : '✦ 续写'}
          </button>
        </div>
      </div>
      <textarea
        className="editor-text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        placeholder="此处落笔，或点「续写」让 AI 接续成文……"
        style={{ marginTop: 16 }}
      />

      {showVersions ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="sub">版本历史（{versions.length}）</h3>
          {versions.length === 0 ? (
            <p className="empty">尚无版本，点「存版本」留存。</p>
          ) : (
            <ul className="bare">
              {[...versions].reverse().map((v) => (
                <li
                  key={v.versionNumber}
                  className="row"
                  style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}
                >
                  <div>
                    <strong>#{v.versionNumber}</strong>{' '}
                    <span className={`chip chip-${sourceChip(v.source)}`}>
                      {SOURCE_LABEL[v.source]}
                    </span>{' '}
                    <span className="meta">
                      {v.wordCount} 字 · {v.createdAt.replace('T', ' ').slice(0, 16)}
                    </span>
                    {v.note ? <div className="muted">{v.note}</div> : null}
                  </div>
                  <div className="btn-group">
                    <button className="btn btn-sm" onClick={() => setViewing(v)}>
                      看
                    </button>
                    <button className="btn btn-sm" onClick={() => rollback(v)}>
                      回滚
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => removeVersion(v)}>
                      删
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {viewing ? (
        <div className="dialog-overlay" onClick={() => setViewing(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              版本 #{viewing.versionNumber} · {SOURCE_LABEL[viewing.source]} · {viewing.wordCount} 字
            </h3>
            <pre className="body">{viewing.content}</pre>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setViewing(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => rollback(viewing)}>
                回滚到此版
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function sourceChip(s: ChapterSource): string {
  if (s === 'ai') return 'accent'
  if (s === 'reviewed') return 'success'
  return ''
}
