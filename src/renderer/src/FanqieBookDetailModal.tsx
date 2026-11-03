import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  formatFanqieReadCount,
  formatFanqieWordCount,
  type FanqieBatchFetchProgress,
  type FanqieBookDetail,
  type FanqieChartBook
} from '../../shared/fanqie-chart'
import FanqieChapterReaderModal from './FanqieChapterReaderModal'
import { chartBookTags } from '../../shared/fanqie-chart-tags'

interface Props {
  bookId: string
  knownBook?: FanqieChartBook
  onClose: () => void
}

export default function FanqieBookDetailModal({
  bookId,
  knownBook,
  onClose
}: Props): ReactElement {
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<FanqieBookDetail | null>(null)
  const [error, setError] = useState('')
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState<FanqieBatchFetchProgress | null>(null)
  const [filterMode, setFilterMode] = useState<'all' | 'cached'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [exportNotice, setExportNotice] = useState('')
  const batchTask = useRef<{ abort: () => void } | null>(null)
  const requestVersion = useRef(0)
  const currentBook = useRef(bookId); currentBook.current = bookId
  const knownBookRef = useRef(knownBook); knownBookRef.current = knownBook
  const active = useRef(true)
  const exportTimer = useRef<ReturnType<typeof setTimeout>>()
  const isCurrent = useCallback((version: number) => active.current && currentBook.current === bookId && requestVersion.current === version, [bookId])

  const autoFetchFirst3 = useCallback(async (currentDetail: FanqieBookDetail, version: number) => {
    if (!isCurrent(version) || batchTask.current || !window.api?.fetchFanqieChaptersBatch) return
    setBatchRunning(true)
    setBatchProgress({
      bookId: currentDetail.bookId,
      current: 0,
      total: 3,
      chapterTitle: '',
      message: '正在自动预抓取黄金前 3 章正文…',
      status: 'running'
    })

    const handle = window.api.fetchFanqieChaptersBatch(
      currentDetail.bookId,
      3,
      undefined,
      (progress) => {
        if (isCurrent(version)) setBatchProgress(progress)
      }
    )
    batchTask.current = handle

    try {
      await handle
      if (!isCurrent(version)) return
      const updated = await window.api.getFanqieBookDetail(currentDetail.bookId, knownBookRef.current, false)
      if (isCurrent(version)) setDetail(updated)
    } catch {
      // 预抓取若受阻，不阻断界面，用户可手动再次点击重试
    } finally {
      if (batchTask.current === handle) {
        batchTask.current = null
        if (active.current && currentBook.current === currentDetail.bookId) setBatchRunning(false)
      }
    }
  }, [isCurrent])

  const loadDetail = useCallback(async (force = false) => {
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    try {
      if (typeof window.api?.getFanqieBookDetail !== 'function') {
        throw new Error('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      }
      const data = await window.api.getFanqieBookDetail(bookId, knownBookRef.current, force)
      if (!isCurrent(version)) return
      setDetail(data)
      if (!force && data.chapters.length > 0 && data.cachedChapterIds.length < 3) {
        void autoFetchFirst3(data, version)
      }
    } catch (err) {
      if (isCurrent(version)) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrent(version)) setLoading(false)
    }
  }, [bookId, isCurrent, autoFetchFirst3])

  useEffect(() => {
    active.current = true
    setDetail(null); setActiveChapterId(null); setBatchRunning(false); setBatchProgress(null); setExportNotice('')
    void loadDetail()
    return () => {
      active.current = false
      batchTask.current?.abort()
      batchTask.current = null
      clearTimeout(exportTimer.current)
    }
  }, [loadDetail])

  const handleFetchBatch = async (limit: number) => {
    if (!detail || batchTask.current) return
    const version = requestVersion.current
    setBatchRunning(true)
    setBatchProgress(null)
    setError('')

    if (typeof window.api?.fetchFanqieChaptersBatch !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      setBatchRunning(false)
      return
    }

    const handle = window.api.fetchFanqieChaptersBatch(
      bookId,
      limit,
      undefined,
      (progress) => {
        if (isCurrent(version)) setBatchProgress(progress)
      }
    )
    batchTask.current = handle

    try {
      await handle
      // 刷新详情以更新 cachedChapterIds
      if (isCurrent(version)) await loadDetail(false)
    } catch (err) {
      if (isCurrent(version)) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (batchTask.current === handle) {
        batchTask.current = null
        if (active.current && currentBook.current === bookId) setBatchRunning(false)
      }
    }
  }

  const handleCancelBatch = () => {
    batchTask.current?.abort()
  }

  const handleExportTxt = async () => {
    const version = requestVersion.current
    setExportNotice('')
    if (typeof window.api?.exportFanqieBookTxt !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      return
    }
    try {
      const res = await window.api.exportFanqieBookTxt(bookId)
      if (!isCurrent(version)) return
      // 生成本地下载 blob
      const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${res.title.replace(/[\\/:*?"<>|]/g, '_')}_已抓取${res.chapterCount}章.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExportNotice(`✓ 已成功导出 ${res.chapterCount} 章（共 ${res.wordCount} 字）`)
      clearTimeout(exportTimer.current)
      exportTimer.current = setTimeout(() => { if (isCurrent(version)) setExportNotice('') }, 4000)
    } catch (err) {
      if (isCurrent(version)) setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteCache = async () => {
    const version = requestVersion.current
    if (!confirm('确定清除本书的所有已下载章节正文缓存？')) return
    if (typeof window.api?.deleteFanqieBookCache !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      return
    }
    try {
      await window.api.deleteFanqieBookCache(bookId)
      if (isCurrent(version)) await loadDetail(true)
    } catch (err) {
      if (isCurrent(version)) setError(err instanceof Error ? err.message : String(err))
    }
  }

  const visibleChapters = useMemo(() => {
    if (!detail) return []
    let list = detail.chapters
    if (filterMode === 'cached') {
      const cachedSet = new Set(detail.cachedChapterIds)
      list = list.filter((ch) => cachedSet.has(ch.id))
    }
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((ch) => ch.title.toLowerCase().includes(q) || String(ch.index).includes(q))
    }
    return list
  }, [detail, filterMode, searchQuery])

  const cachedCount = detail?.cachedChapterIds.length ?? 0
  const totalCount = detail?.chapters.length ?? 0
  const cover = detail?.cover || knownBook?.cover

  return (
    <div className="fanqie-modal-backdrop" onClick={onClose}>
      <div className="fanqie-modal fanqie-book-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fanqie-modal-head">
          <div className="fanqie-book-head-title">
            <h2>{detail?.title || knownBook?.title || '书籍详情'}</h2>
            <span className="fanqie-book-author">作者：{detail?.author || knownBook?.author || '未知'}</span>
          </div>
          <button className="btn btn-sm fanqie-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="fanqie-book-detail-body">
          {loading && !detail ? (
            <div className="fanqie-reader-loading">
              <div className="fanqie-loading-spinner" />
              <p>正在获取书籍详情与章节目录…</p>
            </div>
          ) : error && !detail ? (
            <div className="fanqie-reader-error">
              <p>获取失败：{error}</p>
              <button className="btn btn-primary" onClick={() => void loadDetail(true)}>
                重试
              </button>
            </div>
          ) : detail ? (
            <>
              <div className="fanqie-book-summary-card">
                <div className="fanqie-cover-wrap">
                  {cover ? (
                    <img className="fanqie-cover" src={cover} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="fanqie-cover-empty">无封面</div>
                  )}
                </div>
                <div className="fanqie-book-summary-content">
                  <div className="fanqie-book-badges-row">
                    {detail.genre ? <span className="fanqie-tag">{detail.genre}</span> : null}
                    {detail.status ? <span className="fanqie-tag">{detail.status}</span> : null}
                    {detail.wordCount ? <span className="fanqie-tag">{formatFanqieWordCount(detail.wordCount)}</span> : null}
                    {detail.readCount ? <span className="fanqie-tag">{formatFanqieReadCount(detail.readCount)}</span> : null}
                    <span className="fanqie-tag fanqie-tag-primary">
                      共 {totalCount} 章 · 已抓取正文 {cachedCount} 章
                    </span>
                  </div>

                  {chartBookTags(detail).length > 0 ? (
                    <div className="fanqie-tags" style={{ marginTop: 6 }}>
                      {chartBookTags(detail).map((t) => (
                        <span key={t} className="fanqie-tag">
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {detail.intro ? <p className="fanqie-book-intro-full">{detail.intro}</p> : null}
                </div>
              </div>

              {/* 批量操作工具栏 */}
              <div className="fanqie-book-actions-bar">
                <button
                  className="btn btn-primary"
                  disabled={batchRunning || totalCount === 0}
                  onClick={() => void handleFetchBatch(3)}
                  title="抓取前3章（黄金三章）并解密正文到本地"
                >
                  {batchRunning ? '正文抓取中…' : '抓取前3章(黄金三章)'}
                </button>
                <button
                  className="btn"
                  disabled={batchRunning || totalCount === 0}
                  onClick={() => void handleFetchBatch(10)}
                  title="抓取前10章并解密正文到本地"
                >
                  抓取前10章
                </button>
                {totalCount > 10 ? (
                  <button
                    className="btn"
                    disabled={batchRunning}
                    onClick={() => {
                      if (confirm(`准备抓取全书全部 ${totalCount} 章？为了防止限流，需要一些时间。`)) {
                        void handleFetchBatch(totalCount)
                      }
                    }}
                  >
                    抓取全部章节
                  </button>
                ) : null}
                {batchRunning ? (
                  <button className="btn btn-danger" onClick={handleCancelBatch}>
                    取消抓取
                  </button>
                ) : null}
                <button
                  className="btn"
                  disabled={cachedCount === 0 || batchRunning}
                  onClick={() => void handleExportTxt()}
                  title="将已抓取的章节整合成TXT下载"
                >
                  导出TXT ({cachedCount}章)
                </button>
                <button className="btn" disabled={batchRunning} onClick={() => void loadDetail(true)} title="重新抓取目录结构">
                  刷新目录
                </button>
                {cachedCount > 0 ? (
                  <button className="btn btn-ghost" disabled={batchRunning} onClick={() => void handleDeleteCache()}>
                    清空缓存
                  </button>
                ) : null}
              </div>

              {/* 实时进度提示 */}
              {batchProgress ? (
                <div className="fanqie-batch-progress-box">
                  <div className="fanqie-batch-progress-head">
                    <span>{batchProgress.message}</span>
                    <span>
                      {batchProgress.current} / {batchProgress.total}
                    </span>
                  </div>
                  <div className="fanqie-stat-bar">
                    <span
                      style={{
                        width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%`
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {exportNotice ? <div className="fanqie-note fanqie-note-success">{exportNotice}</div> : null}
              {error ? <div className="fanqie-note fanqie-error">{error}</div> : null}

              {/* 章节列表 */}
              <div className="fanqie-chapter-section">
                <div className="fanqie-chapter-head">
                  <div className="fanqie-chapter-tabs">
                    <button
                      className={`fanqie-filter-tab${filterMode === 'all' ? ' active' : ''}`}
                      onClick={() => setFilterMode('all')}
                    >
                      全部章节 ({totalCount})
                    </button>
                    <button
                      className={`fanqie-filter-tab${filterMode === 'cached' ? ' active' : ''}`}
                      onClick={() => setFilterMode('cached')}
                    >
                      已抓取正文 ({cachedCount})
                    </button>
                  </div>
                  <input
                    className="input fanqie-chapter-search"
                    placeholder="按章名或序号搜索"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="fanqie-chapter-grid">
                  {visibleChapters.length === 0 ? (
                    <div className="fanqie-empty-chapters">
                      {filterMode === 'cached'
                        ? '暂无已抓取的章节，点击上方「抓取前10章正文」开始抓取'
                        : '没有匹配的章节'}
                    </div>
                  ) : (
                    visibleChapters.map((ch) => {
                      const isCached = detail.cachedChapterIds.includes(ch.id)
                      return (
                        <div
                          key={ch.id}
                          className={`fanqie-chapter-card${isCached ? ' cached' : ''}`}
                          onClick={() => setActiveChapterId(ch.id)}
                        >
                          <div className="fanqie-chapter-card-top">
                            <span className="fanqie-chapter-index">#{ch.index}</span>
                            <span className="fanqie-chapter-title-text" title={ch.title}>
                              {ch.title}
                            </span>
                          </div>
                          <div className="fanqie-chapter-card-meta">
                            {isCached ? (
                              <span className="fanqie-status-pill cached">已抓取正文</span>
                            ) : ch.needPay ? (
                              <span className="fanqie-status-pill locked">付费章节</span>
                            ) : (
                              <span className="fanqie-status-pill pending">未抓取</span>
                            )}
                            <button
                              className="btn btn-sm fanqie-read-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setActiveChapterId(ch.id)
                              }}
                            >
                              {isCached ? '阅读' : '抓取阅读'}
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* 章节阅读器 */}
      {activeChapterId && detail ? (
        <FanqieChapterReaderModal
          bookId={bookId}
          bookTitle={detail.title}
          chapterId={activeChapterId}
          chapters={detail.chapters}
          onClose={() => {
            setActiveChapterId(null)
            // 读者关闭后静默刷新详情以反映最新缓存的章节
            void loadDetail(false)
          }}
          onNavigateChapter={(nextId) => setActiveChapterId(nextId)}
        />
      ) : null}
    </div>
  )
}
