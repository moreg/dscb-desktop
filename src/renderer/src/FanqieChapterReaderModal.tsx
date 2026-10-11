import { useEffect, useState, type ReactElement } from 'react'
import type { FanqieChapterContent, FanqieChapterItem } from '../../shared/fanqie-chart'

interface Props {
  bookId: string
  bookTitle: string
  chapterId: string
  chapters: FanqieChapterItem[]
  onClose: () => void
  onNavigateChapter: (chapterId: string) => void
}

export default function FanqieChapterReaderModal({
  bookId,
  bookTitle,
  chapterId,
  chapters,
  onClose,
  onNavigateChapter
}: Props): ReactElement {
  const [loading, setLoading] = useState(true)
  const [chapter, setChapter] = useState<FanqieChapterContent | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fontSize, setFontSize] = useState<number>(17)

  const currentIndex = chapters.findIndex((c) => c.id === chapterId)
  const prevChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null
  const nextChapter = currentIndex >= 0 && currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null
  const currentChapterInfo = currentIndex >= 0 ? chapters[currentIndex] : null

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setCopied(false)

    if (typeof window.api?.getFanqieChapterContent !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      setLoading(false)
      return
    }

    window.api
      .getFanqieChapterContent(
        bookId,
        chapterId,
        currentChapterInfo?.title,
        bookTitle,
        false
      )
      .then((res) => {
        if (!active) return
        setChapter(res)
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [bookId, chapterId, currentChapterInfo?.title, bookTitle])

  const handleRefresh = async () => {
    setRefreshing(true)
    setError('')
    if (typeof window.api?.getFanqieChapterContent !== 'function') {
      setError('桌面应用底层服务尚未加载：请重启开发环境（在终端中按 Ctrl+C 关闭后重新运行 npm run dev）')
      setRefreshing(false)
      return
    }
    try {
      const res = await window.api.getFanqieChapterContent(
        bookId,
        chapterId,
        currentChapterInfo?.title,
        bookTitle,
        true
      )
      setChapter(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const handleCopy = async () => {
    if (!chapter?.content) return
    try {
      await navigator.clipboard.writeText(`${chapter.title}\n\n${chapter.content}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowLeft' && prevChapter) {
        onNavigateChapter(prevChapter.id)
      } else if (e.key === 'ArrowRight' && nextChapter) {
        onNavigateChapter(nextChapter.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, prevChapter, nextChapter, onNavigateChapter])

  const paragraphs = chapter?.content ? chapter.content.split('\n\n') : []

  return (
    <div className="fanqie-modal-backdrop" onClick={onClose}>
      <div className="fanqie-modal fanqie-reader-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fanqie-modal-head">
          <div className="fanqie-reader-title-area">
            <span className="fanqie-reader-book-title">{bookTitle}</span>
            <h2 className="fanqie-reader-heading">{chapter?.title || currentChapterInfo?.title || '正文阅读'}</h2>
            <div className="fanqie-reader-meta-row">
              {chapter ? (
                <>
                  <span>字数：{chapter.wordCount} 字</span>
                  {chapter.hasGarbled ? (
                    <span className="fanqie-badge-garbled">⚠ 存在少量未解密字符</span>
                  ) : (
                    <span className="fanqie-badge-clean">✓ 完整解密</span>
                  )}
                  <span>抓取于：{new Date(chapter.fetchedAt).toLocaleTimeString()}</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="fanqie-reader-controls">
            <div className="fanqie-font-controls">
              <button
                className="btn btn-sm"
                title="缩小字号"
                disabled={fontSize <= 14}
                onClick={() => setFontSize((s) => Math.max(14, s - 1))}
              >
                A-
              </button>
              <button
                className="btn btn-sm"
                title="放大字号"
                disabled={fontSize >= 24}
                onClick={() => setFontSize((s) => Math.min(24, s + 1))}
              >
                A+
              </button>
            </div>
            <button className="btn btn-sm" disabled={!chapter || refreshing} onClick={handleCopy}>
              {copied ? '✓ 已复制' : '复制正文'}
            </button>
            <button className="btn btn-sm" disabled={refreshing} onClick={handleRefresh}>
              {refreshing ? '重新抓取中…' : '重新抓取'}
            </button>
            <button className="btn btn-sm fanqie-modal-close" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          </div>
        </div>

        <div className="fanqie-reader-body">
          {loading ? (
            <div className="fanqie-reader-loading">
              <div className="fanqie-loading-spinner" />
              <p>正在抓取并解密章节正文，请稍候…</p>
            </div>
          ) : error ? (
            <div className="fanqie-reader-error">
              <p>抓取失败：{error}</p>
              <button className="btn btn-primary" onClick={handleRefresh}>
                重试抓取
              </button>
            </div>
          ) : (
            <article className="fanqie-reader-prose" style={{ fontSize: `${fontSize}px` }}>
              {paragraphs.map((p, idx) => (
                <p key={idx}>{p}</p>
              ))}
            </article>
          )}
        </div>

        <div className="fanqie-modal-foot fanqie-reader-foot">
          <button
            className="btn"
            disabled={!prevChapter || loading}
            onClick={() => prevChapter && onNavigateChapter(prevChapter.id)}
            title="按快捷键 ← 翻上一章"
          >
            ← 上一章
          </button>
          <div className="fanqie-reader-nav-info">
            {currentIndex >= 0 ? `${currentIndex + 1} / ${chapters.length}` : ''}
          </div>
          <button
            className="btn btn-primary"
            disabled={!nextChapter || loading}
            onClick={() => nextChapter && onNavigateChapter(nextChapter.id)}
            title="按快捷键 → 翻下一章"
          >
            下一章 →
          </button>
        </div>
      </div>
    </div>
  )
}
