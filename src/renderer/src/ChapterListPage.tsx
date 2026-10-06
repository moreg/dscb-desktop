import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AutoDeslopResult,
  ChapterMeta,
  Character,
  ChapterStatus,
  BatchProgress,
  ChapterFlowResult,
  ChapterGenerationStage,
  MemoryApplyResult,
  MemoryCandidateDetail,
  MemoryCandidateItem,
  MemoryCandidateSummary,
  ProjectData,
  TeardownEntry
} from '../../shared/types'
import { countPendingConfirms } from '../../shared/post-write-sync'
import { getBatchRangeError, MAX_BATCH_CHAPTERS } from '../../shared/batch-range'
import { dedupeForbiddenViolations } from './audit-dedupe'
import { useProjectStyleData } from './style-profile/hooks/useProjectStyleData'
import BatchPolishDialog, { type BatchPolishRange } from './BatchPolishDialog'
import {
  suggestChapterStrength,
  type ChapterStrengthSuggestion
} from '../../shared/chapter-strength-suggestion'

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

export interface ChapterPaginatorProps {
  currentPage: number
  totalPages: number
  totalItems: number
  onPageChange: (page: number) => void
  className?: string
}

export function ChapterPaginator({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
  className
}: ChapterPaginatorProps) {
  if (totalPages <= 1) return null
  return (
    <div className={`paginator ${className ?? ''}`.trim()}>
      <span className="page-info">
        第 {currentPage}/{totalPages} 页 · 共 {totalItems} 章
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
      >
        上一页
      </button>
      {pageWindow(currentPage, totalPages).map((t, i) =>
        t === 'ellipsis' ? (
          <span key={`e${i}`} className="page-num ellipsis">
            …
          </span>
        ) : (
          <button
            key={t}
            type="button"
            className={`page-num ${t === currentPage ? 'active' : ''}`}
            onClick={() => onPageChange(t)}
          >
            {t}
          </button>
        )
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
      >
        下一页
      </button>
    </div>
  )
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
  const [showPolish, setShowPolish] = useState(false)
  const [polishPreset, setPolishPreset] = useState<BatchPolishRange | undefined>(undefined)
  // 「一键写 10 章」带进批量对话框的预设（章数 + 连续模式）；手动入口不带
  const [batchPreset, setBatchPreset] = useState<
    { count: number; autoContinue: boolean } | undefined
  >(undefined)
  // 还没入库的记忆候选：连写多章后最容易堆在这里，给个常驻入口
  const [candidateCount, setCandidateCount] = useState(0)
  const [showCandidateReview, setShowCandidateReview] = useState(false)
  const [showBenchmark, setShowBenchmark] = useState(false)
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [filter, setFilter] = useState<'all' | ChapterStatus>('all')
  const [page, setPage] = useState(1)
  // 导出正文：'all' 表示导出全书，number 表示导出该卷；null 表示当前没有导出在进行
  const [exporting, setExporting] = useState<'all' | number | null>(null)
  const [exportError, setExportError] = useState('')

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

  /**
   * 未写章节号（status === 'outline'，即细纲/节奏表里存在但正文还没落笔），升序。
   * 批量续写默认区间用它定位起点：细纲经常是整卷一次性导入的，未写章节不一定
   * 紧跟在「当前最大章号」后面——如果中间有章因失败/跳过没写，maxChapter+1
   * 会直接跳过那个缺口，永远不会自动补上。
   */
  const unwrittenChapterNumbers = useMemo(
    () =>
      chapters
        .filter((c) => c.status === 'outline' && !c.wordCount)
        .map((c) => c.chapterNumber)
        .sort((a, b) => a - b),
    [chapters]
  )
  /** 已有正文的章号集合：批量续写选中的区间如果混进这些号，会把已写内容静默覆盖 */
  const draftedChapterNumbers = useMemo(
    () => new Set(chapters.filter((c) => c.status !== 'outline' || c.wordCount > 0).map((c) => c.chapterNumber)),
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

  useEffect(() => {
    let alive = true
    void window.api
      .listMemoryCandidates(projectId)
      .then((list) => {
        if (alive) setCandidateCount(list.length)
      })
      .catch(() => {
        if (alive) setCandidateCount(0)
      })
    return () => {
      alive = false
    }
    // showCandidateReview 进出都刷新一次：复核面板里重跑过之后计数要跟着变
  }, [projectId, chapters, showCandidateReview])

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage)
    const mainEl = document.querySelector('.main-content')
    if (mainEl) {
      mainEl.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  /** 导出正文为 txt：volumeNumber 缺省导出全书，指定则只导出该卷 */
  const handleExport = async (volumeNumber?: number): Promise<void> => {
    setExportError('')
    setExporting(volumeNumber ?? 'all')
    try {
      await window.api.exportChapters(projectId, volumeNumber)
    } catch (err) {
      console.error('[ChapterListPage] Failed to export chapters:', err)
      setExportError((err as Error).message || '导出失败')
    } finally {
      setExporting(null)
    }
  }

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
              onClick={() => {
                setPolishPreset(undefined)
                setShowPolish(true)
              }}
              disabled={loading || showBatch || !chapters.some((c) => c.wordCount > 0)}
              title="批量润色已保存的正文，自动核对并修复事实差异"
            >
              批量去 AI 味
            </button>
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
              onClick={() => {
                setBatchPreset(undefined)
                setShowBatch(true)
              }}
              disabled={loading || chapters.length === 0}
              title={chapters.length === 0 ? '需先创建章节' : '批量续写多章'}
            >
              批量续写
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setBatchPreset({ count: 10, autoContinue: true })
                setShowBatch(true)
              }}
              disabled={loading || chapters.length === 0}
              title={
                chapters.length === 0
                  ? '需先创建章节'
                  : '从最早未写章节起连续写 10 章；正文增量自动回写细纲，遇到重要检查或同步问题时暂停（可在弹窗里改章数）'
              }
            >
              ⚡ 一键写 10 章
            </button>
            {candidateCount > 0 ? (
              <button
                className="btn btn-ghost"
                onClick={() => setShowCandidateReview(true)}
                title="有章节的记忆条目因证据不足没有写进记忆库，点开复核"
              >
                记忆待核对 {candidateCount} 章
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              onClick={() => void handleExport()}
              disabled={exporting !== null || chapters.length === 0}
              title={chapters.length === 0 ? '需先创建章节' : '导出全书正文为 txt 文件'}
            >
              {exporting === 'all' ? '导出中…' : '导出全书 TXT'}
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>
              + 新章
            </button>
          </div>
        </div>
        {exportError ? <p className="empty" style={{ color: 'var(--danger)' }}>{exportError}</p> : null}
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
              const mainEl = document.querySelector('.main-content')
              if (mainEl) {
                mainEl.scrollTo({ top: 0, behavior: 'smooth' })
              }
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
        <ChapterPaginator
          className="paginator-top"
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filtered.length}
          onPageChange={handlePageChange}
        />
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
                <span className="volume-head-right">
                  <span className="volume-count">
                    {(volumeStats.get(vol)?.total ?? chs.length) === chs.length
                      ? `${chs.length} 章`
                      : `本页 ${chs.length} / 共 ${volumeStats.get(vol)!.total} 章`}
                  </span>
                  {vol > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleExport(vol)}
                      disabled={exporting !== null}
                      title="导出本卷正文为 txt 文件"
                    >
                      {exporting === vol ? '导出中…' : '导出本卷'}
                    </button>
                  ) : null}
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
        <ChapterPaginator
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filtered.length}
          onPageChange={handlePageChange}
        />
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
          key={projectId}
          projectId={projectId}
          chapters={chapters}
          maxChapter={
            chapters.length > 0
              ? Math.max(...chapters.map((c) => c.chapterNumber))
              : 0
          }
          unwrittenChapters={unwrittenChapterNumbers}
          draftedChapters={draftedChapterNumbers}
          preset={batchPreset}
          onClose={() => setShowBatch(false)}
          onChapterCompleted={() => refresh()}
          onPolishBatch={(range) => {
            setShowBatch(false)
            setPolishPreset(range)
            setShowPolish(true)
          }}
        />
      ) : null}

      {showPolish ? (
        <BatchPolishDialog
          key={projectId}
          projectId={projectId}
          chapters={chapters}
          preset={polishPreset}
          onClose={() => setShowPolish(false)}
          onChapterCompleted={() => refresh()}
        />
      ) : null}

      {showCandidateReview ? (
        <MemoryCandidateDialog
          projectId={projectId}
          onClose={() => setShowCandidateReview(false)}
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

/**
 * 连续模式下的逐章留痕。
 * 只留 lastResult 的话，一口气写 10 章后面板里只剩最后一章，
 * 中间哪一章质检不过、哪一章偏离细纲全部被覆盖掉，用户无从返工。
 */
export interface BatchChapterSummary {
  chapter: number
  /** 本章按节奏自动调整的生成强度建议（开启 autoStrength 时记录） */
  strengthSuggestion?: ChapterStrengthSuggestion
  summaryReady: boolean
  words: number
  autoDeslop?: AutoDeslopResult
  auditError: number
  auditWarn: number
  /** 细纲对照里的 P0 差异条数 */
  p0: number
  /**
   * 细纲对照状态。'none' 没细纲、'failed' 有细纲但对照没跑成、'checked' 已对照；
   * 'unknown' 是旧路径没带状态字段——这三种里只有 'checked' 的 p0=0 才说明真的没问题。
   */
  outline: 'none' | 'failed' | 'checked' | 'unknown'
  /** 写后自检：未执行为 null */
  selfCheck: { fail: number; warn: number; failedItems: string[] } | null
  settingsErrors: string[]
  /** 记忆同步落地情况：候选数 ≠ 写入数，两个都要露出来 */
  memory: {
    /**
     * 自动可写入的候选数：情节 / 角色状态 / 伏笔回收。
     * 不含新角色、新地点、新道具、新伏笔——那四类按设计要作者确认，
     * 自动同步的 applied 恒为 0，算进分母只会让每章都显示成「写入 6/18」。
     */
    candidates: number
    applied: number
    /** 待作者确认的新增实体数（新角色/地点/道具/伏笔），不是失败 */
    pending: number
    /** 已自动/一键入库的新增实体数（新角色/地点/道具/伏笔） */
    appliedEntities?: number
    /** 整章都没入库的原因 */
    reviewRequired: string[]
    /** 其余已入库，这几条证据不过关被单独挡下 */
    heldBack: string[]
    superseded: boolean
    /** 整章流程没返回同步结果（记忆同步未执行） */
    missing: boolean
    errors: string[]
  }
}

/** 自动同步真正会写的三类；新增实体走 countMemoryPending */
function countMemoryCandidates(m: ChapterFlowResult['memory']): number {
  return m.newPlotPoints.length + m.characterStateChanges.length + m.collectedForeshadowings.length
}

function countMemoryApplied(applied: MemoryApplyResult['applied']): number {
  return applied.plotPoints + applied.stateChanges + applied.collected
}

/**
 * 待确认的新增实体。已被确认写入的（applied 里的实体计数）从待办里扣掉，
 * 免得确认过一轮后面板还挂着同样的数字。
 */
function countMemoryPending(
  m: ChapterFlowResult['memory'],
  applied?: MemoryApplyResult['applied']
): number {
  const p = countPendingConfirms(m)
  const extracted = p.characters + p.locations + p.items + p.foreshadowings
  const confirmed = applied
    ? applied.characters + applied.locations + applied.items + applied.foreshadowings
    : 0
  return Math.max(0, extracted - confirmed)
}

function resolveOutlineState(report: ChapterFlowResult['outlineDiff']): BatchChapterSummary['outline'] {
  if (report.hasOutline === false) return 'none'
  if (report.hasOutline === undefined) return 'unknown'
  return report.checked ? 'checked' : 'failed'
}

/**
 * 从整章流程结果里抽出小结。
 * 违禁词做前缀重叠去重后再数，与质检面板一致（report.counts 含未去重命中，会偏大）。
 */
export function summarizeChapterResult(
  result: ChapterFlowResult,
  strengthSuggestion?: ChapterStrengthSuggestion
): BatchChapterSummary {
  const deduped = dedupeForbiddenViolations(result.audit.violations)
  const apply = result.memoryApply
  return {
    chapter: result.chapterNumber,
    ...(strengthSuggestion ? { strengthSuggestion } : {}),
    summaryReady: result.chapterSummary?.stale === false,
    words: result.content.length,
    autoDeslop: result.autoDeslop,
    auditError: deduped.filter((v) => v.severity === 'error').length,
    auditWarn: deduped.filter((v) => v.severity === 'warn').length,
    p0: result.outlineDiff.diffs.filter((d) => d.priority === 'P0').length,
    outline: resolveOutlineState(result.outlineDiff),
    selfCheck: result.selfCheck
      ? {
          fail: result.selfCheck.counts.fail,
          warn: result.selfCheck.counts.warn,
          failedItems: result.selfCheck.items
            .filter((item) => item.verdict === 'fail')
            .map((item) => item.label)
        }
      : null,
    settingsErrors: result.settingsApply?.errors ?? [],
    memory: {
      candidates: countMemoryCandidates(result.memory),
      applied: apply ? countMemoryApplied(apply.applied) : 0,
      pending: countMemoryPending(result.memory, apply?.applied),
      appliedEntities: apply
        ? apply.applied.characters + apply.applied.locations + apply.applied.items + apply.applied.foreshadowings
        : 0,
      reviewRequired: apply?.reviewRequired ?? [],
      heldBack: apply?.heldBack ?? [],
      superseded: apply?.superseded === true,
      missing: !apply,
      errors: apply?.errors ?? []
    }
  }
}

/** 细纲一栏文案：没细纲、没跑成、跑了有 P0、跑了没 P0，四种要分开说 */
export function describeOutlineCell(s: BatchChapterSummary): string {
  if (s.outline === 'none') return '无细纲可对照'
  if (s.outline === 'failed') return '细纲对照未完成'
  if (s.p0 > 0) return `细纲 P0 ${s.p0} 项`
  return s.outline === 'unknown' ? `细纲差异 ${s.p0} 项` : '细纲无 P0'
}

/** 写后自检一栏文案 */
export function describeSelfCheckCell(s: BatchChapterSummary): string {
  if (!s.selfCheck) return '自检未执行'
  if (s.selfCheck.fail > 0) return `自检 ${s.selfCheck.fail} 项未过`
  if (s.selfCheck.warn > 0) return `自检 ${s.selfCheck.warn} 项提醒`
  return '自检通过'
}

export function describeAutoDeslopCell(s: BatchChapterSummary): string {
  if (!s.autoDeslop) return '本次未重新润色'
  if (s.autoDeslop.status === 'applied') return (s.autoDeslop.repairAttempts ?? 0) > 0
    ? `自动修复 ${s.autoDeslop.repairAttempts} 次后去 AI 味已完成`
    : '自动去 AI 味已完成'
  if (s.autoDeslop.status === 'unchanged') return '去 AI 味无需修改'
  return s.autoDeslop.message
}

/**
 * 记忆一栏文案：提取到多少 ≠ 写进去多少，必须分开报。
 * 「待确认新增」不算没写进去——那四类本来就等作者点确认，混进分数会让人以为丢了记忆。
 */
export function describeMemoryCell(s: BatchChapterSummary): string {
  const { candidates, applied, pending, appliedEntities, reviewRequired, heldBack, superseded, missing, errors } = s.memory
  if (superseded) return '记忆未写入（正文已变）'
  if (reviewRequired.length > 0) return `整章记忆待核对 ${reviewRequired.length} 项，未写入`
  if (missing) return '记忆同步未执行'
  if (errors.length > 0) return `记忆同步失败 ${errors.length} 项（已写入 ${applied}/${candidates} 条）`
  const held = heldBack.length > 0 ? `，${heldBack.length} 项证据不足未写入` : ''
  const autoEntities = appliedEntities && appliedEntities > 0 ? `，已自动入库 ${appliedEntities} 项新实体` : ''
  const confirm = pending > 0 ? `，待确认新增 ${pending} 项` : ''
  if (candidates === 0) return pending > 0 ? `待确认新增 ${pending} 项` : (appliedEntities && appliedEntities > 0 ? `已自动入库 ${appliedEntities} 项新实体` : '无新记忆')
  if (applied === 0) return `记忆提取 ${candidates} 条，未写入${held}${autoEntities}${confirm}`
  return `记忆写入 ${applied}/${candidates} 条${held}${autoEntities}${confirm}`
}

/**
 * 需要作者回头处理的章。
 * 不含「无细纲可对照」——那是项目没细纲，不是这一章写坏了，单独在抬头里报。
 */
export function hasChapterIssue(s: BatchChapterSummary): boolean {
  return (
    s.autoDeslop?.status === 'failed' ||
    s.autoDeslop?.status === 'review_required' ||
    s.auditError > 0 ||
    s.p0 > 0 ||
    (s.selfCheck?.fail ?? 0) > 0 ||
    s.settingsErrors.length > 0 ||
    s.memory.errors.length > 0 ||
    s.memory.reviewRequired.length > 0 ||
    s.memory.superseded
    // heldBack 不在此列：本章其余记忆已入库，只是个别条目待复核，
    // 把它算作返工会让每一章都标红，等于没有信号
  )
}

/**
 * 记忆候选复核面板。
 *
 * 写后同步每章都往 .cache/memory-candidates/ 落一份候选，此前没有任何地方读它——
 * 被挡下的条目落盘即失踪。这里把它读回来，并提供「重跑本章记忆同步」：
 * 重跑会重新提取一次证据，模型第二次引对原文的概率不低。
 */
/**
 * 单章逐条复核：展开后能看到每条候选、它的引文和未通过的原因，
 * 勾选后「确认属实，强制写入」——这是唯一绕开证据校验的口子，
 * 所以按钮走二次确认，且只对未通过的条目开放。
 */
function ChapterCandidateItems({
  projectId,
  chapterNumber,
  onApplied
}: {
  projectId: string
  chapterNumber: number
  onApplied: () => void
}) {
  const [detail, setDetail] = useState<MemoryCandidateDetail | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const load = (): void => {
    void window.api
      .inspectMemoryCandidate(projectId, chapterNumber)
      .then(setDetail)
      .catch((err) => setError((err as Error).message))
  }
  useEffect(load, [projectId, chapterNumber])

  const keyOf = (item: MemoryCandidateItem): string => `${item.kind}:${item.index}`
  const pending = (detail?.items ?? []).filter((item) => item.issues.length > 0 && !item.forced)

  const toggle = (item: MemoryCandidateItem): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      const k = keyOf(item)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const forceApply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const picks = pending
        .filter((item) => picked.has(keyOf(item)))
        .map((item) => ({ kind: item.kind, index: item.index }))
      const res = await window.api.forceApplyMemoryCandidateItems(projectId, chapterNumber, picks)
      setResult(`已强制写入 ${res.forcedCount} 条`)
      setPicked(new Set())
      setConfirming(false)
      load()
      onApplied()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!detail) return <p className="meta" style={{ fontSize: 12 }}>读取条目中…</p>

  return (
    <div style={{ marginTop: 6 }}>
      {error ? <div className="error-text">{error}</div> : null}
      {detail.stale ? (
        <div className="batch-chapter-summary-note">
          <span className="batch-chapter-summary-flag">
            正文在这份候选之后改过——它是旧稿提取的，强制写入会把旧稿结论写进记忆库。
            请先「重跑本章记忆同步」。
          </span>
        </div>
      ) : null}
      {detail.legacy ? (
        <div className="batch-chapter-summary-note">
          这是分级之前留下的旧记录，下面的原因分不出「整章」还是「单条」，重跑一次才准。
        </div>
      ) : null}
      {detail.chapterIssues.length > 0 ? (
        <div className="batch-chapter-summary-note">
          整章卡在正文本身的问题上，逐条强制写入也救不回来，先处理这些：
          {detail.chapterIssues.join('；')}
        </div>
      ) : null}
      <ul className="batch-last-result-list">
        {pending.map((item) => (
          <li key={keyOf(item)} style={{ fontSize: 12, padding: '3px 0' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={picked.has(keyOf(item))}
                onChange={() => toggle(item)}
                disabled={busy || detail.stale}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>{item.label}</strong>
                <span className="batch-chapter-summary-flag" style={{ marginLeft: 6 }}>
                  {item.issues.join('；')}
                </span>
                {item.evidence ? (
                  <span className="meta" style={{ display: 'block' }}>
                    引文：{item.evidence}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
        {detail.items.filter((item) => item.forced).map((item) => (
          <li key={keyOf(item)} className="meta" style={{ fontSize: 12 }}>
            · {item.label}：已由你确认写入
          </li>
        ))}
      </ul>
      {result ? <p className="meta" style={{ fontSize: 12 }}>{result}</p> : null}
      {pending.length > 0 ? (
        confirming ? (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="batch-chapter-summary-flag" style={{ fontSize: 12 }}>
              这 {picked.size} 条正文里找不到依据，写进记忆库后会成为后面所有章的前提。确定？
            </span>
            <button className="btn btn-primary" disabled={busy} onClick={() => void forceApply()}>
              {busy ? '写入中…' : '确定写入'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        ) : (
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 10px', fontSize: 12 }}
            disabled={picked.size === 0 || busy || detail.stale}
            onClick={() => setConfirming(true)}
            title="绕过证据校验，把选中的条目直接写进记忆库"
          >
            确认属实，强制写入{picked.size > 0 ? `（${picked.size} 条）` : ''}
          </button>
        )
      ) : null}
    </div>
  )
}

function MemoryCandidateDialog({
  projectId,
  onClose
}: {
  projectId: string
  onClose: () => void
}) {
  const [list, setList] = useState<MemoryCandidateSummary[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Record<number, string>>({})
  // 全部重跑的进度与中止开关：每章一次提取调用，跑到一半要能喊停
  const [bulk, setBulk] = useState<{ index: number; total: number } | null>(null)
  const stopBulkRef = useRef(false)
  // 展开哪一章的逐条明细（强制写入入口藏在里面，不默认展开）
  const [expanded, setExpanded] = useState<number | null>(null)

  const refresh = (): void => {
    void window.api
      .listMemoryCandidates(projectId)
      .then(setList)
      .catch((err) => {
        setError((err as Error).message)
        setList([])
      })
  }
  useEffect(refresh, [projectId])

  /**
   * 重跑一章：读回已保存正文，force 走一遍写后同步。
   * 重跑会重新提取一次证据——模型第二次引对原文的概率不低，
   * 仍不过的多半是正文里本来就没写实的推断。
   */
  const resyncOne = async (chapterNumber: number): Promise<void> => {
    const chapter = await window.api.getChapter(projectId, chapterNumber)
    if (!chapter.content.trim()) {
      setDone((prev) => ({ ...prev, [chapterNumber]: '正文为空，跳过' }))
      return
    }
    const sync = await window.api.syncChapterAfterWrite(
      projectId,
      chapterNumber,
      chapter.content,
      { force: true }
    )
    if (!sync) {
      setDone((prev) => ({ ...prev, [chapterNumber]: '未返回同步结果' }))
      return
    }
    const applied = Object.values(sync.memory.applied).reduce((a, b) => a + b, 0)
    const held = sync.memory.heldBack?.length ?? 0
    const blocked = sync.memory.reviewRequired?.length ?? 0
    setDone((prev) => ({
      ...prev,
      [chapterNumber]: blocked
        ? `整章仍待核对（${blocked} 项）`
        : `已写入 ${applied} 条${held ? `，仍有 ${held} 项证据不足` : ''}`
    }))
  }

  const resync = async (chapterNumber: number): Promise<void> => {
    setBusy(chapterNumber)
    setError(null)
    try {
      await resyncOne(chapterNumber)
      refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** 逐章串行重跑：并发打同一个项目的记忆文件会互相覆盖，必须一章一章来 */
  const resyncAll = async (): Promise<void> => {
    const targets = list ?? []
    if (targets.length === 0) return
    stopBulkRef.current = false
    setError(null)
    setBulk({ index: 0, total: targets.length })
    try {
      for (let i = 0; i < targets.length; i++) {
        if (stopBulkRef.current) break
        setBulk({ index: i + 1, total: targets.length })
        try {
          await resyncOne(targets[i].chapterNumber)
        } catch (err) {
          // 单章失败不该中断整批：记下来接着跑
          setDone((prev) => ({
            ...prev,
            [targets[i].chapterNumber]: `重跑失败：${(err as Error).message}`
          }))
        }
      }
    } finally {
      setBulk(null)
      stopBulkRef.current = false
      refresh()
    }
  }

  return (
    <div className="dialog-overlay" onClick={busy === null && bulk === null ? onClose : undefined}>
      <div
        className="dialog"
        style={{ width: 760, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>记忆待核对</h3>
        <p className="desc" style={{ margin: '0 0 12px' }}>
          这些条目因为找不到可定位的正文依据没有写进记忆库。先「全部重跑」——重跑会重新
          提取一次证据，引对了就自动入库。剩下的多半是正文里本来就没写实的推断：要么回正文
          补一笔，要么展开「逐条复核」，确认属实后强制写入。
        </p>
        {list && list.length > 0 ? (
          <div className="row" style={{ gap: 8, alignItems: 'center', margin: '0 0 10px' }}>
            <button
              className="btn btn-primary"
              onClick={() => void resyncAll()}
              disabled={bulk !== null || busy !== null}
              title={`逐章重新提取一次证据；共 ${list.length} 章，每章一次模型调用`}
            >
              {bulk ? `重跑中 ${bulk.index}/${bulk.total}…` : `全部重跑（${list.length} 章）`}
            </button>
            {bulk ? (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  stopBulkRef.current = true
                }}
              >
                跑完当前章后停下
              </button>
            ) : (
              <span className="meta" style={{ fontSize: 12 }}>
                每章一次提取调用
              </span>
            )}
          </div>
        ) : null}
        {error ? <div className="error-text">{error}</div> : null}
        {list === null ? (
          <p className="empty">读取中…</p>
        ) : list.length === 0 ? (
          <div className="placeholder">
            <p style={{ margin: 0, fontSize: 13 }}>没有待核对的候选，记忆都已入库。</p>
          </div>
        ) : (
          list.map((item) => (
            <div key={item.chapterNumber} className="batch-chapter-summary" style={{ margin: '8px 0' }}>
              <div className="batch-chapter-summary-head">
                <span>第 {item.chapterNumber} 章</span>
                <span className={item.status === 'pending' ? 'batch-chapter-summary-flag' : 'meta'}>
                  {item.status === 'pending'
                    ? `整章未入库（${item.chapterIssues.length} 项）`
                    : `${item.itemIssues.length} 项未写入，其余已入库`}
                </span>
              </div>
              <ul className="batch-last-result-list">
                {[...item.chapterIssues, ...item.itemIssues].slice(0, 8).map((reason, i) => (
                  <li key={i} style={{ fontSize: 12 }}>
                    · {reason}
                  </li>
                ))}
                {item.chapterIssues.length + item.itemIssues.length > 8 ? (
                  <li className="meta" style={{ fontSize: 12 }}>
                    …共 {item.chapterIssues.length + item.itemIssues.length} 项
                  </li>
                ) : null}
              </ul>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '2px 10px', fontSize: 12 }}
                  disabled={busy !== null || bulk !== null}
                  onClick={() => void resync(item.chapterNumber)}
                >
                  {busy === item.chapterNumber ? '重跑中…' : '重跑本章记忆同步'}
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '2px 10px', fontSize: 12 }}
                  disabled={bulk !== null}
                  onClick={() =>
                    setExpanded((cur) => (cur === item.chapterNumber ? null : item.chapterNumber))
                  }
                >
                  {expanded === item.chapterNumber ? '收起逐条' : '逐条复核'}
                </button>
                {done[item.chapterNumber] ? (
                  <span className="meta" style={{ fontSize: 12 }}>
                    {done[item.chapterNumber]}
                  </span>
                ) : null}
              </div>
              {expanded === item.chapterNumber ? (
                <ChapterCandidateItems
                  projectId={projectId}
                  chapterNumber={item.chapterNumber}
                  onApplied={refresh}
                />
              ) : null}
            </div>
          ))
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy !== null || bulk !== null}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 批量续写默认区间的起点：第一个未写章节，而不是「当前最大章号 + 1」。
 *
 * 细纲常常整卷一次性导入，未写章节不一定紧跟在最大章号后面——中间某章因失败/
 * 跳过没写的话，maxChapter+1 会直接跳过那个缺口，永远不会被自动补上。
 * 没有未写章节时（细纲已全部写完，或压根没导入细纲）才退回旧逻辑。
 *
 * unwrittenChapters 必须是升序；调用方（ChapterListPage）已排过序。
 */
export function resolveBatchDefaultRange(
  unwrittenChapters: number[],
  maxChapter: number,
  count: number,
  draftedChapters: Set<number> = new Set()
): { from: number; to: number } {
  const from = unwrittenChapters[0] ?? maxChapter + 1
  const requestedCount = Number.isSafeInteger(count) ? Math.min(MAX_BATCH_CHAPTERS, Math.max(1, count)) : 1
  const requestedTo = from + requestedCount - 1
  const nextDraft = [...draftedChapters].filter((chapter) => chapter >= from).sort((a, b) => a - b)[0]
  return { from, to: nextDraft === undefined ? requestedTo : Math.min(requestedTo, nextDraft - 1) }
}

/**
 * 区间内混进的已写章节号。遍历已有章号而非输入区间，极大输入也不会卡住界面。
 * 最多返回 20 条，够用来提示用户缩小续写范围。
 */
export function findOverwriteRisks(
  fromChapter: number,
  toChapter: number,
  draftedChapters: Set<number>
): number[] {
  return [...draftedChapters]
    .filter((chapter) => chapter >= fromChapter && chapter <= toChapter)
    .sort((a, b) => a - b)
    .slice(0, 20)
}

/** IPC 意外中断时保留已收到的逐章结果，重试从首个未完成章接续。 */
export function recoverBatchProgress(
  fromChapter: number,
  toChapter: number,
  completedChapters: number[],
  error: string,
  pendingPostProcessChapter?: number
): BatchProgress {
  const completed = [...new Set(completedChapters)]
    .filter((chapter) => chapter >= fromChapter && chapter <= toChapter)
    .sort((a, b) => a - b)
  let nextChapter = fromChapter
  const done = new Set(completed)
  while (nextChapter <= toChapter && done.has(nextChapter)) nextChapter++
  const pending = pendingPostProcessChapter ?? (nextChapter > toChapter ? toChapter : undefined)
  return {
    fromChapter,
    toChapter,
    total: toChapter - fromChapter + 1,
    current: completed.length,
    currentChapter: pending ?? Math.min(nextChapter, toChapter),
    status: pending !== undefined ? 'paused' : 'failed',
    completed,
    pendingPostProcessChapter: pending,
    error
  }
}

export interface SavedBatchSession {
  progress: BatchProgress
  autoContinue: boolean
  autoStrength: boolean
  styleProfileId: string | null
  /** 上次窗口离开时可能仍在生成/检查的章，恢复时核对磁盘。 */
  interruptedChapter?: number
}

/** 中断章未完成时重写该章；已完成章则继续下一章，待检查稿始终优先复用。 */
export function getBatchResumeChapter(progress: BatchProgress): number | null {
  const chapter = progress.pendingPostProcessChapter ?? (
    progress.completed.includes(progress.currentChapter) ? progress.currentChapter + 1 : progress.currentChapter
  )
  return chapter <= progress.toChapter ? chapter : null
}

/** 恢复记录也按范围契约校验，过期/损坏的浏览器存储不能成为续写参数。 */
export function parseSavedBatchSession(raw: string | null): SavedBatchSession | null {
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as SavedBatchSession
    const p = session.progress
    if (!p || !['paused', 'failed'].includes(p.status)) return null
    if (typeof session.autoContinue !== 'boolean' || typeof session.autoStrength !== 'boolean') return null
    if (session.styleProfileId !== null && typeof session.styleProfileId !== 'string') return null
    if (!Number.isSafeInteger(p.currentChapter) || p.currentChapter < p.fromChapter || p.currentChapter > p.toChapter) return null
    if (!Number.isSafeInteger(p.current) || p.current !== p.completed?.length) return null
    if (getBatchRangeError(p.fromChapter, p.toChapter)) return null
    if (getBatchRangeError(p.currentChapter, p.toChapter, p)) return null
    if (session.interruptedChapter !== undefined && (
      !Number.isSafeInteger(session.interruptedChapter) ||
      session.interruptedChapter < p.fromChapter || session.interruptedChapter > p.toChapter
    )) return null
    return session
  } catch {
    return null
  }
}

function readSavedBatchSession(projectId: string): SavedBatchSession | null {
  try {
    return parseSavedBatchSession(window.localStorage.getItem(`writer:batch:${projectId}`))
  } catch {
    return null
  }
}

function saveBatchSession(projectId: string, session: SavedBatchSession | null): void {
  try {
    const key = `writer:batch:${projectId}`
    if (!session || session.progress.status === 'completed') window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(session))
  } catch (err) {
    console.warn('[BatchWriteDialog] Failed to persist batch progress:', err)
  }
}

function BatchWriteDialog({
  projectId,
  chapters,
  maxChapter,
  unwrittenChapters,
  draftedChapters,
  preset,
  onClose,
  onChapterCompleted,
  onPolishBatch
}: {
  projectId: string
  chapters?: ChapterMeta[]
  maxChapter: number
  /** 升序的未写章节号（细纲/节奏表里存在但没正文）；用于定位真正的续写起点 */
  unwrittenChapters: number[]
  /** 已有正文的章号；选中区间若混进这些号，批量续写会静默覆盖已写内容 */
  draftedChapters: Set<number>
  /** 「一键写 N 章」入口带进来的预设：章数 + 是否连续写完 */
  preset?: { count: number; autoContinue: boolean }
  onClose: () => void
  onChapterCompleted: () => void
  onPolishBatch?: (range: BatchPolishRange) => void
}) {
  const [restoredSession] = useState(() => readSavedBatchSession(projectId))
  const [recovering, setRecovering] = useState(restoredSession?.interruptedChapter !== undefined)
  /**
   * 默认起点：第一个未写章节，而不是「当前最大章号 + 1」。
   * 细纲常常整卷一次导入，未写章节不一定紧跟在最大章号后面——中间某章
   * 因失败/跳过没写的话，maxChapter+1 会直接跳过那个缺口，永远补不上。
   * 没有未写章节（细纲已全部写完，或压根没导入细纲）时才退回旧逻辑。
   */
  const [defaultRange] = useState(() =>
    resolveBatchDefaultRange(unwrittenChapters, maxChapter, preset?.count ?? 3, draftedChapters)
  )
  // 用字符串保存输入：数字受控值会把清空立刻回显成 0，用户无法正常重新输入
  const [fromChapterStr, setFromChapterStr] = useState(String(restoredSession?.progress.fromChapter ?? defaultRange.from))
  const [toChapterStr, setToChapterStr] = useState(String(restoredSession?.progress.toChapter ?? defaultRange.to))
  const fromChapter = Number(fromChapterStr)
  const toChapter = Number(toChapterStr)
  const rangeError = getBatchRangeError(fromChapter, toChapter)
  const rangeValid = !rangeError
  /**
   * 未写章节不一定连续；提前提示夹在范围中的已有正文，让用户在生成前调整。
   */
  const overwriteWarning = useMemo(
    () =>
      Number.isSafeInteger(fromChapter) && Number.isSafeInteger(toChapter)
        ? findOverwriteRisks(fromChapter, toChapter, draftedChapters)
        : [],
    [fromChapter, toChapter, draftedChapters]
  )
  const [running, setRunning] = useState(false)
  // 连续模式：每章写完不停，一口气写到结束章号
  const [autoContinue, setAutoContinue] = useState(restoredSession?.autoContinue ?? preset?.autoContinue ?? false)
  const isOneClickTen = preset?.count === 10 && preset.autoContinue
  const strengthPreferenceKey = isOneClickTen
    ? 'ai-writer:auto-strength:one-click-ten'
    : 'ai-writer:auto-strength:batch'
  /** 按节奏自动调整生成强度默认开启；关闭后记住各入口自己的选择。 */
  const [autoStrength, setAutoStrength] = useState(
    restoredSession?.autoStrength ?? (localStorage.getItem(strengthPreferenceKey) !== 'false')
  )
  const [providerProtocol, setProviderProtocol] = useState<string | null>(null)
  const usesReasoningStrength = providerProtocol === 'codex' || providerProtocol === 'openai-responses' || providerProtocol === 'claude'
  const usesAgyTier = providerProtocol === 'antigravity'
  useEffect(() => {
    window.api?.listProviders?.().then((cfg) => {
      const routing = cfg.featureRouting?.chapter
      const routedId = routing?.providerId
      const baseProvider =
        cfg.providers?.find((p) => p.id === routedId) ??
        cfg.providers?.find((p) => p.id === cfg.activeId) ??
        cfg.providers?.[0] ??
        null
      setProviderProtocol(baseProvider?.protocol ?? 'openai')
    }).catch(() => {})
  }, [])

  const rangeChapters = useMemo(() => {
    if (!chapters || !Number.isSafeInteger(fromChapter) || !Number.isSafeInteger(toChapter) || fromChapter > toChapter) return []
    return chapters.filter((c) => c.chapterNumber >= fromChapter && c.chapterNumber <= toChapter)
  }, [chapters, fromChapter, toChapter])

  const rhythmStats = useMemo(() => {
    if (rangeChapters.length === 0) return null
    let withRhythm = 0
    let climaxCount = 0
    let transitionCount = 0
    for (const c of rangeChapters) {
      const hasRhythm = (c.emotion !== undefined && c.emotion > 0) || (c.climax !== undefined && c.climax > 0)
      if (hasRhythm) {
        withRhythm++
        if ((c.climax ?? 0) >= 3 || (c.emotion ?? 0) >= 9) climaxCount++
        else if ((c.emotion ?? 0) > 0 && (c.emotion ?? 0) <= 3 && (c.climax ?? 0) === 0) transitionCount++
      }
    }
    return {
      total: rangeChapters.length,
      withRhythm,
      climaxCount,
      transitionCount
    }
  }, [rangeChapters])
  /**
   * 限流退避等待的实时状态：撞上 429 时后端会自己等 30/60/120 秒重试，
   * 这段时间外表看起来像卡住了，必须把「正在等、不是卡死」显示出来。
   * resumeAt 是绝对时间戳，配合下面的 tick 做倒计时。
   */
  const [retryWait, setRetryWait] = useState<{
    chapter: number
    attempt: number
    maxAttempts: number
    resumeAt: number
  } | null>(null)
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0)
  useEffect(() => {
    if (!retryWait) return
    const tick = (): void =>
      setRetrySecondsLeft(Math.max(0, Math.ceil((retryWait.resumeAt - Date.now()) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [retryWait])
  const handleRetryWait = (chapter: number, attempt: number, maxAttempts: number, waitMs: number): void => {
    setRetryWait({ chapter, attempt, maxAttempts, resumeAt: Date.now() + waitMs })
  }
  const [progress, setProgress] = useState<BatchProgress | null>(restoredSession?.progress ?? null)
  // 运行中的实时进度：整批结果要等 promise 返回才有，连续写 10 章期间
  // 不自己记一份的话，界面上十几分钟都停在「0 / 10」，看着像卡死。
  const [liveCompleted, setLiveCompleted] = useState<number[]>([])
  const [liveChapter, setLiveChapter] = useState<number | null>(null)
  // 逐章小结：整批跑完后仍保留，供用户按章返工
  const [summaries, setSummaries] = useState<BatchChapterSummary[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  // 本次实际在跑的结束章号。不能拿输入框的 toChapter 当它用：暂停期间输入框可编辑，
  // 而 resume/retry 传给后端的是 progress.toChapter，两者会对不上（改大了界面谎报终点，
  // 清空了则算出 NaN）。
  const [activeTo, setActiveTo] = useState<number | null>(null)
  const [lastResult, setLastResult] = useState<ChapterFlowResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [generationStage, setGenerationStage] = useState<ChapterGenerationStage | null>(null)
  const [liveAutoDeslop, setLiveAutoDeslop] = useState<AutoDeslopResult | null>(null)
  const { projectData, styleProfiles } = useProjectStyleData(projectId)
  const [styleProfileId, setStyleProfileId] = useState<string | null>(restoredSession?.styleProfileId ?? null)
  // 当前批量运行的 requestId：「⏹ 停止」按钮用它 abortStream 中断当前章生成
  const batchRequestIdRef = useRef<string | null>(null)
  const interruptedChapterRef = useRef(restoredSession?.interruptedChapter)
  const [stopping, setStopping] = useState(false)
  // 切走页面/项目时结束本次批量任务，避免生成在失去停止入口后继续耗用请求。
  useEffect(() => () => {
    const requestId = batchRequestIdRef.current
    batchRequestIdRef.current = null
    if (requestId) void window.api.abortStream(requestId).catch(() => {})
  }, [])
  // 流式预览自动滚底：不滚的话超过容器高度后新 token 一直藏在滚动条下方，
  // 「正在生成…」看起来像卡住了
  const streamingBoxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = streamingBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [streamingText])

  const status = progress?.status ?? 'pending'
  const isFinished = status === 'completed' || status === 'failed'

  // 「上一章结果」与「逐章小结」共用同一份口径，避免两个面板对同一章说法不一
  const lastSummary = useMemo(
    () => (lastResult ? summarizeChapterResult(lastResult) : null),
    [lastResult]
  )
  const isPaused = status === 'paused'
  const pendingPostProcessChapter = progress?.pendingPostProcessChapter
  const resumeChapter = progress ? getBatchResumeChapter(progress) : null
  const resumeRewritesCurrent = progress !== null && pendingPostProcessChapter === undefined &&
    !progress.completed.includes(progress.currentChapter)
  const canResume = progress !== null && isPaused && resumeChapter !== null
  const rangeLocked = running || progress !== null

  // 展示用进度：运行中取实时计数，停下来后取后端返回的整批进度
  const displayCompleted = running ? liveCompleted : progress?.completed ?? []
  const displayTotal = progress?.total ?? (rangeValid ? toChapter - fromChapter + 1 : 0)
  const displayChapter = running ? liveChapter : progress?.currentChapter ?? null
  const displayStatus: BatchProgress['status'] = running
    ? generationStage === null ? 'flow' : 'generating'
    : status
  // 运行中以本次锁定的区间为准，没在跑时才回落到输入框
  const runningTo = activeTo ?? toChapter
  const issueSummaries = summaries.filter(hasChapterIssue)
  // 「没细纲」「对照没跑成」不算这一章写坏了，但抬头必须说出来，
  // 否则「无硬伤」会被读成"细纲也对过了"
  const noOutlineCount = summaries.filter((item) => item.outline === 'none').length
  const outlineFailedCount = summaries.filter((item) => item.outline === 'failed').length
  const heldBackTotal = summaries.reduce((n, item) => n + item.memory.heldBack.length, 0)
  const pendingEntitiesTotal = summaries.reduce((n, item) => n + item.memory.pending, 0)
  const autoDeslopAttentionCount = summaries.filter((item) =>
    item.autoDeslop?.status === 'failed' || item.autoDeslop?.status === 'review_required'
  ).length
  const [adoptingChapter, setAdoptingChapter] = useState<number | null>(null)
  const [adoptingAll, setAdoptingAll] = useState(false)

  const adoptChapterEntities = async (chapterNumber: number) => {
    try {
      setAdoptingChapter(chapterNumber)
      const res = await window.api.applyAllNewEntities(projectId, chapterNumber)
      setSummaries((prev) =>
        prev.map((item) => {
          if (item.chapter !== chapterNumber) return item
          const appliedEntities = (item.memory.appliedEntities ?? 0) + res.total
          return {
            ...item,
            memory: {
              ...item.memory,
              pending: Math.max(0, item.memory.pending - res.total),
              appliedEntities
            }
          }
        })
      )
    } catch (err) {
      alert(`采纳失败: ${(err as Error).message}`)
    } finally {
      setAdoptingChapter(null)
    }
  }

  const adoptAllPendingEntities = async () => {
    const targets = summaries.filter((s) => s.memory.pending > 0)
    if (!targets.length) return
    try {
      setAdoptingAll(true)
      for (const target of targets) {
        try {
          const res = await window.api.applyAllNewEntities(projectId, target.chapter)
          setSummaries((prev) =>
            prev.map((item) => {
              if (item.chapter !== target.chapter) return item
              const appliedEntities = (item.memory.appliedEntities ?? 0) + res.total
              return {
                ...item,
                memory: {
                  ...item.memory,
                  pending: Math.max(0, item.memory.pending - res.total),
                  appliedEntities
                }
              }
            })
          )
        } catch (err) {
          console.warn(`第 ${target.chapter} 章采纳失败:`, err)
        }
      }
    } finally {
      setAdoptingAll(false)
    }
  }

  useEffect(() => {
    if (progress && !running && !recovering) {
      saveBatchSession(projectId, {
        progress, autoContinue, autoStrength, styleProfileId,
        interruptedChapter: interruptedChapterRef.current
      })
    }
  }, [projectId, progress, autoContinue, autoStrength, styleProfileId, running, recovering])

  useEffect(() => {
    const chapter = restoredSession?.interruptedChapter
    if (chapter === undefined || !restoredSession) return
    let alive = true
    void window.api.getChapter(projectId, chapter)
      .then((saved) => {
        if (!alive) return
        if (saved.content.trim()) {
          const previous = restoredSession.progress
          setProgress(recoverBatchProgress(
            previous.fromChapter, previous.toChapter, [...previous.completed, chapter],
            '已找到上次保存的正文，将补跑本章检查。', chapter
          ))
        }
        interruptedChapterRef.current = undefined
        setRecovering(false)
      })
      .catch((err) => {
        if (alive) setError(`恢复章节状态失败：${err instanceof Error ? err.message : String(err)}。请关闭后重新打开以重试核对。`)
      })
    return () => { alive = false }
  }, [projectId, restoredSession])

  /**
   * 每章完成时推进实时进度并记下小结：连续模式下整批 promise 要几十分钟后才返回。
   * rangeTo 由调用方在发起时锁定后传入，不读输入框状态（闭包里读到的会是发起那一刻的旧值）。
   */
  const markChapterDone = (chapter: number, rangeTo: number, result: ChapterFlowResult): void => {
    setLiveCompleted((prev) => (prev.includes(chapter) ? prev : [...prev, chapter]))
    setLiveChapter(Math.min(chapter + 1, rangeTo))
    const chMeta = chapters?.find((c) => c.chapterNumber === chapter)
    const suggestion = autoStrength ? suggestChapterStrength(chMeta) : undefined
    setSummaries((prev) =>
      // 重试同一章时替换旧小结，而不是留两条
      [...prev.filter((item) => item.chapter !== chapter), summarizeChapterResult(result, suggestion)].sort(
        (a, b) => a.chapter - b.chapter
      )
    )
    // 这一章写完了，之前显示的「限流重试中」状态（如果有）已经不适用
    setRetryWait(null)
    setGenerationStage(null)
    setLiveAutoDeslop(null)
  }

  const runBatch = async (mode: 'start' | 'resume' | 'retry') => {
    // ref 在同一事件周期立即上锁，防止 React 尚未更新 disabled 时重复启动。
    if (batchRequestIdRef.current || recovering) return
    if (mode === 'start') {
      if (!rangeValid) {
        setError(rangeError)
        return
      }
      if (overwriteWarning.length > 0) {
        setError('续写范围包含已有正文，请缩小范围；需要重写时请打开对应章节。')
        return
      }
    } else if (!progress) {
      return
    }

    const previous = mode === 'start' ? null : progress
    const pendingChapter = previous?.pendingPostProcessChapter
    const runFrom = previous
      ? mode === 'resume' ? getBatchResumeChapter(previous) : pendingChapter ?? previous.currentChapter
      : fromChapter
    const rangeFrom = previous?.fromChapter ?? fromChapter
    const rangeTo = previous?.toChapter ?? toChapter
    if (runFrom === null || runFrom > rangeTo) return
    const completed = [...(previous?.completed ?? [])]
    let lastReportedChapter: number | undefined
    const requestId = crypto.randomUUID()
    batchRequestIdRef.current = requestId
    const persistProgress = (next: BatchProgress, interruptedChapter?: number): void => {
      interruptedChapterRef.current = interruptedChapter
      saveBatchSession(projectId, { progress: next, autoContinue, autoStrength, styleProfileId, interruptedChapter })
    }
    persistProgress(previous ?? recoverBatchProgress(rangeFrom, rangeTo, [], '上次生成已中断，可重试当前章。'), runFrom)
    setRunning(true)
    setStopping(false)
    setError(null)
    setStreamingText('')
    setGenerationStage('generating')
    setLiveAutoDeslop(null)
    setRetryWait(null)
    setLiveCompleted(completed)
    setLiveChapter(runFrom)
    setActiveTo(rangeTo)
    if (mode === 'start') {
      setProgress(null)
      setLastResult(null)
      setSummaries([])
    }
    const recover = (message: string): void => {
      // 回调只能保证正文已存；缺少最终进度时保留检查重试，避免跳过未完成的检查。
      const recovered = recoverBatchProgress(
        rangeFrom, rangeTo, completed, message, lastReportedChapter ?? pendingChapter
      )
      persistProgress(recovered, interruptedChapterRef.current)
      setProgress(recovered)
    }
    try {
      const invoke = mode === 'resume' ? window.api.resumeBatch : window.api.generateBatch
      const res = await invoke(
        projectId,
        mode === 'resume' ? previous!.currentChapter : runFrom,
        rangeTo,
        styleProfileId,
        (chapter, result) => {
          if (batchRequestIdRef.current !== requestId) return
          if (!completed.includes(chapter)) completed.push(chapter)
          lastReportedChapter = chapter
          // 此时正文已保存；最终 progress 到达前保守保留该章检查恢复点。
          persistProgress(recoverBatchProgress(
            rangeFrom, rangeTo, completed, '正文已保存，上次检查流程中断，可补跑本章检查。', chapter
          ), Math.min(chapter + 1, rangeTo))
          setLastResult(result)
          onChapterCompleted()
          setStreamingText('')
          markChapterDone(chapter, rangeTo, result)
        },
        (token, done) => {
          if (batchRequestIdRef.current !== requestId) return
          if (!done && token) {
            setRetryWait(null)
            setStreamingText((prev) => prev + token)
          }
        },
        requestId,
        previous
          ? {
              fromChapter: previous.fromChapter,
              total: previous.total,
              completed: previous.completed,
              pendingPostProcessChapter: previous.pendingPostProcessChapter
            }
          : undefined,
        autoContinue,
        autoStrength,
        (chapter, attempt, maxAttempts, waitMs) => {
          if (batchRequestIdRef.current !== requestId) return
          setStreamingText('')
          setLiveChapter(chapter)
          handleRetryWait(chapter, attempt, maxAttempts, waitMs)
        },
        (stage, chapterNumber) => {
          if (batchRequestIdRef.current !== requestId) return
          setGenerationStage(stage)
          setLiveChapter(chapterNumber)
          setRetryWait(null)
          if (stage === 'generating') {
            setStreamingText('')
            setLiveAutoDeslop(null)
          }
        },
        (result, chapterNumber) => {
          if (batchRequestIdRef.current !== requestId) return
          setGenerationStage(null)
          setLiveChapter(chapterNumber)
          setLiveAutoDeslop(result)
        }
      )
      if (batchRequestIdRef.current !== requestId) return
      if (res.progress) {
        persistProgress(res.progress)
        setProgress(res.progress)
      } else {
        recover(res.error ?? '批量续写未返回进度，请检查当前章节后重试')
      }
    } catch (err) {
      if (batchRequestIdRef.current === requestId) {
        recover(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (batchRequestIdRef.current === requestId) {
        setRunning(false)
        setStopping(false)
        setStreamingText('')
        setRetryWait(null)
        setGenerationStage(null)
        setLiveAutoDeslop(null)
        batchRequestIdRef.current = null
        onChapterCompleted()
      }
    }
  }

  const startBatch = () => runBatch('start')
  const resumeBatch = () => runBatch('resume')
  const retryBatch = () => runBatch('retry')

  const endBatch = () => {
    if (batchRequestIdRef.current) return
    saveBatchSession(projectId, null)
    onClose()
  }

  const stopBatch = () => {
    const id = batchRequestIdRef.current
    if (!id || stopping) return
    setStopping(true)
    void window.api.abortStream(id)
      .then((result) => {
        if (!result.ok && batchRequestIdRef.current === id) {
          setStopping(false)
          setError('停止请求未生效，请重试。')
        }
      })
      .catch((err) => {
        if (batchRequestIdRef.current !== id) return
        setStopping(false)
        setError(`停止失败：${err instanceof Error ? err.message : String(err)}`)
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
      <div
        className="dialog"
        style={{ width: 760, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{isOneClickTen ? '一键写章节' : '批量续写'}</h3>
        {restoredSession ? (
          <p className="meta">
            {recovering ? '正在核对上次批次的正文保存情况…' : '已恢复上次未结束的批次；已保存的正文会保留。'}
          </p>
        ) : null}
        <p className="desc" style={{ margin: '0 0 12px' }}>
          逐章生成正文，自动去 AI 味并核对事实；发现差异会自动修复，最多两轮。随后跑质检、细纲对照和记忆同步。
          {autoContinue
            ? '连续模式：逐章写到结束章号，以正文为准——每章写完先按正文回写本章及后续细纲，再重跑自检、同步记忆，下一章对着更新后的细纲和记忆写。仅细纲缺失或同步失败时暂停，已保存的正文保留，可随时点停止。'
            : '每章完成后暂停等你确认。'}
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

        {!progress && defaultRange.from <= maxChapter ? (
          <p className="meta" style={{ fontSize: 12, margin: '0 0 8px' }}>
            默认从最早未写的第 {defaultRange.from} 章开始。
            {defaultRange.to - defaultRange.from + 1 < (preset?.count ?? 3)
              ? ` 后面已有正文，已缩为 ${defaultRange.to - defaultRange.from + 1} 章，避免覆盖。`
              : ''}
          </p>
        ) : null}

        <div className="field-row">
          <div className="field" style={{ flex: 1 }}>
            <label>起始章号</label>
            <input
              className="input"
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              value={fromChapterStr}
              onChange={(e) => setFromChapterStr(e.target.value)}
              disabled={rangeLocked}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>结束章号</label>
            <input
              className="input"
              type="number"
              min={Number.isInteger(fromChapter) ? fromChapter : 1}
              max={Number.isSafeInteger(fromChapter) ? Math.min(Number.MAX_SAFE_INTEGER, fromChapter + MAX_BATCH_CHAPTERS - 1) : undefined}
              value={toChapterStr}
              onChange={(e) => setToChapterStr(e.target.value)}
              disabled={rangeLocked}
            />
          </div>
        </div>

        {!progress && overwriteWarning.length > 0 ? (
          <div className="batch-chapter-summary-note" style={{ marginBottom: 8 }}>
            <span className="batch-chapter-summary-flag">
              第 {overwriteWarning.slice(0, 20).join('、')}
              {overwriteWarning.length >= 20 ? '…' : ''} 章已有正文，请缩小续写范围。
              如需重写，请打开对应章节操作。
            </span>
          </div>
        ) : null}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="meta" style={{ fontSize: 12 }}>写几章：</span>
          {[1, 3, 5, 10, 20].map((n) => (
            <button
              key={n}
              type="button"
              className="btn btn-ghost"
              style={{ padding: '2px 10px', fontSize: 12 }}
              disabled={rangeLocked || !Number.isSafeInteger(fromChapter) || fromChapter < 1}
              onClick={() => setToChapterStr(String(fromChapter + n - 1))}
            >
              {n} 章
            </button>
          ))}
          {rangeValid ? (
            <span className="meta" style={{ fontSize: 12 }}>
              共 {toChapter - fromChapter + 1} 章
            </span>
          ) : null}
        </div>

        {!rangeLocked && rangeError ? <div className="error-text">{rangeError}</div> : null}
        {rangeLocked ? (
          <p className="meta" style={{ fontSize: 12 }}>
            {status === 'completed'
              ? '本批已结束。关闭后可重新选择续写范围。'
              : '本批范围已固定，关闭会保留进度；如需另选范围，请先点「结束本批」。'}
          </p>
        ) : null}

        <label
          className="row"
          style={{ gap: 8, alignItems: 'flex-start', margin: '10px 0 4px', cursor: running ? 'default' : 'pointer' }}
        >
          <input
            type="checkbox"
            checked={autoContinue}
            onChange={(e) => setAutoContinue(e.target.checked)}
            disabled={running}
            style={{ marginTop: 3 }}
          />
          <span>
            连续写作，以正文为准更新细纲和记忆
            <span className="meta" style={{ display: 'block', fontSize: 12 }}>
              每章正文保存后，所有细纲差异（含漏写、P0、卷级变化）都按正文回写并校准后续细纲，记忆按正文同步（不受自动记忆开关影响）。剩余的正文自检提示只记在逐章小结里；细纲缺失或同步失败时暂停。可随时点「⏹ 停止」。
            </span>
          </span>
        </label>

        <label
          className="row"
          style={{ gap: 8, alignItems: 'flex-start', margin: '0 0 10px', cursor: running ? 'default' : 'pointer' }}
        >
          <input
            type="checkbox"
            checked={autoStrength}
            onChange={(e) => {
              setAutoStrength(e.target.checked)
              localStorage.setItem(strengthPreferenceKey, String(e.target.checked))
            }}
            disabled={running}
            style={{ marginTop: 3 }}
          />
          <span>
            {isOneClickTen ? '一键写作按节奏自动调强度' : '批量续写按节奏自动调强度'}
            <span className="meta" style={{ display: 'block', fontSize: 12 }}>
              大高潮/高情绪的章自动提高生成强度，平淡过渡章自动调低，逐章不同。
              只在生成这一章时临时生效，不会像编辑器里「采用建议」那样改掉你保存的默认设置；
              Codex / OpenAI Responses / Claude Code 调整思考强度，AGY 切换本机可用的同系列模型档位，OpenAI / Anthropic 调整温度；Grok 按当前配置生成。
            </span>
          </span>
        </label>

        {autoStrength ? (
          <div
            style={{
              margin: '-4px 0 10px 24px',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              backgroundColor: 'rgba(0, 0, 0, 0.03)',
              border: '1px solid rgba(128, 128, 128, 0.18)',
              lineHeight: 1.5
            }}
          >
            {providerProtocol === 'grok' ? (
              <span className="meta">
                ℹ️ 当前正文模型通道（{providerProtocol.toUpperCase()}）不支持单次调整生成强度，本批将使用当前配置。
              </span>
            ) : rhythmStats && rhythmStats.withRhythm === 0 ? (
              <span style={{ color: '#d97706' }}>
                ⚠️ 所选范围（第 {fromChapter}~{toChapter} 章）暂无细纲/节奏标注，每章将使用默认稳态生成（{usesAgyTier ? '建议 AGY Medium 档，缺档保持当前模型' : usesReasoningStrength ? '思考强度 medium' : '温度 0.8'}）。
              </span>
            ) : rhythmStats ? (
              <span className="meta">
                💡 节奏预检：所选 {rhythmStats.total} 章中有 {rhythmStats.withRhythm} 章具备节奏数据
                {rhythmStats.climaxCount > 0 ? `（${rhythmStats.climaxCount} 章大高潮${usesAgyTier ? '建议 AGY High 档' : usesReasoningStrength ? '调至 high' : '拉高温度 1.0'}` : ''}
                {rhythmStats.transitionCount > 0 ? `，${rhythmStats.transitionCount} 章过渡章${usesAgyTier ? '建议 AGY Low 档' : usesReasoningStrength ? '调至 low' : '调低至 0.6'}` : ''}
                {rhythmStats.climaxCount > 0 || rhythmStats.transitionCount > 0 ? '）' : ''}，其余常规推进（{usesAgyTier ? '建议 Medium 档，缺档保持当前模型' : usesReasoningStrength ? 'medium' : '0.8'}）。
              </span>
            ) : null}
          </div>
        ) : null}

        {progress || running ? (
          <div className="batch-progress">
            <div className="batch-progress-head">
              <span className={`chip status-${displayStatus}`}>
                {running && generationStage === 'deslop'
                  ? '自动去 AI 味中'
                  : running && generationStage === null
                    ? '写后检查中'
                    : statusLabel[displayStatus]}
              </span>
              <span className="batch-progress-count">
                {displayCompleted.length} / {displayTotal} 章已保存
              </span>
            </div>
            {displayChapter ? (
              <div className="batch-progress-current">
                <div>
                  当前：第 {displayChapter} 章
                  {running && autoContinue && displayChapter < runningTo
                    ? `（写完自动接着写到第 ${runningTo} 章）`
                    : ''}
                </div>
                {autoStrength ? (() => {
                  const chMeta = chapters?.find((c) => c.chapterNumber === displayChapter)
                  const suggestion = suggestChapterStrength(chMeta)
                  const isHigh = suggestion.effort === 'high'
                  const isLow = suggestion.effort === 'low'
                  const badgeIcon = isHigh ? '🔥' : isLow ? '🌱' : '⚖️'
                  const badgeName = usesAgyTier
                    ? isHigh ? '大高潮 · AGY High' : isLow ? '过渡章 · AGY Low' : '常规推进 · AGY Medium'
                    : usesReasoningStrength
                    ? isHigh ? '大高潮 · 思考 high' : isLow ? '过渡章 · 思考 low' : '常规推进 · 思考 medium'
                    : isHigh ? '大高潮 · 温度 1.0' : isLow ? '过渡章 · 温度 0.6' : '常规推进 · 温度 0.8'
                  return (
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 4,
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        backgroundColor: isHigh ? 'rgba(239, 68, 68, 0.12)' : isLow ? 'rgba(59, 130, 246, 0.12)' : 'rgba(156, 163, 175, 0.12)',
                        color: isHigh ? '#ef4444' : isLow ? '#3b82f6' : 'var(--ink-2)',
                        border: `1px solid ${isHigh ? 'rgba(239, 68, 68, 0.25)' : isLow ? 'rgba(59, 130, 246, 0.25)' : 'rgba(156, 163, 175, 0.25)'}`
                      }}
                    >
                      <span>{badgeIcon} <b>{badgeName}</b></span>
                      <span style={{ opacity: 0.85 }}>（{suggestion.reason}）</span>
                    </div>
                  )
                })() : null}
              </div>
            ) : null}
            {running && liveAutoDeslop ? (
              <div className={liveAutoDeslop.status === 'failed' || liveAutoDeslop.status === 'review_required' ? 'batch-progress-reason' : 'meta'} role="status">
                {liveAutoDeslop.message}
              </div>
            ) : null}
            {running && retryWait ? (
              <div className="batch-progress-reason">
                第 {retryWait.chapter} 章遇到限流（LLM_RATE_LIMIT），
                {retrySecondsLeft > 0
                  ? `${retrySecondsLeft} 秒后自动重试`
                  : '正在重试'}
                （第 {retryWait.attempt}/{retryWait.maxAttempts} 次），无需手动操作
              </div>
            ) : null}
            {!running && progress?.pauseReason ? (
              <div className="batch-progress-reason">{progress.pauseReason}</div>
            ) : null}
            {!running && progress?.error ? (
              <div className="batch-progress-error">
                {progress.error.includes('LLM_ABORTED')
                  ? pendingPostProcessChapter !== undefined
                    ? `正文已保存，检查已停止，可重试第 ${pendingPostProcessChapter} 章检查。`
                    : `已停止生成（可点「重试第 ${progress.currentChapter} 章」继续）`
                  : progress.error}
              </div>
            ) : null}
            {displayCompleted.length > 0 ? (
              <div className="batch-progress-completed">
                已保存章节：{displayCompleted.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}

        {streamingText ? (
          <div className="batch-streaming" ref={streamingBoxRef}>
            <div className="batch-streaming-head">
              {generationStage === 'deslop'
                ? '正文已生成，正在自动去 AI 味…'
                : generationStage === null ? '正文预览，正在写后检查…' : '正在生成…'}
            </div>
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
              <li className={lastSummary?.autoDeslop?.status === 'failed' || lastSummary?.autoDeslop?.status === 'review_required' ? 'batch-last-result-warn' : undefined}>
                {lastSummary ? describeAutoDeslopCell(lastSummary) : ''}
              </li>
              <li>
                质检：
                {lastSummary && lastSummary.auditError > 0
                  ? `${lastSummary.auditError} 错误`
                  : lastSummary && lastSummary.auditWarn > 0
                    ? `${lastSummary.auditWarn} 警告`
                    : '通过'}
              </li>
              <li>
                细纲：{lastSummary ? describeOutlineCell(lastSummary) : ''}
                {lastSummary?.outline === 'checked' && lastResult.outlineDiff.diffs.length > 0
                  ? `（共 ${lastResult.outlineDiff.diffs.length} 项差异）`
                  : ''}
              </li>
              <li title={lastSummary?.selfCheck?.failedItems.join('、') || undefined}>
                写后自检：{lastSummary ? describeSelfCheckCell(lastSummary) : ''}
                {lastSummary?.selfCheck && lastSummary.selfCheck.failedItems.length > 0
                  ? `（${lastSummary.selfCheck.failedItems.join('、')}）`
                  : ''}
              </li>
              <li title={lastSummary?.memory.reviewRequired.join('；') || undefined}>
                {lastSummary ? describeMemoryCell(lastSummary) : ''}
                ：角色 {lastResult.memory.newCharacters.length} / 地点{' '}
                {lastResult.memory.newLocations.length} / 伏笔{' '}
                {lastResult.memory.newForeshadowings.length} / 状态变化{' '}
                {lastResult.memory.characterStateChanges.length}
              </li>
              <li>章节概要：{lastSummary?.summaryReady ? '已生成' : '待补跑'}</li>
              {lastSummary && lastSummary.memory.reviewRequired.length > 0 ? (
                <li className="batch-last-result-warn">
                  整章待核对：{lastSummary.memory.reviewRequired.join('；')}
                </li>
              ) : null}
              {lastSummary && lastSummary.memory.heldBack.length > 0 ? (
                <li className="batch-last-result-warn">
                  未写入的条目：{lastSummary.memory.heldBack.join('；')}
                </li>
              ) : null}
              {lastSummary && (lastSummary.memory.errors.length > 0 || lastSummary.settingsErrors.length > 0) ? (
                <li className="batch-last-result-warn">
                  同步失败：{[...lastSummary.memory.errors, ...lastSummary.settingsErrors].join('；')}
                </li>
              ) : null}
              <li>节奏 / 图解：批量模式不评估，需要时在单章流程面板中单独运行</li>
            </ul>
          </div>
        ) : null}

        {summaries.length > 0 ? (
          <div className="batch-chapter-summary">
            <div className="batch-chapter-summary-head">
              <span>逐章小结</span>
              <span className={issueSummaries.length > 0 ? 'batch-chapter-summary-flag' : 'meta'}>
                {issueSummaries.length > 0
                  ? `${issueSummaries.length} 章需要返工：${issueSummaries
                      .map((item) => `第 ${item.chapter} 章`)
                      .join('、')}`
                  : '未发现需返工的问题，检查执行情况见下方'}
              </span>
            </div>
            {noOutlineCount > 0 || outlineFailedCount > 0 || heldBackTotal > 0 || pendingEntitiesTotal > 0 || autoDeslopAttentionCount > 0 ? (
              <div className="batch-chapter-summary-note" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                {[
                  noOutlineCount > 0 ? `${noOutlineCount} 章没有细纲可对照（自由发挥）` : '',
                  outlineFailedCount > 0 ? `${outlineFailedCount} 章细纲对照没跑成` : '',
                  autoDeslopAttentionCount > 0 ? `${autoDeslopAttentionCount} 章去 AI 味未通过，已保留生成原稿，可批量重试` : '',
                  heldBackTotal > 0 ? `共 ${heldBackTotal} 条记忆证据不足未写入` : '',
                  pendingEntitiesTotal > 0 ? `共 ${pendingEntitiesTotal} 项新实体待确认` : ''
                ]
                  .filter(Boolean)
                  .join(' · ')}
                {autoDeslopAttentionCount > 0 && onPolishBatch ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={running}
                    onClick={() => onPolishBatch({
                      from: Math.min(...summaries.map((item) => item.chapter)),
                      to: Math.max(...summaries.map((item) => item.chapter))
                    })}
                    title="检查本批次已保存的正文并重新润色，自动核对和修复事实差异"
                  >
                    批量重试去 AI 味
                  </button>
                ) : null}
                {heldBackTotal > 0 ? (
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '0 8px', fontSize: 12, marginLeft: 8 }}
                    onClick={() => setShowCandidates(true)}
                  >
                    复核未写入的记忆
                  </button>
                ) : null}
                {pendingEntitiesTotal > 0 ? (
                  <button
                    className="btn btn-ghost"
                    style={{
                      padding: '1px 8px',
                      fontSize: 12,
                      marginLeft: 8,
                      color: '#2563eb',
                      borderColor: 'rgba(37, 99, 235, 0.35)',
                      backgroundColor: 'rgba(37, 99, 235, 0.08)'
                    }}
                    disabled={adoptingAll || adoptingChapter !== null}
                    onClick={adoptAllPendingEntities}
                    title="以正文为主：一键将全部章节中待确认的新增角色、地点、道具、伏笔自动入库"
                  >
                    {adoptingAll ? '正在批量采纳…' : `⚡ 一键采纳全部新增（${pendingEntitiesTotal} 项）`}
                  </button>
                ) : null}
              </div>
            ) : null}
            <ul className="batch-chapter-summary-list">
              {summaries.map((item) => {
                const suggestion = item.strengthSuggestion ?? (autoStrength ? suggestChapterStrength(chapters?.find((c) => c.chapterNumber === item.chapter)) : undefined)
                const isHigh = suggestion?.effort === 'high'
                const isLow = suggestion?.effort === 'low'
                return (
                  <li key={item.chapter} className={hasChapterIssue(item) ? 'has-issue' : ''}>
                    <span className="batch-chapter-summary-no" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      第 {item.chapter} 章
                      {suggestion ? (
                        <span
                          className="chip"
                          style={{
                            fontSize: 10,
                            padding: '0 5px',
                            lineHeight: '16px',
                            height: '18px',
                            backgroundColor: isHigh ? 'rgba(239, 68, 68, 0.1)' : isLow ? 'rgba(59, 130, 246, 0.1)' : 'rgba(156, 163, 175, 0.1)',
                            color: isHigh ? '#ef4444' : isLow ? '#3b82f6' : 'var(--ink-2)',
                            borderColor: isHigh ? 'rgba(239, 68, 68, 0.25)' : isLow ? 'rgba(59, 130, 246, 0.25)' : 'rgba(156, 163, 175, 0.25)'
                          }}
                          title={`生成强度：${suggestion.reason}（${usesAgyTier ? `AGY ${suggestion.tier} 档，缺档保持当前模型` : usesReasoningStrength ? `思考 ${suggestion.effort}` : `温度 ${suggestion.temperature}`}）`}
                        >
                          {usesAgyTier
                            ? isHigh ? '🔥 High 高潮' : isLow ? '🌱 Low 过渡' : '⚖️ Medium 常规'
                            : usesReasoningStrength
                            ? isHigh ? '🔥 high 高潮' : isLow ? '🌱 low 过渡' : '⚖️ medium 常规'
                            : isHigh ? '🔥 1.0 高潮' : isLow ? '🌱 0.6 过渡' : '⚖️ 0.8 常规'}
                        </span>
                      ) : null}
                    </span>
                    <span>{item.words} 字</span>
                    <span title={[item.autoDeslop?.message, ...(item.autoDeslop?.issues ?? [])].filter(Boolean).join('；')} style={{ color: item.autoDeslop?.status === 'failed' || item.autoDeslop?.status === 'review_required' ? 'var(--warn)' : undefined }}>
                      {describeAutoDeslopCell(item)}
                      {item.autoDeslop?.status !== 'applied' && (item.autoDeslop?.repairAttempts ?? 0) > 0 ? `（已自动修复 ${item.autoDeslop!.repairAttempts} 次）` : ''}
                    </span>
                    {item.autoDeslop?.issues?.length ? (
                      <span style={{ color: 'var(--warn)' }}>{item.autoDeslop.issues.join('；')}</span>
                    ) : null}
                   <span>{item.summaryReady ? '概要已生成' : '概要待补'}</span>
                  <span>
                    {item.auditError > 0
                      ? `质检 ${item.auditError} 错误`
                      : item.auditWarn > 0
                        ? `质检 ${item.auditWarn} 警告`
                        : '质检通过'}
                  </span>
                  <span>{describeOutlineCell(item)}</span>
                  <span title={item.selfCheck?.failedItems.join('、') || undefined}>
                    {describeSelfCheckCell(item)}
                  </span>
                  <span title={item.memory.reviewRequired.join('；') || undefined}>
                    {describeMemoryCell(item)}
                    {item.memory.pending > 0 ? (
                      <button
                        className="btn btn-ghost"
                        style={{
                          fontSize: 11,
                          padding: '1px 6px',
                          height: 20,
                          marginLeft: 6,
                          color: '#2563eb',
                          borderColor: 'rgba(37, 99, 235, 0.35)',
                          backgroundColor: 'rgba(37, 99, 235, 0.08)'
                        }}
                        disabled={adoptingChapter === item.chapter || adoptingAll}
                        onClick={() => adoptChapterEntities(item.chapter)}
                        title="以正文为主：将本章识别出的新角色、地点、道具、伏笔自动入库"
                      >
                        {adoptingChapter === item.chapter ? '采纳中…' : '⚡ 一键采纳'}
                      </button>
                    ) : null}
                  </span>
                  {item.settingsErrors.length > 0 ? (
                    <span title={item.settingsErrors.join('；')}>设定同步失败 {item.settingsErrors.length} 项</span>
                  ) : null}
                </li>
              )
            })}
            </ul>
          </div>
        ) : null}

        {error ? <div className="error-text">{error}</div> : null}

        {showCandidates ? (
          <MemoryCandidateDialog projectId={projectId} onClose={() => setShowCandidates(false)} />
        ) : null}

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
          {progress && !running && status !== 'completed' ? (
            <button className="btn btn-ghost" onClick={endBatch} disabled={recovering}>
              结束本批
            </button>
          ) : null}
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            {progress ? (isFinished && status === 'completed' ? '关闭' : '关闭并保留进度') : '取消'}
          </button>
          {!progress || status === 'pending' ? (
            <button
              className="btn btn-primary"
              onClick={startBatch}
              disabled={running || recovering || !rangeValid || overwriteWarning.length > 0}
            >
              {running
                ? '生成中…'
                : autoContinue && rangeValid
                  ? `一键写 ${toChapter - fromChapter + 1} 章`
                  : '开始批量续写'}
            </button>
          ) : canResume ? (
            <button
              className="btn btn-primary"
              onClick={resumeBatch}
              disabled={running || recovering}
              title={
                pendingPostProcessChapter !== undefined
                  ? `保留第 ${pendingPostProcessChapter} 章正文，重新执行检查和同步流程`
                  : resumeRewritesCurrent
                  ? `继续将重新生成第 ${resumeChapter} 章并自动去 AI 味`
                  : autoContinue
                  ? `从第 ${resumeChapter} 章继续写到第 ${progress?.toChapter ?? ''} 章，重要问题时暂停`
                  : '生成下一章后再次暂停'
              }
            >
              {running
                ? '生成中…'
                : pendingPostProcessChapter !== undefined
                  ? `重试第 ${pendingPostProcessChapter} 章检查`
                  : resumeRewritesCurrent
                  ? `重新生成第 ${resumeChapter} 章`
                  : autoContinue
                  ? `继续写到第 ${progress?.toChapter ?? ''} 章`
                  : '继续下一章'}
            </button>
          ) : status === 'failed' ? (
            <button
              className="btn btn-primary"
              onClick={retryBatch}
              disabled={running || recovering}
              title={
                autoContinue
                  ? `重新生成第 ${progress?.currentChapter ?? ''} 章，然后继续写到第 ${progress?.toChapter ?? ''} 章；已完成的章节保留`
                  : '重新生成失败的这一章；已完成的章节保留'
              }
            >
              {running
                ? '生成中…'
                : autoContinue
                  ? `重试第 ${progress?.currentChapter ?? ''} 章并写到第 ${progress?.toChapter ?? ''} 章`
                  : `重试第 ${progress?.currentChapter ?? ''} 章`}
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
