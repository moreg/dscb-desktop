import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createBufferedText } from '../../shared/buffered-text'
import './fanqie-chart.css'
import {
  FANQIE_CHART_TYPES,
  fanqieCategoriesFor,
  formatFanqieReadCount,
  formatFanqieWordCount,
  type FanqieChartBase,
  type FanqieChartBook,
  type FanqieChartRecord,
  type FanqieMultiBookProgress
} from '../../shared/fanqie-chart'
import type { StreamHandleOf } from '../../shared/types'
import FanqieBookDetailModal from './FanqieBookDetailModal'
import NewProjectDialog, { type NewProjectDraft } from './NewProjectDialog'
import { fanqieIdeaProjectDraft } from '../../shared/fanqie-project'

const DIMENSIONS: Array<[string, string]> = [
  ['genre_characteristics', '题材特点'],
  ['hot_elements', '热门元素'],
  ['cool_point_patterns', '爽点模式'],
  ['intro_patterns', '简介写法'],
  ['ranking_reasons', '上榜因素'],
  ['writing_suggestions', '创作建议'],
  ['target_audience', '目标受众'],
  ['opening_patterns', '前三章正文分析'],
  ['golden_three_directions', '逐本黄金三章写作方向']
]

const GOLDEN_THREE_LABELS = {
  overall: '总体方向与三章节奏', chapter_one: '第一章：开场与首次回报',
  chapter_two: '第二章：推进与冲突升级', chapter_three: '第三章：兑现与长期循环',
  alternatives: '可选开篇路线', pitfalls: '常见问题与修正'
}

const STRATEGY: Record<string, string> = {
  trend: '顺势',
  fusion: '融合',
  opportunity: '补位'
}

function today(): string {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/LLM_NOT_CONFIGURED|NO_KEY/.test(message)) return '请先在「设置 → 模型服务」配置模型'
  if (/LLM_ABORTED|aborted/i.test(message)) return ''
  return message.replace(/^Error:\s*/, '')
}

function upsert(list: FanqieChartRecord[], record: FanqieChartRecord): FanqieChartRecord[] {
  const next = list.filter((item) => item.chartType !== record.chartType)
  next.push(record)
  return next
}

