import { useEffect, useMemo, useState } from 'react'
import type { ProjectMeta, ChapterMeta } from '../../shared/types'
import { isProjectArchived } from '../../shared/types'
import NewProjectDialog from './NewProjectDialog'
import './long-story-project.css'

interface Props {
  onOpenProject: (projectId: string) => void
  onOpenProjectWindow: (projectId: string) => void
  onOpenBrainstorm: () => void
}

type Shelf = 'active' | 'archived'

export default function ProjectListPage({ onOpenProject, onOpenProjectWindow, onOpenBrainstorm }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [chapterCounts, setChapterCounts] = useState<Record<string, number>>({})
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [creationNotice, setCreationNotice] = useState('')
  const [keyword, setKeyword] = useState('')
  const [shelf, setShelf] = useState<Shelf>('active')
  const [pendingArchive, setPendingArchive] = useState<ProjectMeta | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')

  const loadProjects = async (withSpinner: boolean) => {
    if (withSpinner) setLoading(true)
    try {
      const list = await window.api.listProjects({ includeArchived: true })
      setProjects(list)
      const cc: Record<string, number> = {}
      const wc: Record<string, number> = {}
      await Promise.all(
        list.map(async (p) => {
          const chapters = (await window.api.listChapters(p.id)) as ChapterMeta[]
          cc[p.id] = chapters.length
          wc[p.id] = chapters.reduce((sum, c) => sum + (c.wordCount ?? 0), 0)
        })
      )
      setChapterCounts(cc)
      setWordCounts(wc)
    } finally {
      setLoading(false)
    }
  }

  /** 扫描 projectsRoot，发现含 project.json 或 大纲/大纲.md 的项目 */
  const scan = async () => {
    setScanning(true)
    try {
      await window.api.scanProjects()
      await loadProjects(true)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void loadProjects(true)
  }, [])

  const activeProjects = useMemo(
    () => projects.filter((p) => !isProjectArchived(p)),
    [projects]
  )
  const archivedProjects = useMemo(
    () => projects.filter((p) => isProjectArchived(p)),
    [projects]
  )
  const shelfProjects = shelf === 'archived' ? archivedProjects : activeProjects

  const filtered = useMemo(() => {
    if (!keyword) return shelfProjects
    const k = keyword.toLowerCase()
    return shelfProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(k) ||
        (p.genre ?? '').toLowerCase().includes(k) ||
        (p.description ?? '').toLowerCase().includes(k)
    )
  }, [shelfProjects, keyword])

  const totalWords = useMemo(
    () => shelfProjects.reduce((s, p) => s + (wordCounts[p.id] ?? 0), 0),
    [shelfProjects, wordCounts]
  )

  const applyArchived = async (project: ProjectMeta, archived: boolean) => {
    const setArchived = (
      window.api as { setProjectArchived?: (projectId: string, archived: boolean) => Promise<ProjectMeta> }
    ).setProjectArchived
    if (typeof setArchived !== 'function') {
      setArchiveError('当前窗口还是旧版主进程，请重启应用后再归档。项目文件不会被删除。')
      return
    }
    setArchiveBusy(true)
    setArchiveError('')
    try {
      await setArchived(project.id, archived)
      setPendingArchive(null)
      await loadProjects(false)
    } catch (err) {
      setArchiveError((err as Error).message || (archived ? '归档失败' : '移回失败'))
    } finally {
      setArchiveBusy(false)
    }
  }

  const formatRelative = (iso: string) => {
    if (!iso) return '—'
    const t = new Date(iso).getTime()
    const now = Date.now()
    const diff = Math.floor((now - t) / 1000)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
    return new Date(iso).toLocaleDateString('zh-CN')
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>我的书案</h1>
            <p className="desc">
              {shelf === 'archived'
                ? '归档的书不在书案展示，文件仍保留，可随时移回'
                : '静待落笔处，万卷由此生'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-ghost"
              onClick={scan}
              disabled={scanning}
              title="扫描保存位置，发现含 project.json 或 大纲/大纲.md 的项目"
            >
              {scanning ? '扫描中…' : '↻ 扫描项目'}
            </button>
            <button className="btn" onClick={onOpenBrainstorm}>
              长篇脑洞
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>
              + 落笔开篇
            </button>
          </div>
        </div>
      </div>

      {creationNotice ? <p className="meta" role="status">{creationNotice}</p> : null}

      <div className="toolbar">
        <div className="filters">
          <button
            type="button"
            className={`filter-chip ${shelf === 'active' ? 'active' : ''}`}
            aria-pressed={shelf === 'active'}
            onClick={() => setShelf('active')}
          >
            在写 {activeProjects.length}
          </button>
          <button
            type="button"
            className={`filter-chip ${shelf === 'archived' ? 'active' : ''}`}
            aria-pressed={shelf === 'archived'}
            onClick={() => setShelf('archived')}
          >
            归档 {archivedProjects.length}
          </button>
          <span className="filter-chip filter-chip-static">
            总字数 {(totalWords / 10000).toFixed(1)} 万
          </span>
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="搜索项目 / 题材…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {archiveError && !pendingArchive ? (
        <p className="meta" style={{ color: 'var(--danger)', margin: '0 0 12px' }}>
          {archiveError}
        </p>
      ) : null}

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : projects.length === 0 ? (
        <div className="placeholder" style={{ marginTop: 24 }}>
          <p style={{ margin: '0 0 16px', fontSize: 15 }}>书案空空，落笔写下第一部吧。</p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 落笔开篇
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="empty">
          {keyword
            ? '没有匹配的项目。'
            : shelf === 'archived'
              ? '还没有归档的书。'
              : archivedProjects.length > 0
                ? '书案上没有在写的书。已归档的可在上方「归档」里找回。'
                : '没有匹配的项目。'}
        </p>
      ) : (
        <div className="project-grid">
          {filtered.map((p) => {
            const ch = chapterCounts[p.id] ?? 0
            const wc = wordCounts[p.id] ?? 0
            const initial = p.name.trim().charAt(0) || '卷'
            return (
              <article
                key={p.id}
                className="project-card"
                onClick={() => onOpenProject(p.id)}
              >
                <div className="pc-head">
                  <div className="pc-avatar" aria-hidden>{initial}</div>
                  <div className="pc-title">
                    <div className="pc-name">{p.name}</div>
                    {p.genre ? <div className="pc-genre">{p.genre}</div> : null}
                  </div>
                </div>
                {p.description ? <div className="pc-desc">{p.description}</div> : null}
                <div className="pc-stats">
                  <div className="pc-stat">
                    <span className="num">{ch}</span>
                    <span className="lbl">章节</span>
                  </div>
                  <div className="pc-stat">
                    <span className="num">{(wc / 10000).toFixed(1)}</span>
                    <span className="lbl">万字</span>
                  </div>
                </div>
                <div className="pc-foot">
                  <span>翻开 {formatRelative(p.lastOpenedAt)}</span>
                  <div className="pc-actions">
                    {isProjectArchived(p) ? (
                      <button
                        type="button"
                        className="archive-action restore"
                        title="移回书案"
                        disabled={archiveBusy}
                        onClick={(event) => {
                          event.stopPropagation()
                          void applyArchived(p, false)
                        }}
                      >
                        移回书案
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="archive-action"
                        title="归档后不在书案展示，文件仍保留"
                        disabled={archiveBusy}
                        onClick={(event) => {
                          event.stopPropagation()
                          setArchiveError('')
                          setPendingArchive(p)
                        }}
                      >
                        归档
                      </button>
                    )}
                    <button
                      type="button"
                      className="open project-entry"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenProject(p.id)
                      }}
                    >
                      进入 →
                    </button>
                    <button
                      type="button"
                      className="open-window"
                      title="在新窗口中打开，便于同时写多本书"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenProjectWindow(p.id)
                      }}
                    >
                      新窗口 ↗
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {pendingArchive ? (
        <ArchiveConfirmDialog
          project={pendingArchive}
          busy={archiveBusy}
          error={archiveError}
          onClose={() => {
            if (archiveBusy) return
            setPendingArchive(null)
            setArchiveError('')
          }}
          onConfirm={() => void applyArchived(pendingArchive, true)}
        />
      ) : null}
      {showNew ? (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={(_project, notice) => {
            setCreationNotice(notice)
            setShowNew(false)
            setShelf('active')
            void loadProjects(false)
          }}
        />
      ) : null}
    </div>
  )
}

function ArchiveConfirmDialog({
  project,
  busy,
  error,
  onClose,
  onConfirm
}: {
  project: ProjectMeta
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="dialog-overlay"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div className="dialog" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>归档《{project.name}》？</h3>
        <p style={{ margin: '0 0 18px', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)' }}>
          归档后不在「我的书案」展示，项目文件仍保留在原处。之后可从上方「归档」里移回。
        </p>
        {error ? (
          <p className="meta" style={{ margin: '0 0 12px', color: 'var(--danger)' }}>
            {error}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? '归档中…' : '归档'}
          </button>
        </div>
      </div>
    </div>
  )
}
