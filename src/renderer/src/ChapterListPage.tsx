import { useEffect, useMemo, useState } from 'react'
import type {
  ChapterMeta,
  Character,
  ChapterStatus,
  BatchProgress,
  ChapterFlowResult,
  ProjectData,
  StyleProfile
} from '../../shared/types'
import { dedupeForbiddenViolations } from './audit-dedupe'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenCharacters: () => void
  onOpenMemoryCenter: () => void
  onOpenOutline: () => void
}

const STATUS_FULL: Record<ChapterStatus, string> = {
  outline: '待写',
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

const CHAPTER_PAGE_SIZE = 20

/** 生成分页页码窗口：首尾页恒显，中间取当前页邻域，超距用省略号收拢。 */
function pageWindow(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const tokens: (number | 'ellipsis')[] = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) tokens.push('ellipsis')
  for (let i = start; i <= end; i++) tokens.push(i)
  if (end < total - 1) tokens.push('ellipsis')
  tokens.push(total)
  return tokens
}

export default function ChapterListPage({
  projectId,
  onOpenChapter
}: Props) {
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const [filter, setFilter] = useState<'all' | ChapterStatus>('all')
  const [page, setPage] = useState(1)

  const refresh = () => {
    setLoading(true)
    void window.api.listChapters(projectId)
      .then((list) => {
        setChapters(list)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[ChapterListPage] Failed to load chapters:', err)
        setLoading(false)
      })
  }
  const refreshCharacters = () => {
    void window.api.listCharacters(projectId)
      .then(setCharacters)
      .catch((err) => console.error('[ChapterListPage] Failed to load characters:', err))
  }

  useEffect(() => {
    setPage(1)
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / CHAPTER_PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * CHAPTER_PAGE_SIZE, currentPage * CHAPTER_PAGE_SIZE),
    [filtered, currentPage]
  )

  /** 按卷分组（volume 来自节奏图谱；无卷信息的归入「未分卷」），仅当前分页内的章节 */
  const volumeGroups = useMemo(() => {
    const map = new Map<number, ChapterMeta[]>()
    for (const c of paged) {
      const v = c.volume ?? 0
      if (!map.has(v)) map.set(v, [])
      map.get(v)!.push(c)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [paged])

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
          <div className="page-head-actions">
            <button
              className="btn btn-ghost"
              onClick={() => setShowBatch(true)}
              disabled={chapters.length === 0}
              title={chapters.length === 0 ? '需先创建章节' : '批量续写多章'}
            >
              批量续写
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>
              + 新章
            </button>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span
            className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => {
              setFilter('all')
              setPage(1)
            }}
          >
            全部 · {counts.all ?? 0}
          </span>
          {(Object.keys(STATUS_FULL) as ChapterStatus[]).map((s) =>
            counts[s] ? (
              <span
                key={s}
                className={`filter-chip ${filter === s ? 'active' : ''}`}
                onClick={() => {
                  setFilter(s)
                  setPage(1)
                }}
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
        <>
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
        {totalPages > 1 ? (
          <div className="paginator">
            <span className="page-info">
              第 {currentPage}/{totalPages} 页 · 共 {filtered.length} 章
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              上一页
            </button>
            {pageWindow(currentPage, totalPages).map((t, i) =>
              t === 'ellipsis' ? (
                <span key={`e${i}`} className="page-num ellipsis">…</span>
              ) : (
                <button
                  key={t}
                  className={`page-num ${t === currentPage ? 'active' : ''}`}
                  onClick={() => setPage(t)}
                >
                  {t}
                </button>
              )
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
            >
              下一页
            </button>
          </div>
        ) : null}
        </>
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

      {showBatch ? (
        <BatchWriteDialog
          projectId={projectId}
          maxChapter={
            chapters.length > 0
              ? Math.max(...chapters.map((c) => c.chapterNumber))
              : 0
          }
          onClose={() => setShowBatch(false)}
          onChapterCompleted={() => refresh()}
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
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BatchWriteDialog({
  projectId,
  maxChapter,
  onClose,
  onChapterCompleted
}: {
  projectId: string
  maxChapter: number
  onClose: () => void
  onChapterCompleted: () => void
}) {
  // 默认从最后一章的下一章开始
  const [fromChapter, setFromChapter] = useState(maxChapter + 1)
  const [toChapter, setToChapter] = useState(maxChapter + 3)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [lastResult, setLastResult] = useState<ChapterFlowResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [styleProfiles, setStyleProfiles] = useState<StyleProfile[]>([])
  const [styleProfileId, setStyleProfileId] = useState<string | null>(null)

  const status = progress?.status ?? 'pending'
  const isFinished = status === 'completed' || status === 'failed'

  // 批量续写结果角标计数：对 forbidden_word 做前缀重叠去重后再数，
  // 与质检面板展示一致（report.counts 含未去重命中，会偏大）。
  const auditDisplayCounts = useMemo(() => {
    if (!lastResult) return { error: 0, warn: 0 }
    const deduped = dedupeForbiddenViolations(lastResult.audit.violations)
    return {
      error: deduped.filter((v) => v.severity === 'error').length,
      warn: deduped.filter((v) => v.severity === 'warn').length
    }
  }, [lastResult])
  const isPaused = status === 'paused'

  useEffect(() => {
    void window.api.getProject(projectId).then(setProjectData)
    void window.api.listStyleProfiles(projectId).then(setStyleProfiles)
    setStyleProfileId(null)
  }, [projectId])

  const startBatch = async () => {
    if (fromChapter > toChapter) {
      setError('起始章号不能大于结束章号')
      return
    }
    if (fromChapter < 1) {
      setError('起始章号不能小于 1')
      return
    }
    setRunning(true)
    setError(null)
    setProgress(null)
    setLastResult(null)
    setStreamingText('')
    try {
      const res = await window.api.generateBatch(
        projectId,
        fromChapter,
        toChapter,
        styleProfileId,
        (chapter, result) => {
          setLastResult(result)
          onChapterCompleted()
          setStreamingText('')
        },
        (token, done) => {
          if (!done && token) {
            setStreamingText((prev) => prev + token)
          }
        }
      )
      if (res.ok && res.progress) {
        setProgress(res.progress)
      } else if (!res.ok) {
        setError(res.error ?? '批量续写失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      setStreamingText('')
    }
  }

  const resumeBatch = async () => {
    if (!progress) return
    setRunning(true)
    setError(null)
    // 保留 lastResult 直到新结果到达（M3 修复）
    setStreamingText('')
    try {
      const res = await window.api.resumeBatch(
        projectId,
        progress.currentChapter,
        progress.toChapter,
        styleProfileId,
        (chapter, result) => {
          setLastResult(result)
          onChapterCompleted()
          setStreamingText('')
        },
        (token, done) => {
          if (!done && token) {
            setStreamingText((prev) => prev + token)
          }
        }
      )
      if (res.ok && res.progress) {
        setProgress(res.progress)
      } else if (!res.ok) {
        setError(res.error ?? '继续批量续写失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      setStreamingText('')
    }
  }

  const statusLabel: Record<BatchProgress['status'], string> = {
    pending: '待开始',
    generating: '生成中',
    flow: '流程中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败'
  }

  return (
    <div className="dialog-overlay" onClick={running ? undefined : onClose}>
      <div className="dialog" style={{ minWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>批量续写</h3>
        <p className="desc" style={{ margin: '0 0 12px' }}>
          逐章生成正文并自动跑质检/细纲对照/记忆/节奏/图解流程，每章完成后暂停等你确认。
        </p>

        <div className="field">
          <label>文风</label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select
              className="select"
              value={styleProfileId ?? '__project_default__'}
              onChange={(e) => {
                const value = e.target.value
                setStyleProfileId(value === '__project_default__' ? null : value)
              }}
              disabled={running}
              style={{ flex: 1, minWidth: 220 }}
            >
              <option value="__project_default__">
                使用项目默认
                {projectData?.defaultStyleProfileId
                  ? `（${styleProfiles.find((item) => item.id === projectData.defaultStyleProfileId)?.name ?? '已设置'}）`
                  : '（无）'}
              </option>
              {styleProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <span className="meta" style={{ fontSize: 12 }}>
              {styleProfileId
                ? styleProfiles.find((item) => item.id === styleProfileId)?.identifiedStyle ?? '自定义文风'
                : '跟随项目默认'}
            </span>
          </div>
        </div>

        <div className="field-row">
          <div className="field" style={{ flex: 1 }}>
            <label>起始章号</label>
            <input
              className="input"
              type="number"
              min={1}
              value={fromChapter}
              onChange={(e) => setFromChapter(Number(e.target.value))}
              disabled={running}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>结束章号</label>
            <input
              className="input"
              type="number"
              min={fromChapter}
              value={toChapter}
              onChange={(e) => setToChapter(Number(e.target.value))}
              disabled={running}
            />
          </div>
        </div>

        {progress ? (
          <div className="batch-progress">
            <div className="batch-progress-head">
              <span className={`chip status-${status}`}>{statusLabel[status]}</span>
              <span className="batch-progress-count">
                {progress.completed.length} / {progress.total} 章完成
              </span>
            </div>
            {progress.currentChapter ? (
              <div className="batch-progress-current">
                当前：第 {progress.currentChapter} 章
              </div>
            ) : null}
            {progress.pauseReason ? (
              <div className="batch-progress-reason">{progress.pauseReason}</div>
            ) : null}
            {progress.error ? (
              <div className="batch-progress-error">{progress.error}</div>
            ) : null}
            {progress.completed.length > 0 ? (
              <div className="batch-progress-completed">
                已完成章节：{progress.completed.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}

        {streamingText ? (
          <div className="batch-streaming">
            <div className="batch-streaming-head">正在生成…</div>
            <pre className="batch-streaming-text">{streamingText}</pre>
          </div>
        ) : null}

        {lastResult ? (
          <div className="batch-last-result">
            <div className="batch-last-result-head">
              第 {lastResult.chapterNumber} 章结果
            </div>
            <ul className="batch-last-result-list">
              <li>
                字数：{lastResult.content.length}
              </li>
              <li>
                质检：
                {auditDisplayCounts.error > 0
                  ? `${auditDisplayCounts.error} 错误`
                  : auditDisplayCounts.warn > 0
                    ? `${auditDisplayCounts.warn} 警告`
                    : '通过'}
              </li>
              <li>
                细纲差异：{lastResult.outlineDiff.diffs.length} 项
                {lastResult.outlineDiff.diffs.some((d) => d.priority === 'P0')
                  ? '（含 P0）'
                  : ''}
              </li>
              <li>
                记忆：角色 {lastResult.memory.newCharacters.length} / 地点{' '}
                {lastResult.memory.newLocations.length} / 伏笔{' '}
                {lastResult.memory.newForeshadowings.length} / 状态变化{' '}
                {lastResult.memory.characterStateChanges.length}
              </li>
              <li>
                节奏：{lastResult.rhythm ? `实际情绪 ${lastResult.rhythm.actualEmotion}` : '未评估'}
              </li>
              <li>
                图解：{lastResult.figure.shouldGenerate ? `生成 ${lastResult.figure.fileName}` : '本章无关键转折'}
              </li>
            </ul>
          </div>
        ) : null}

        {error ? <div className="error-text">{error}</div> : null}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            {isFinished ? '关闭' : '取消'}
          </button>
          {!progress || status === 'pending' ? (
            <button
              className="btn btn-primary"
              onClick={startBatch}
              disabled={running || fromChapter < 1 || toChapter < fromChapter}
            >
              {running ? '生成中…' : '开始批量续写'}
            </button>
          ) : isPaused ? (
            <button className="btn btn-primary" onClick={resumeBatch} disabled={running}>
              {running ? '生成中…' : '继续下一章'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
