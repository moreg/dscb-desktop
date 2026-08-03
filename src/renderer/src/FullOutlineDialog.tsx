import { useCallback, useEffect, useState } from 'react'
import MarkdownView from './MarkdownView'
import type { DetailedOutlineRaw } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  onClose: () => void
}

/**
 * 完整细纲弹窗。
 *
 * 正文页的细纲卡片只渲染字段白名单（核心事件/爽点/钩子…），
 * 而磁盘上的 `细纲/*.md` 往往还有情节安排、人物关系、情节点序列等扩展节。
 * 这里直接展示 md 原文，与写作时喂给模型的内容同源。
 */
export function FullOutlineDialog({ projectId, chapterNumber, onClose }: Props) {
  const [raw, setRaw] = useState<DetailedOutlineRaw | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // preload 版本落后于 renderer 时（改完 preload 没重启 dev）该接口会缺失。
    // 直接调用会在 effect 里同步抛错、被错误边界接管，把整个正文页一起带走。
    if (typeof window.api.getDetailedOutlineRaw !== 'function') {
      setError('预加载脚本版本过旧，缺少读取接口。请重启应用（npm run dev）后重试。')
      setLoading(false)
      return
    }
    window.api
      .getDetailedOutlineRaw(projectId, chapterNumber)
      .then((res) => {
        if (!cancelled) setRaw(res)
      })
      .catch((err: unknown) => {
        console.error('读取完整细纲失败:', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, chapterNumber])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleCopy = useCallback(async () => {
    if (!raw) return
    try {
      await navigator.clipboard.writeText(raw.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      console.error('复制细纲失败:', err)
      setError('复制失败，请手动选中文本复制')
    }
  }, [raw])

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label={`第 ${chapterNumber} 章完整细纲`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 780, maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="row" style={{ alignItems: 'baseline', flexShrink: 0 }}>
          <strong style={{ fontSize: 15 }}>第 {chapterNumber} 章 · 完整细纲</strong>
          {raw ? (
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
              {raw.fileName}
            </span>
          ) : null}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn btn-sm btn-ghost" onClick={handleCopy} disabled={!raw}>
              {copied ? '已复制' : '复制原文'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--line)',
            overflow: 'auto',
            flex: 1
          }}
        >
          {loading ? (
            <p className="muted">读取中…</p>
          ) : error ? (
            <p className="missing">读取失败：{error}</p>
          ) : raw ? (
            <MarkdownView sections={[{ title: '', body: raw.text }]} />
          ) : (
            <p className="missing">
              没在 <code>细纲/</code> 目录里找到第 {chapterNumber} 章的 md 文件。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
