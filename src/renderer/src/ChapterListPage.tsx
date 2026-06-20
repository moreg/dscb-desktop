import { useEffect, useMemo, useState } from 'react'
import type { ChapterMeta, Character, ChapterStatus } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenCharacters: () => void
  onOpenMemoryCenter: () => void
  onOpenOutline: () => void
}

const STATUS_FULL: Record<ChapterStatus, string> = {
  outline: '大纲',
  draft: '草稿',
  reviewed: '润色',
  published: '定稿'
}

const STATUS_CLASS: Record<ChapterStatus, string> = {
  outline: 'status-outline',
  draft: 'status-draft',
  reviewed: 'status-reviewed',
  published: 'status-published'
}

export default function ChapterListPage({
  projectId,
  onOpenChapter
}: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [filter, setFilter] = useState<'all' | ChapterStatus>('all')

  const refresh = () => {
    setLoading(true)
    void window.api.listChapters(projectId).then((list) => {
      setChapters(list)
      setLoading(false)
    })
  }
  const refreshCharacters = () => {
    void window.api.listCharacters(projectId).then(setCharacters)
  }

  useEffect(() => {
    refresh()
    refreshCharacters()
  }, [projectId])

  const charName = (id: string) => characters.find((c) => c.id === id)?.name ?? '?'

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: chapters.length }
    for (const c of chapters) m[c.status] = (m[c.status] ?? 0) + 1
    return m
  }, [chapters])

  const totalWords = useMemo(
    () => chapters.reduce((s, c) => s + (c.wordCount ?? 0), 0),
    [chapters]
  )

  const filtered = useMemo(
    () => chapters.filter((c) => filter === 'all' || c.status === filter),
    [chapters, filter]
  )

  /** 按卷分组（volume 来自节奏图谱；无卷信息的归入「未分卷」） */
  const volumeGroups = useMemo(() => {
    const map = new Map<number, ChapterMeta[]>()
    for (const c of filtered) {
      const v = c.volume ?? 0
      if (!map.has(v)) map.set(v, [])
      map.get(v)!.push(c)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [filtered])

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>章节</h1>
            <p className="desc">
              {chapters.length} 章 · {totalWords.toLocaleString()} 字
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 新章
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span
            className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部 · {counts.all ?? 0}
          </span>
          {(Object.keys(STATUS_FULL) as ChapterStatus[]).map((s) =>
            counts[s] ? (
              <span
                key={s}
                className={`filter-chip ${filter === s ? 'active' : ''}`}
                onClick={() => setFilter(s)}
                title={STATUS_FULL[s]}
              >
                {STATUS_FULL[s]} · {counts[s]}
              </span>
            ) : null
          )}
        </div>
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : chapters.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: '0 0 12px' }}>尚无章节，点「+ 新章」开篇。</p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
            + 新章
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="empty">该状态下暂无章节。</p>
      ) : (
        <div className="chapter-list">
          {volumeGroups.map(([vol, chs]) => (
            <div key={vol} className="volume-group">
              <div className="volume-head">
                {vol > 0
                  ? `第 ${vol} 卷（${chs[0].chapterNumber}-${chs[chs.length - 1].chapterNumber} 章）`
                  : '未分卷'}
                <span className="volume-count">{chs.length} 章</span>
              </div>
              {chs.map((c) => {
                const cast = (c.appearingCharacters ?? []).slice(0, 4)
                const extra = (c.appearingCharacters?.length ?? 0) - cast.length
                return (
                  <button
                    key={c.chapterNumber}
                    type="button"
                    className="chapter-row"
                    onClick={() => onOpenChapter(c.chapterNumber)}
                  >
                    <div className="ch-top">
                      <span className="ch-num">第 {c.chapterNumber} 章</span>
                      <span className="ch-title">{c.title}</span>
                      <span className={`chip ${STATUS_CLASS[c.status]}`}>
                        {STATUS_FULL[c.status]}
                      </span>
                    </div>
                    {c.synopsis ? <div className="ch-synopsis">{c.synopsis}</div> : null}
                    <div className="ch-foot">
                      <div className="ch-cast">
                        {cast.length > 0 ? (
                          <>
                            <span className="lbl">登场</span>
                            {cast.map((id) => (
                              <span key={id} className="outline-tag emotion">
                                {charName(id)}
                              </span>
                            ))}
                            {extra > 0 ? (
                              <span className="outline-tag">+{extra}</span>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      <div className="ch-meta">
                        {c.emotion ? <span className="words">情绪 {c.emotion}</span> : null}
                        <span className="words">{c.wordCount.toLocaleString()} 字</span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {showNew ? (
        <NewChapterDialog
          defaultTitle={`第 ${chapters.length + 1} 章`}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
          projectId={projectId}
        />
      ) : null}
    </div>
  )
}

function NewChapterDialog({
  projectId,
  defaultTitle,
  onClose,
  onCreated
}: {
  projectId: string
  defaultTitle: string
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState(defaultTitle)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await window.api.createChapter(projectId, { title: title.trim() })
      onCreated()
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建章节</h3>
        <div className="field">
          <label>标题</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            {saving ? '创建中…' : '落笔'}
          </button>
        </div>
      </div>
    </div>
  )
}