export default function FanqieChartPage(): ReactElement {
  const [records, setRecords] = useState<FanqieChartRecord[]>([])
  const [base, setBase] = useState<FanqieChartBase>('new_book_male')
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [projectDraft, setProjectDraft] = useState<NewProjectDraft | null>(null)
  const [projectNotice, setProjectNotice] = useState('')
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selectedBook, setSelectedBook] = useState<FanqieChartBook | null>(null)
  const [ideaPreview, setIdeaPreview] = useState('')
  const [showBrainstorm, setShowBrainstorm] = useState(false)
  const brainstormDialog = useRef<HTMLDialogElement | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [cachedSummary, setCachedSummary] = useState<Record<string, number>>({})
  const multiBatchTask = useRef<{ abort: () => void } | null>(null)
  const [multiBatchProgress, setMultiBatchProgress] = useState<FanqieMultiBookProgress | null>(null)
  const stopAll = useRef(0)
  const task = useRef<StreamHandleOf<FanqieChartRecord> | null>(null)
  const ideaOutput = useRef<ReturnType<typeof createBufferedText> | null>(null)

  const categories = fanqieCategoriesFor(base)
  const chartType = category ? `${base}:${category}` : ''
  const current = records.find((item) => item.chartType === chartType) ?? null

  useEffect(() => {
    if (showBrainstorm && brainstormDialog.current && !brainstormDialog.current.open) {
      brainstormDialog.current.showModal()
    }
  }, [showBrainstorm])

  const loadCachedSummary = useCallback(async () => {
    try {
      if (typeof window.api?.listFanqieCachedBooksSummary === 'function') {
        const map = await window.api.listFanqieCachedBooksSummary()
        setCachedSummary(map)
      }
    } catch {
      // ignore
    }
  }, [])

  const refresh = useCallback(async () => {
    const list = await window.api.listFanqieCharts()
    setRecords(list)
    return list
  }, [])

  useEffect(() => {
    void refresh().finally(() => setLoading(false))
    void loadCachedSummary()
    return window.api.onFanqieChartProgress((item) => {
      setProgress(item.message)
      if (item.analysis) setRecords(list => list.map(record => record.chartType === item.chartType
        ? { ...record, analysis: item.analysis!, status: 'analyzed' } : record))
    })
  }, [refresh, loadCachedSummary])

  useEffect(() => {
    void loadCachedSummary()
  }, [loadCachedSummary, current?.books, current?.chapterFetchNote])

  useEffect(() => () => {
    ideaOutput.current?.clear()
    ideaOutput.current = null
    stopAll.current += 1
    void task.current?.abort()
    void multiBatchTask.current?.abort()
  }, [])

  useEffect(() => {
    if (category && categories[category]) return
    const cached = Object.keys(categories).find((id) => records.some((item) => item.chartType === `${base}:${id}`))
    setCategory(cached || Object.keys(categories)[0] || '')
  }, [base, categories, category, records])

  useEffect(() => {
    setSelectedTags([])
    setShowAllTags(false)
    setIdeaPreview('')
    ideaOutput.current?.clear()
    ideaOutput.current = null
    setError('')
  }, [chartType])

  const visibleCategories = useMemo(() => {
    const q = search.trim()
    return Object.entries(categories).filter(([, name]) => !q || name.includes(q))
  }, [categories, search])

  const runFetch = async (type: string, force: boolean): Promise<FanqieChartRecord | null> => {
    setError('')
    setProgress(force ? '正在重新抓取' : '正在抓取')
    try {
      const record = await window.api.fetchFanqieChart(type, force)
      setRecords((list) => upsert(list, record))
      setFailures((prev) => {
        const next = { ...prev }
        delete next[type]
        return next
      })
      await loadCachedSummary()
      return record
    } catch (err) {
      const message = explain(err) || '抓取失败'
      setFailures((prev) => ({ ...prev, [type]: message }))
      setError(message)
      return null
    } finally {
      setProgress('')
    }
  }

  const handleBatchFetchTop3 = async (targetBooks?: FanqieChartBook[]) => {
    const list = targetBooks || current?.books || []
    if (list.length === 0) return
    if (typeof window.api?.fetchFanqieMultiBooksBatch !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      return
    }
    const booksToFetch = list.map((b) => ({ bookId: b.bookId, title: b.title }))
    setBusy('batch3')
    setMultiBatchProgress({
      bookIndex: 0,
      totalBooks: booksToFetch.length,
      bookTitle: '',
      bookId: '',
      chapterIndex: 0,
      totalChapters: 3,
      chapterTitle: '',
      message: `准备自动抓取前 ${booksToFetch.length} 本书前3章正文…`,
      status: 'running'
    })
    setError('')

    const handle = window.api.fetchFanqieMultiBooksBatch(
      booksToFetch,
      3,
      (prog) => {
        setMultiBatchProgress(prog)
      }
    )
    multiBatchTask.current = handle

    try {
      const summary = await handle
      setCachedSummary(summary)
    } catch (err) {
      const msg = explain(err)
      if (msg && msg !== '操作已取消' && msg !== '批量抓取已取消') setError(msg)
    } finally {
      multiBatchTask.current = null
      setBusy('')
      setTimeout(() => setMultiBatchProgress(null), 3000)
    }
  }

  const fetchOne = async (force: boolean): Promise<void> => {
    if (!chartType) return
    setBusy(chartType)
    try {
      await runFetch(chartType, force)
    } finally {
      setBusy('')
    }
  }

  const fetchAll = async (): Promise<void> => {
    const ids = Object.keys(categories)
    if (!confirm(`抓取${FANQIE_CHART_TYPES.find((item) => item.id === base)?.label ?? ''}下的 ${ids.length} 个分类？第一次会多花一分钟建立字形对照。`)) return
    const token = ++stopAll.current
    setBusy('all')
    for (let index = 0; index < ids.length; index++) {
      if (token !== stopAll.current) break
      const type = `${base}:${ids[index]}`
      setProgress(`${index + 1}/${ids.length} ${categories[ids[index]]}`)
      await runFetch(type, false)
    }
    if (token === stopAll.current) {
      setBusy('')
      setProgress('')
    }
  }

  const removeChart = async (): Promise<void> => {
    if (!current || !confirm(`删除「${categories[category] ?? ''}」的本地榜单？`)) return
    await window.api.deleteFanqieChart(current.chartType)
    setRecords((list) => list.filter((item) => item.chartType !== current.chartType))
  }

  const analyze = async (force: boolean): Promise<void> => {
    if (!chartType) return
    if (!(await window.api.hasLlmKey())) {
      setError('请先在「设置 → 模型服务」配置模型')
      return
    }
    void task.current?.abort()
    setBusy('analyze')
    setError('')
    setProgress('正在分析')
    const handle = window.api.analyzeFanqieChart(chartType, force, () => undefined)
    task.current = handle
    try {
      const record = await handle
      setRecords((list) => upsert(list, record))
    } catch (err) {
      const message = explain(err)
      if (message) setError(message)
    } finally {
      if (task.current === handle) task.current = null
      setBusy('')
      setProgress('')
    }
  }

  const generate = async (): Promise<void> => {
    if (!chartType) return
    if (!(await window.api.hasLlmKey())) {
      setError('请先在「设置 → 模型服务」配置模型')
      return
    }
    void task.current?.abort()
    setBusy('ideas')
    setError('')
    setIdeaPreview('')
    ideaOutput.current?.clear()
    const output = createBufferedText(text => {
      if (ideaOutput.current === output) setIdeaPreview(previous => (previous + text).slice(-4000))
    })
    ideaOutput.current = output
    const handle = window.api.generateFanqieChartIdeas(
      { chartType, ideaCount: 3, tags: selectedTags },
      (token) => {
        if (ideaOutput.current === output && token) output.push(token)
      }
    )
    task.current = handle
    try {
      const record = await handle
      output.flush()
      setRecords((list) => upsert(list, record))
      if (ideaOutput.current === output) setIdeaPreview('')
    } catch (err) {
      const message = explain(err)
      if (message) setError(message)
    } finally {
      output.clear()
      if (ideaOutput.current === output) ideaOutput.current = null
      if (task.current === handle) { task.current = null; setBusy('') }
    }
  }

  const tagChoices = useMemo(() => {
    const counts = new Map<string, number>()
    for (const book of current?.books ?? []) {
      const tags = new Set([book.genre, ...book.tags].map(tag => tag.trim()).filter(Boolean))
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)
  }, [current])

  const stats = current?.analysis?.tagStatistics ?? []
  const visibleStats = showAllTags ? stats : stats.slice(0, 8)

  return (
    <div>
      <div className="page-head">
        <h1>番茄榜单</h1>
        <p className="desc">按分类抓取新书榜和阅读榜，同时缓存每本书的前3章正文。书名经过字体还原，可在本地做市场分析，并按这期样本出脑洞。</p>
      </div>

      <div className="fanqie-types">
        {FANQIE_CHART_TYPES.map((item) => (
          <button
            key={item.id}
            className={`fanqie-type${base === item.id ? ' active' : ''}`}
            onClick={() => {
              setBase(item.id)
              setCategory('')
              setSearch('')
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="fanqie-layout">
        <div>
          <input
            className="input"
            value={search}
            placeholder="搜索分类"
            onChange={(event) => setSearch(event.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="fanqie-cats">
            {loading ? <p className="empty">加载中…</p> : null}
            {visibleCategories.map(([id, name]) => {
              const type = `${base}:${id}`
              const cached = records.find((item) => item.chartType === type)
              const failed = failures[type]
              const dot = failed
                ? 'failed'
                : cached?.status === 'analyzed'
                  ? 'analyzed'
                  : cached?.isPartial
                    ? 'partial'
                    : cached
                      ? 'cached'
                      : ''
              return (
                <button
                  key={id}
                  className={`fanqie-cat${id === category ? ' active' : ''}`}
                  onClick={() => setCategory(id)}
                >
                  <span className={`fanqie-dot ${dot}`} />
                  <span>
                    <span className="fanqie-cat-name">{name}</span>
                    <span className="fanqie-cat-meta">
                      {failed ? '抓取失败' : cached ? `${cached.actualCount} 本 · ${cached.chartDate}` : '未抓取'}
                    </span>
                  </span>
                  {cached ? <span className="fanqie-cat-count">{cached.books.length}</span> : <span />}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <div className="fanqie-actions fanqie-toolbar" aria-label="榜单操作">
            <button className="btn btn-primary" disabled={!chartType || busy !== ''} onClick={() => void fetchOne(false)}>
              {busy === chartType ? '抓取中…' : current?.chartDate === today() ? '查看今日榜' : '抓取本类'}
            </button>
            <button className="btn" disabled={!chartType || busy !== ''} onClick={() => void fetchOne(true)}>重新抓取</button>
            <button
              className="btn"
              disabled={!current || busy !== ''}
              onClick={() => void handleBatchFetchTop3(current?.books)}
              title="补抓本榜所有书籍的前3章正文，复用有效缓存"
            >
              {busy === 'batch3' ? '抓取前3章中…' : '补抓前3章'}
            </button>
            {busy === 'batch3' ? (
              <button className="btn btn-danger" onClick={() => multiBatchTask.current?.abort()}>
                取消抓取
              </button>
            ) : null}
            <button className="btn" disabled={busy !== ''} onClick={() => void fetchAll()}>
              {busy === 'all' ? '批量抓取中…' : '抓取此榜全部分类'}
            </button>
            <button className="btn" disabled={!current || busy !== ''} onClick={() => void analyze(Boolean(current?.analysis))}>
              {busy === 'analyze' ? '分析中…' : current?.analysis ? '重新分析' : '分析榜单'}
            </button>
            {busy === 'analyze' ? <button className="btn btn-danger" onClick={() => void task.current?.abort()}>停止分析</button> : null}
            <button className="btn" disabled={!current || busy !== ''} onClick={() => void removeChart()}>删除缓存</button>
            <button className="btn btn-primary fanqie-toolbar-generate" disabled={!current || (busy !== '' && busy !== 'ideas')} onClick={() => setShowBrainstorm(true)}>
              {busy === 'ideas' ? '脑洞生成中…' : '榜单脑洞'}
            </button>

          </div>

          {multiBatchProgress ? (
            <div className="fanqie-batch-progress-box" style={{ marginBottom: 12 }}>
              <div className="fanqie-progress-text">
                <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{multiBatchProgress.message}</span>
                <span>
                  书籍 {multiBatchProgress.bookIndex}/{multiBatchProgress.totalBooks}
                </span>
              </div>
              <div className="fanqie-progress-bar-bg">
                <div
                  className="fanqie-progress-bar-fill"
                  style={{
                    width: `${Math.round((multiBatchProgress.bookIndex / Math.max(1, multiBatchProgress.totalBooks)) * 100)}%`
                  }}
                />
              </div>
            </div>
          ) : null}

          {progress ? <div className="fanqie-note">{progress}</div> : null}
          {current?.chapterFetchNote ? <div className="fanqie-note">{current.chapterFetchNote}</div> : null}
          {error ? <div className="fanqie-note fanqie-error">{error}</div> : null}
          {projectNotice ? <div className="fanqie-note" role="status">{projectNotice}</div> : null}
          {current?.partialReason ? <div className="fanqie-note">{current.partialReason}</div> : null}
          {current ? (
            <div className="fanqie-note">
              {categories[category]} · {current.chartDate}
              {current.chartDate !== today() ? '，不是今天的榜' : ''}
              {' · '}可读 {current.actualCount} 本
              {current.coverDirectory ? ` · 封面在 ${current.coverDirectory}` : ''}
            </div>
          ) : (
            <p className="empty">这个分类还没有本地榜单。</p>
          )}



          {current && current.books.length > 0 ? (
            <div className="fanqie-books">
              {current.books.map((book) => (
                <BookRow
                  key={book.bookId}
                  book={book}
                  cachedCount={cachedSummary[book.bookId] ?? 0}
                  onOpenDetail={setSelectedBook}
                />
              ))}
            </div>
          ) : null}

          {current?.analysis ? (
            <details className="fanqie-block fanqie-analysis" key={chartType}>
              <summary>市场洞察<span>标签统计、黄金三章方向与样本依据</span></summary>
              <div className="fanqie-analysis-body">
              {current.analysis.inProgress ? <p className="desc">逐本分析尚未全部完成，以下为已保存结果；完成后生成分类汇总。</p> : null}
              {current.analysis.openingChapterCount !== undefined ? <p className="desc">开篇正文样本：{current.analysis.openingBookCount} 本 · {current.analysis.openingChapterCount} 章</p> : null}
              <p className="desc">标签频次按这期可读样本计算。结论只解释机制，数量以这里的统计为准。</p>
              {current.analysis.limitations.map((item) => (
                <p key={item} className="desc">{item}</p>
              ))}
              {visibleStats.map((item) => (
                <div key={item.tag} className="fanqie-stat">
                  <div className="fanqie-stat-label">
                    <span>{item.tag}</span>
                    <span>{item.count} 本 · {item.share}% · 前十 {item.topCount}</span>
                  </div>
                  <div className="fanqie-stat-bar"><span style={{ width: `${Math.min(100, item.share)}%` }} /></div>
                </div>
              ))}
              {stats.length > 8 ? (
                <button className="btn btn-ghost" onClick={() => setShowAllTags((value) => !value)}>
                  {showAllTags ? '收起标签' : `其余 ${stats.length - 8} 个标签`}
                </button>
              ) : null}
              {current.analysis.goldenThreeSummary ? (
                <div className="fanqie-insight">
                  <h3>本分类黄金三章总体写作方向</h3>
                  <p className="desc">综合 {current.analysis.goldenThreeSummary.bookCount} 本书、{current.analysis.goldenThreeSummary.chapterCount} 章的有效开篇分析。以下是创作建议。</p>
                  {current.analysis.goldenThreeSummary.directions.map(item => (
                    <div key={item.stage} className="fanqie-direction">
                      <strong>{GOLDEN_THREE_LABELS[item.stage]}</strong>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{item.claim}</p>
                      {item.evidence.length > 0 ? <details className="fanqie-evidence-list"><summary>查看 {item.evidence.length} 条样本依据</summary>
                      {item.evidence.map(ref => (
                        <div key={`${ref.bookId}-${ref.chapterId}-${ref.quote}`} className="fanqie-evidence">
                          《{current.books.find(book => book.bookId === ref.bookId)?.title ?? ref.bookId}》 · {ref.chapterTitle}：「{ref.quote}」
                        </div>
                      ))}
                      </details> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {DIMENSIONS.map(([key, label]) => {
                const rows = current.analysis?.insights.filter((item) => item.dimension === key) ?? []
                if (rows.length === 0) return null
                return (
                  <div key={key} className="fanqie-insight">
                    <strong>{label}</strong>
                    {rows.map((row) => (
                      <div key={row.claim}>
                        <p>{row.claim}{row.confidence === 'hypothesis' ? '（推测）' : ''}</p>
                        {row.evidence.length > 0 ? <details className="fanqie-evidence-list"><summary>查看 {row.evidence.length} 条样本依据</summary>
                        {row.evidence.map((item) => (
                          <div key={`${item.bookId}-${item.quote}`} className="fanqie-evidence">
                            《{current.books.find(book => book.bookId === item.bookId)?.title ?? item.bookId}》{item.chapterTitle ? ` · ${item.chapterTitle}` : ''}：
                            「{item.quote}」
                          </div>
                        ))}
                        </details> : null}
                      </div>
                    ))}
                  </div>
                )
              })}
              </div>
            </details>
          ) : null}


        </div>
      </div>

      {current && showBrainstorm ? (
        <dialog ref={brainstormDialog} className="fanqie-brainstorm-modal" aria-labelledby="fanqie-brainstorm-title"
          onClose={() => setShowBrainstorm(false)}
          onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close() } }}>
          <div className="fanqie-modal-head">
            <div><h2 id="fanqie-brainstorm-title">榜单脑洞</h2><p className="fanqie-tag-selection">{categories[category]} · {current.chartDate} · {current.actualCount} 本样本</p></div>
            <button type="button" className="btn btn-ghost btn-sm" autoFocus onClick={() => brainstormDialog.current?.close()} aria-label="关闭榜单脑洞">关闭</button>
          </div>
          <div className="fanqie-brainstorm-body">
              {error ? <div className="fanqie-note fanqie-error" role="alert">{error}</div> : null}
              {busy === 'ideas' ? <p className="fanqie-note" role="status">正在生成脑洞，可关闭弹窗，生成会继续。</p> : null}
              <p className="desc">可选几个这期真实标签，方案会结合本分类黄金三章汇总，并分别给出前三章写作方向。未分析时会先生成分类汇总。</p>
              {tagChoices.length > 0 ? <>
              <p className="fanqie-tag-selection">点击下方标签选择，最多 4 个；再次点击取消。数字为使用该标签的书籍数。</p>
              <div className="fanqie-tags" aria-label="脑洞标签">
                {tagChoices.map(([tag, count]) => {
                  const on = selectedTags.includes(tag)
                  return (
                    <button
                      key={tag}
                      className={`fanqie-tag-btn${on ? ' on' : ''}`}
                      aria-pressed={on}
                      disabled={busy !== '' || (!on && selectedTags.length >= 4)}
                      onClick={() => setSelectedTags((prev) => on ? prev.filter((item) => item !== tag) : prev.length >= 4 ? prev : [...prev, tag])}
                    >
                      {tag} {count}
                    </button>
                  )
                })}
              </div>
              <p className="fanqie-tag-selection">已选 {selectedTags.length}/4 个标签 · 留空则自由构思</p>
              </> : <p className="fanqie-note">这期榜单未获取到题材或标签，暂无可选项。可以直接生成脑洞，也可以重新抓取榜单后再选。</p>}
              <div className="fanqie-actions fanqie-brainstorm-actions">
                <button className="btn btn-primary" disabled={busy !== ''} onClick={() => void generate()}>
                  {busy === 'ideas' ? '生成中…' : '按这期榜单出脑洞'}
                </button>
              </div>
              {ideaPreview ? <pre className="fanqie-preview">{ideaPreview}</pre> : null}
              {current.ideas?.ideas.map((idea) => (
                <article key={idea.title} className="fanqie-idea">
                  <h3>{idea.title}</h3>
                  <button className="btn btn-sm" disabled={busy !== ''} onClick={() => {
                    brainstormDialog.current?.close()
                    setProjectNotice('')
                    setProjectDraft(fanqieIdeaProjectDraft(idea))
                  }}>转为小说项目</button>
                  <div className="fanqie-tags">
                    {idea.genre ? <span className="fanqie-tag">{idea.genre}</span> : null}
                    {STRATEGY[idea.strategy] ? <span className="fanqie-tag">{STRATEGY[idea.strategy]}</span> : null}
                    {idea.titleCandidates.filter((item) => item !== idea.title).map((item) => (
                      <span key={item} className="fanqie-tag">{item}</span>
                    ))}
                  </div>
                  {idea.hookLine ? <p>{idea.hookLine}</p> : null}
                  {idea.goldenFinger ? <p>金手指：{idea.goldenFinger}</p> : null}
                  {idea.coreConcept ? <p>{idea.coreConcept}</p> : null}
                  {idea.openingHook ? <p>开篇：{idea.openingHook}</p> : null}
                  {idea.protagonist ? <p>主角：{idea.protagonist}</p> : null}
                  {idea.sellingPoint ? <p>卖点：{idea.sellingPoint}</p> : null}
                  {idea.riskNotes ? <p>风险：{idea.riskNotes}</p> : null}
                  {idea.openingChapters?.length ? (
                    <div className="fanqie-insight">
                      <h4>这个脑洞的前三章写作方向</h4>
                      {idea.openingChapters.map(chapter => (
                        <div key={chapter.chapter}>
                          <strong>第{chapter.chapter}章</strong>
                          <p>开场事件：{chapter.openingEvent}</p>
                          <p>主角行动：{chapter.protagonistAction}</p>
                          <p>冲突阻力：{chapter.conflict}</p>
                          <p>当章回报：{chapter.payoff}</p>
                          <p>章末钩子：{chapter.endHook}</p>
                          <p className="desc">汇总方向的应用：{chapter.summaryApplication}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
          </div>
        </dialog>
      ) : null}

      {selectedBook ? (
        <FanqieBookDetailModal
          bookId={selectedBook.bookId}
          knownBook={selectedBook}
          onClose={() => setSelectedBook(null)}
        />
      ) : null}
      {projectDraft ? <NewProjectDialog initialDraft={projectDraft}
        onClose={() => setProjectDraft(null)}
        onCreated={(project) => {
          const hasDirections = Boolean(projectDraft.openingChapters?.length)
          setProjectDraft(null)
          setProjectNotice(`《${project.name}》已创建，可在书案中查看。${hasDirections ? '对应前三章写作方向已保存，生成细纲时会自动使用。' : '旧脑洞没有三章方向，可重新生成脑洞后采用。'}`)
        }} /> : null}
    </div>
  )
}

function BookRow({
  book,
  cachedCount = 0,
  onOpenDetail
}: {
  book: FanqieChartBook
  cachedCount?: number
  onOpenDetail: (book: FanqieChartBook) => void
}): ReactElement {
  const [broken, setBroken] = useState(false)
  const wordText = formatFanqieWordCount(book.wordCount)
  const readText = formatFanqieReadCount(book.readCount)
  const displayTags =
    book.tags && book.tags.length > 0
      ? book.tags.slice(0, 2)
      : book.genre
        ? [book.genre]
        : []

  return (
    <article
      className="fanqie-book"
      title="点击查看书籍目录与抓取正文"
      onClick={() => onOpenDetail(book)}
    >
      <div className="fanqie-cover-wrap">
        {book.cover && !broken ? (
          <img
            className="fanqie-cover"
            src={book.cover}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
            loading="lazy"
          />
        ) : (
          <div className="fanqie-cover-empty">无封面</div>
        )}
        <span className={`fanqie-rank rank-${book.rank <= 3 ? book.rank : 'normal'}`}>
          {book.rank}
        </span>
      </div>

      <div className="fanqie-book-body">
        <div className="fanqie-title" title={book.title}>
          {book.garbled ? (
            <span className="fanqie-garbled-badge" title="部分字形存在还原差异">
              ⚠
            </span>
          ) : null}
          <span>{book.title}</span>
        </div>

        <div className="fanqie-author-row">
          <span className="fanqie-author" title={book.author ? `作者：${book.author}` : undefined}>
            {book.author || '佚名'}
          </span>
          {book.status ? (
            <span className={`fanqie-status-pill ${book.status.includes('完') ? 'finished' : 'serial'}`}>
              {book.status}
            </span>
          ) : null}
        </div>

        <div className="fanqie-metrics-row">
          {readText ? (
            <span className="fanqie-metric-badge hot" title={readText}>
              🔥 {readText}
            </span>
          ) : null}
          {wordText ? (
            <span className="fanqie-metric-badge words" title={wordText}>
              {wordText}
            </span>
          ) : null}
          {cachedCount >= 3 ? (
            <span className="fanqie-metric-badge cached" title={`本地已缓存 ${cachedCount} 章正文`}>
              ✓ 前{cachedCount}章已下载
            </span>
          ) : cachedCount > 0 ? (
            <span className="fanqie-metric-badge cached" title={`本地已缓存 ${cachedCount} 章正文`}>
              ✓ 已缓存{cachedCount}章
            </span>
          ) : null}
        </div>

        {book.intro ? (
          <p className="fanqie-intro" title={book.intro}>
            {book.intro}
          </p>
        ) : null}

        <div className="fanqie-book-footer">
          <div className="fanqie-book-tags">
            {displayTags.map((tag) => (
              <span key={tag} className="fanqie-tag-pill" title={tag}>
                {tag}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="fanqie-read-btn"
            onClick={(e) => {
              e.stopPropagation()
              onOpenDetail(book)
            }}
          >
            正文/目录
          </button>
        </div>
      </div>
    </article>
  )
}
