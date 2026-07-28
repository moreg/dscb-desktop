import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChapterMeta,
  Character,
  ChapterStatus,
  BatchProgress,
  ChapterFlowResult,
  ProjectData,
  TeardownEntry
} from '../../shared/types'
import { dedupeForbiddenViolations } from './audit-dedupe'
import { useProjectStyleData } from './style-profile/hooks/useProjectStyleData'

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
  const [showBenchmark, setShowBenchmark] = useState(false)
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [filter, setFilter] = useState<'all' | ChapterStatus>('all')
  const [page, setPage] = useState(1)

  /** 请求序号：并发刷新时只认最新一次的回包，防止慢的旧响应覆盖新响应 */
  const refreshSeqRef = useRef(0)
  /**
   * @param opts.showLoading 仅首次加载/切项目时整页转「展卷中…」；
   * 外部文件变更触发的刷新（批量续写每章落盘都会触发）静默替换，
   * 避免列表反复卸载重挂、滚动位置丢失
   */
  const refresh = (opts?: { showLoading?: boolean }) => {
    const seq = ++refreshSeqRef.current
    if (opts?.showLoading) setLoading(true)
    void window.api.listChapters(projectId)
      .then((list) => {
        if (seq !== refreshSeqRef.current) return
        setChapters(list)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[ChapterListPage] Failed to load chapters:', err)
        if (seq === refreshSeqRef.current) setLoading(false)
      })
  }
  const refreshCharacters = () => {
    void window.api.listCharacters(projectId)
      .then(setCharacters)
      .catch((err) => console.error('[ChapterListPage] Failed to load characters:', err))
  }

  useEffect(() => {
    setPage(1)
    refresh({ showLoading: true })
    refreshCharacters()
    void window.api.getProject(projectId).then(setProjectData).catch((err) => {
      console.error('[ChapterListPage] Failed to load project:', err)
    })
    // refresh/refreshCharacters 依赖 projectId 内部状态，仅 projectId 变化时重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 订阅外部文件变更（用户用外部编辑器改源文件时自动刷新）
  useEffect(() => {
    const off = window.api.onProjectFilesChanged((e) => {
      if (e.projectId !== projectId) return
      // 细纲/节奏图谱/章节进度变 → 刷新章节列表；角色卡变 → 同时刷角色
      refresh()
      if (e.kind === 'characters') refreshCharacters()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意只随 projectId 触发；refresh 系函数每次渲染都是新引用
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
    // 按组内首章的章节号排序（而非卷号）：按卷号升序会让「未分卷」（0）恒排最前，
    // 分卷/未分卷混排的页面展示顺序会偏离章节号顺序
    return [...map.entries()].sort((a, b) => a[1][0].chapterNumber - b[1][0].chapterNumber)
  }, [paged])

  /**
   * 卷头展示用的全量统计：范围/章数必须基于整个项目算，
   * 不能用分页切片——否则翻页后「第 1 卷（21-40 章）」这种失真范围会误导用户。
   */
  const volumeStats = useMemo(() => {
    const m = new Map<number, { min: number; max: number; total: number }>()
    for (const c of chapters) {
      const v = c.volume ?? 0
      const s = m.get(v)
      if (!s) m.set(v, { min: c.chapterNumber, max: c.chapterNumber, total: 1 })
      else {
        s.min = Math.min(s.min, c.chapterNumber)
        s.max = Math.max(s.max, c.chapterNumber)
        s.total += 1
      }
    }
    return m
  }, [chapters])

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
              onClick={() => setShowBenchmark(true)}
              title="挂载拆文库对标书，写作时召回情绪模块/节奏/文风"
            >
              📚 对标
              {projectData?.benchmarkBooks?.length
                ? ` ${projectData.benchmarkBooks.length}`
                : ''}
            </button>
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
          {(() => {
            const chipKeyDown = (apply: () => void) => (e: React.KeyboardEvent) => {
              // span 无原生键盘激活；Enter/空格与点击等价
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                apply()
              }
            }
            const applyFilter = (f: 'all' | ChapterStatus) => {
              setFilter(f)
              setPage(1)
            }
            return (
              <>
                <span
                  className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => applyFilter('all')}
                  onKeyDown={chipKeyDown(() => applyFilter('all'))}
                >
                  全部 · {counts.all ?? 0}
                </span>
                {(Object.keys(STATUS_FULL) as ChapterStatus[]).map((s) =>
                  // 计数为 0 但正处于该筛选时仍要显示：否则激活中的 chip 凭空消失，
                  // 用户看不出自己在筛什么、也没法点回「全部」以外的入口
                  counts[s] || filter === s ? (
                    <span
                      key={s}
                      className={`filter-chip ${filter === s ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => applyFilter(s)}
                      onKeyDown={chipKeyDown(() => applyFilter(s))}
                      title={STATUS_FULL[s]}
                    >
                      {STATUS_FULL[s]} · {counts[s] ?? 0}
                    </span>
                  ) : null
                )}
              </>
            )
          })()}
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
                  ? `第 ${vol} 卷（${volumeStats.get(vol)?.min ?? chs[0].chapterNumber}-${volumeStats.get(vol)?.max ?? chs[chs.length - 1].chapterNumber} 章）`
                  : '未分卷'}
                <span className="volume-count">
                  {(volumeStats.get(vol)?.total ?? chs.length) === chs.length
                    ? `${chs.length} 章`
                    : `本页 ${chs.length} / 共 ${volumeStats.get(vol)!.total} 章`}
                </span>
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

      {showBenchmark ? (
        <BenchmarkDialog
          projectId={projectId}
          current={projectData?.benchmarkBooks ?? []}
          onClose={() => setShowBenchmark(false)}
          onSaved={async () => {
            // 保存已成功，刷新项目数据失败不应把对话框卡在打开态
            try {
              setProjectData(await window.api.getProject(projectId))
            } catch (err) {
              console.error('[ChapterListPage] Failed to refresh project after save:', err)
            }
            setShowBenchmark(false)
          }}
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
  const [error, setError] = useState('')
  const submit = async () => {
    // 必须挡 saving：Enter 提交不经过按钮的 disabled，连按会并发 createChapter 建出重复章节
    if (!title.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      await window.api.createChapter(projectId, { title: title.trim() })
      onCreated()
    } catch (err) {
      // 应用内错误位，替代阻塞式原生 alert（与批量对话框的 error-text 风格一致）
      setError((err as Error).message || '创建失败')
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
              // isComposing：中文输入法按 Enter 选词不能触发提交
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
            }}
          />
        </div>
        {error ? <div className="error-text">创建失败：{error}</div> : null}
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
  // 默认从最后一章的下一章开始。
  // 用字符串保存输入：数字受控值会把清空立刻回显成 0，用户无法正常重新输入
  const [fromChapterStr, setFromChapterStr] = useState(String(maxChapter + 1))
  const [toChapterStr, setToChapterStr] = useState(String(maxChapter + 3))
  const fromChapter = Number(fromChapterStr)
  const toChapter = Number(toChapterStr)
  const rangeValid =
    Number.isInteger(fromChapter) &&
    Number.isInteger(toChapter) &&
    fromChapter >= 1 &&
    toChapter >= fromChapter
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [lastResult, setLastResult] = useState<ChapterFlowResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const { projectData, styleProfiles } = useProjectStyleData(projectId)
  const [styleProfileId, setStyleProfileId] = useState<string | null>(null)
  // 当前批量运行的 requestId：「⏹ 停止」按钮用它 abortStream 中断当前章生成
  const batchRequestIdRef = useRef<string | null>(null)
  const [stopping, setStopping] = useState(false)
  // 流式预览自动滚底：不滚的话超过容器高度后新 token 一直藏在滚动条下方，
  // 「正在生成…」看起来像卡住了
  const streamingBoxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = streamingBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [streamingText])

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
    setStyleProfileId(null)
  }, [projectId])

  const startBatch = async () => {
    if (!Number.isInteger(fromChapter) || !Number.isInteger(toChapter)) {
      setError('请填写起始与结束章号')
      return
    }
    if (fromChapter > toChapter) {
      setError('起始章号不能大于结束章号')
      return
    }
    if (fromChapter < 1) {
      setError('起始章号不能小于 1')
      return
    }
    setRunning(true)
    setStopping(false)
    setError(null)
    setProgress(null)
    setLastResult(null)
    setStreamingText('')
    const requestId = crypto.randomUUID()
    batchRequestIdRef.current = requestId
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
        },
        requestId
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
      setStopping(false)
      setStreamingText('')
      batchRequestIdRef.current = null
    }
  }

  const resumeBatch = async () => {
    if (!progress) return
    setRunning(true)
    setStopping(false)
    setError(null)
    // 保留 lastResult 直到新结果到达（M3 修复）
    setStreamingText('')
    const requestId = crypto.randomUUID()
    batchRequestIdRef.current = requestId
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
        },
        requestId,
        // 透传整批进度，否则续跑会把 total 缩成剩余章数、completed 清空，进度倒退
        {
          fromChapter: progress.fromChapter,
          total: progress.total,
          completed: progress.completed
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
      setStopping(false)
      setStreamingText('')
      batchRequestIdRef.current = null
    }
  }

  /**
   * 失败后重试**当前**这一章（而不是像 resumeBatch 那样跳到下一章）。
   * 点 ⏹ 停止 也会落到 failed，此前这个状态下一个按钮都没有，整批就此卡死；
   * 而错误提示还写着「可点继续重试当前章」，指向一个不存在的按钮。
   */
  const retryBatch = async () => {
    if (!progress) return
    setRunning(true)
    setStopping(false)
    setError(null)
    setStreamingText('')
    const requestId = crypto.randomUUID()
    batchRequestIdRef.current = requestId
    try {
      const res = await window.api.generateBatch(
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
        },
        requestId,
        // 沿用整批进度：重试不该把已完成章数清零
        {
          fromChapter: progress.fromChapter,
          total: progress.total,
          completed: progress.completed
        }
      )
      if (res.ok && res.progress) {
        setProgress(res.progress)
      } else if (!res.ok) {
        setError(res.error ?? '重试当前章失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      setStopping(false)
      setStreamingText('')
      batchRequestIdRef.current = null
    }
  }

  const stopBatch = () => {
    const id = batchRequestIdRef.current
    if (!id) return
    setStopping(true)
    // 中断当前章的 LLM 生成；generateBatch 的 promise 会以 failed 进度返回
    void window.api.abortStream(id).catch(() => {
      setStopping(false)
    })
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
              value={fromChapterStr}
              onChange={(e) => setFromChapterStr(e.target.value)}
              disabled={running}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>结束章号</label>
            <input
              className="input"
              type="number"
              min={Number.isInteger(fromChapter) ? fromChapter : 1}
              value={toChapterStr}
              onChange={(e) => setToChapterStr(e.target.value)}
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
              <div className="batch-progress-error">
                {progress.error.includes('LLM_ABORTED')
                  ? `已停止生成（可点「重试第 ${progress.currentChapter} 章」继续）`
                  : progress.error}
              </div>
            ) : null}
            {progress.completed.length > 0 ? (
              <div className="batch-progress-completed">
                已完成章节：{progress.completed.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}

        {streamingText ? (
          <div className="batch-streaming" ref={streamingBoxRef}>
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
          {running && (
            <button
              className="btn btn-ghost"
              onClick={stopBatch}
              disabled={stopping}
              title="中断当前章的生成（已完成的章节保留，可稍后继续）"
            >
              {stopping ? '停止中…' : '⏹ 停止'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            {isFinished ? '关闭' : '取消'}
          </button>
          {!progress || status === 'pending' ? (
            <button
              className="btn btn-primary"
              onClick={startBatch}
              disabled={running || !rangeValid}
            >
              {running ? '生成中…' : '开始批量续写'}
            </button>
          ) : isPaused ? (
            <button className="btn btn-primary" onClick={resumeBatch} disabled={running}>
              {running ? '生成中…' : '继续下一章'}
            </button>
          ) : status === 'failed' ? (
            <button
              className="btn btn-primary"
              onClick={retryBatch}
              disabled={running}
              title="重新生成失败的这一章；已完成的章节保留"
            >
              {running ? '生成中…' : `重试第 ${progress?.currentChapter ?? ''} 章`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function BenchmarkDialog({
  projectId,
  current,
  onClose,
  onSaved
}: {
  projectId: string
  current: string[]
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [teardowns, setTeardowns] = useState<TeardownEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set(current))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.listTeardowns().then((list) => {
      setTeardowns(list)
      setLoading(false)
    }).catch((err) => {
      console.error('[BenchmarkDialog] Failed to load teardowns:', err)
      setTeardowns([])
      setLoading(false)
    })
  }, [])

  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const [saveError, setSaveError] = useState('')
  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      await window.api.setBenchmarkBooks(projectId, Array.from(selected))
      onSaved()
    } catch (err) {
      // 无 catch 时保存失败会静默成 unhandled rejection，用户以为没点上
      setSaveError((err as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" style={{ maxWidth: 560, maxHeight: '80vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h3>📚 对标书（写作召回）</h3>
        <p className="meta" style={{ marginTop: 4 }}>
          挂载拆文库中的对标书。续写时自动召回其情绪模块（爽点套路）、节奏（爆发节律）、文风（句法），让正文向对标靠拢。
          <strong>只召回方法论，不照搬具体桥段。</strong>
        </p>

        {loading ? (
          <p className="empty">加载拆文库…</p>
        ) : teardowns.length === 0 ? (
          <div className="placeholder" style={{ marginTop: 12 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13 }}>拆文库还没有书。先到「🔍 拆文库」拆解一本爆款，再回来挂载。</p>
          </div>
        ) : (
          <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 12 }}>
            {teardowns.map((t) => {
              const done = t.stagesCompleted.length > 0
              return (
                <label
                  key={t.bookName}
                  className="toolbar-more-item"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.bookName)}
                    onChange={() => toggle(t.bookName)}
                  />
                  <span style={{ flex: 1 }}>
                    <strong>{t.bookName}</strong>
                    <span className="meta" style={{ marginLeft: 8, fontSize: 11 }}>
                      {t.lengthKind === 'long' ? '长篇' : '短篇'} · {(t.wordCount / 10000).toFixed(1)} 万字
                      {done ? ` · ${t.stagesCompleted.length} 阶段` : ' · 未拆解'}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {selected.size > 0 ? (
          <p className="meta" style={{ marginTop: 8 }}>
            已选 {selected.size} 本：{Array.from(selected).map((n) => `《${n}》`).join('、')}
          </p>
        ) : null}

        {saveError ? <div className="error-text">保存失败：{saveError}</div> : null}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
