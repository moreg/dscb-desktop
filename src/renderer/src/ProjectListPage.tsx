import { useEffect, useMemo, useState } from 'react'
import type { ProjectMeta, ChapterMeta } from '../../shared/types'

interface Props {
  onOpenProject: (projectId: string) => void
}

export default function ProjectListPage({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [chapterCounts, setChapterCounts] = useState<Record<string, number>>({})
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [keyword, setKeyword] = useState('')

  const refresh = () => {
    setLoading(true)
    void window.api.listProjects().then(async (list) => {
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
      setLoading(false)
    })
  }

  /** 扫描 projectsRoot，自动发现含 大纲/大纲.md 的 v3.2 项目 */
  const scan = async () => {
    setScanning(true)
    try {
      await window.api.scanProjects()
      refresh()
    } finally {
      setScanning(false)
    }
  }

  useEffect(refresh, [])

  const filtered = useMemo(() => {
    if (!keyword) return projects
    const k = keyword.toLowerCase()
    return projects.filter(
      (p) => p.name.toLowerCase().includes(k) || (p.genre ?? '').toLowerCase().includes(k)
    )
  }, [projects, keyword])

  const totalWords = useMemo(
    () => Object.values(wordCounts).reduce((s, n) => s + n, 0),
    [wordCounts]
  )

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
            <p className="desc">静待落笔处，万卷由此生</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-ghost"
              onClick={scan}
              disabled={scanning}
              title="扫描保存位置，自动发现技能 v3.2 格式的项目"
            >
              {scanning ? '扫描中…' : '↻ 扫描项目'}
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>
              + 落笔开篇
            </button>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span className="filter-chip">项目 {projects.length}</span>
          <span className="filter-chip">总字数 {(totalWords / 10000).toFixed(1)} 万</span>
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="搜索项目 / 题材…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

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
        <p className="empty">没有匹配的项目。</p>
      ) : (
        <div className="project-grid">
          {filtered.map((p) => {
            const ch = chapterCounts[p.id] ?? 0
            const wc = wordCounts[p.id] ?? 0
            const initial = p.name.trim().charAt(0) || '卷'
            return (
              <button
                key={p.id}
                type="button"
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
                  <span className="open">进入 →</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
      {showNew ? (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [genre, setGenre] = useState('')
  const [description, setDescription] = useState('')
  const [targetChapters, setTargetChapters] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [selecting, setSelecting] = useState(false)

  const selectPath = async () => {
    setSelecting(true)
    try {
      const selected = await window.api.selectDirectory()
      if (selected) setCustomPath(selected)
    } finally {
      setSelecting(false)
    }
  }

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await window.api.createProject({
        name: name.trim(),
        genre: genre.trim() || undefined,
        description: description.trim() || undefined,
        targetChapters: targetChapters ? Number(targetChapters) : undefined,
        customPath: customPath.trim() || undefined
      })
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建项目</h3>
        <div className="field">
          <label>名称 *</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="《九霄剑尊》"
            autoFocus
          />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>题材</label>
            <input
              className="input"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder="玄幻 / 都市 / 科幻…"
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>预计章数</label>
            <input
              className="input"
              type="number"
              min={1}
              value={targetChapters}
              onChange={(e) => setTargetChapters(e.target.value)}
              placeholder="如 200"
            />
          </div>
        </div>
        <div className="field">
          <label>简介</label>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="一句话概括故事 / 卖点"
          />
        </div>
        <div className="field">
          <label>保存位置（可选）</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="默认位置"
              style={{ flex: 1 }}
              readOnly
            />
            <button
              className="btn btn-ghost btn-sm"
              onClick={selectPath}
              disabled={selecting}
              style={{ whiteSpace: 'nowrap' }}
            >
              {selecting ? '…' : '选择'}
            </button>
          </div>
          {customPath ? (
            <p className="meta" style={{ marginTop: 4 }}>
              将保存到：{customPath}
            </p>
          ) : null}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving || !name.trim()}>
            {saving ? '创建中…' : '落笔'}
          </button>
        </div>
      </div>
    </div>
  )
}
