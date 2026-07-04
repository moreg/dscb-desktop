import { useEffect, useState, useCallback } from 'react'
import type {
  TeardownEntry,
  TeardownRouteResult,
  TeardownProgressInfo,
  TeardownFileNode,
  TeardownLengthKind
} from '../../shared/types'

const STAGE_ORDER_LABELS: { stage: number; label: string; short?: boolean }[] = [
  { stage: 0, label: '概要', short: false },
  { stage: 0.5, label: '章节边界', short: false },
  { stage: 1, label: '黄金三章', short: false },
  { stage: 2, label: '逐章摘要' },
  { stage: 3, label: '聚合分析' },
  { stage: 4, label: '设定角色' },
  { stage: 5, label: '汇总报告' },
  { stage: 6, label: '文风' }
]

const SHORT_STAGE_LABELS: { stage: number; label: string }[] = [
  { stage: 2, label: '结构节点' },
  { stage: 3, label: '情感爆点' },
  { stage: 4, label: '反转手法' },
  { stage: 5, label: '人物首尾' },
  { stage: 6, label: '综合评估' }
]

export default function TeardownPage(): React.ReactElement {
  const [entries, setEntries] = useState<TeardownEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [streamLog, setStreamLog] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TeardownProgressInfo | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    void window.api.listTeardowns().then((list) => {
      setEntries(list)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 轮询选中书的进度
  useEffect(() => {
    if (!selected) return
    let active = true
    const poll = async (): Promise<void> => {
      if (!active || !selected) return
      try {
        const p = await window.api.getTeardownProgress(selected)
        if (active) setProgress(p)
      } catch {
        // ignore
      }
    }
    void poll()
    const timer = setInterval(poll, 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [selected])

  const selectedEntry = entries.find((e) => e.bookName === selected) ?? null

  const handleStart = async (
    bookName: string,
    rawText: string,
    lengthKindOverride?: TeardownLengthKind,
    platform?: string
  ): Promise<TeardownRouteResult> => {
    return window.api.startTeardown({ bookName, rawText, lengthKindOverride, platform })
  }

  const handleRun = async (bookName: string, lengthKind: TeardownLengthKind): Promise<void> => {
    setRunning(true)
    setStreamLog('')
    try {
      await window.api.runTeardown(bookName, lengthKind, (token) => {
        setStreamLog((prev) => prev + token)
      })
    } catch (err) {
      setStreamLog((prev) => prev + `\n⚠ 运行失败：${(err as Error).message}\n`)
    } finally {
      setRunning(false)
      refresh()
    }
  }

  const handleContinue = async (bookName: string): Promise<void> => {
    setRunning(true)
    setStreamLog('')
    try {
      await window.api.continueTeardown(bookName, (token) => {
        setStreamLog((prev) => prev + token)
      })
    } catch (err) {
      setStreamLog((prev) => prev + `\n⚠ 继续运行失败：${(err as Error).message}\n`)
    } finally {
      setRunning(false)
      refresh()
    }
  }

  const handleDelete = async (bookName: string): Promise<void> => {
    if (!confirm(`确定删除《${bookName}》的整份拆文库？此操作不可恢复。`)) return
    try {
      await window.api.deleteTeardown(bookName)
      if (selected === bookName) setSelected(null)
      refresh()
    } catch (err) {
      alert(`删除失败：${(err as Error).message}`)
    }
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>拆文库</h1>
            <p className="desc">看懂别人的爆款，才能写出自己的爆款 · 长短篇结构化拆解</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 拆解新书
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span className="filter-chip">拆解 {entries.length}</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
          {loading ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, marginTop: 8 }}>
        {/* 左：拆解列表 */}
        <div>
          {loading ? (
            <p className="empty">加载中…</p>
          ) : entries.length === 0 ? (
            <div className="placeholder" style={{ marginTop: 16 }}>
              <p style={{ margin: '0 0 12px', fontSize: 14 }}>还没有拆解记录。粘贴一本小说开始吧。</p>
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                + 拆解新书
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entries.map((e) => (
                <button
                  key={e.bookName}
                  type="button"
                  className={`project-card${selected === e.bookName ? ' active' : ''}`}
                  style={{ cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => setSelected(e.bookName)}
                >
                  <div className="pc-head">
                    <div className="pc-title">
                      <div className="pc-name">{e.bookName}</div>
                      <div className="pc-genre">
                        {e.lengthKind === 'long' ? '长篇' : '短篇'} · {(e.wordCount / 10000).toFixed(1)} 万字
                        {e.pausedAfterStage1 ? ' · ⏸ 待继续' : ''}
                      </div>
                    </div>
                  </div>
                  <div className="pc-foot" style={{ marginTop: 6 }}>
                    <StageBadges entry={e} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 右：详情 / 运行 */}
        <div>
          {!selectedEntry ? (
            <div className="placeholder" style={{ marginTop: 24 }}>
              <p style={{ margin: 0, fontSize: 14 }}>← 从左侧选择一本书查看拆解进度与产物。</p>
            </div>
          ) : (
            <TeardownDetail
              entry={selectedEntry}
              progress={progress}
              streamLog={streamLog}
              running={running}
              onRun={() => handleRun(selectedEntry.bookName, selectedEntry.lengthKind)}
              onContinue={() => handleContinue(selectedEntry.bookName)}
              onDelete={() => handleDelete(selectedEntry.bookName)}
            />
          )}
        </div>
      </div>

      {showNew ? (
        <NewTeardownDialog
          onClose={() => setShowNew(false)}
          onStarted={async (_route) => {
            setShowNew(false)
            await refresh()
          }}
          onStart={handleStart}
          onRun={handleRun}
        />
      ) : null}
    </div>
  )
}

function StageBadges({ entry }: { entry: TeardownEntry }): React.ReactElement {
  const labels = entry.lengthKind === 'long' ? STAGE_ORDER_LABELS : SHORT_STAGE_LABELS
  const done = new Set(entry.stagesCompleted.map((s) => Number(s)))
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {labels.map((s) => (
        <span
          key={s.stage}
          className="filter-chip"
          style={{
            fontSize: 11,
            padding: '1px 6px',
            opacity: done.has(s.stage) ? 1 : 0.4,
            background: done.has(s.stage) ? 'var(--accent-soft, #e8f0fe)' : undefined
          }}
        >
          {done.has(s.stage) ? '✓' : ''} {s.label}
        </span>
      ))}
    </span>
  )
}

function TeardownDetail({
  entry,
  progress,
  streamLog,
  running,
  onRun,
  onContinue,
  onDelete
}: {
  entry: TeardownEntry
  progress: TeardownProgressInfo | null
  streamLog: string
  running: boolean
  onRun: () => void
  onContinue: () => void
  onDelete: () => void
}): React.ReactElement {
  const [files, setFiles] = useState<TeardownFileNode[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [loadingFiles, setLoadingFiles] = useState(false)

  const refreshFiles = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const list = await window.api.getTeardownFiles(entry.bookName)
      setFiles(list.filter((f) => !f.isDir))
    } finally {
      setLoadingFiles(false)
    }
  }, [entry.bookName])

  useEffect(() => {
    void refreshFiles()
  }, [refreshFiles, entry.stagesCompleted])

  const openFile = async (path: string): Promise<void> => {
    setActiveFile(path)
    try {
      const content = await window.api.readTeardownFile(entry.bookName, path)
      setFileContent(content?.content ?? '（文件为空或读取失败）')
    } catch (err) {
      setFileContent(`读取失败：${(err as Error).message}`)
    }
  }

  const isComplete = progress?.statusText === '拆解完成'
  const canContinue = entry.pausedAfterStage1 === true

  return (
    <div>
      <div className="page-head" style={{ marginTop: 0 }}>
        <div className="page-head-row">
          <div>
            <h2 style={{ margin: 0 }}>《{entry.bookName}》</h2>
            <p className="desc" style={{ marginTop: 4 }}>
              {entry.lengthKind === 'long' ? '长篇' : '短篇'} · {(entry.wordCount / 10000).toFixed(1)} 万字
              {progress ? ` · ${progress.statusText}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {canContinue ? (
              <button className="btn btn-primary" onClick={onContinue} disabled={running}>
                {running ? '运行中…' : '▶ 继续全量拆解'}
              </button>
            ) : isComplete ? (
              <button className="btn btn-ghost" onClick={refreshFiles} disabled={loadingFiles}>
                {loadingFiles ? '刷新中…' : '↻ 刷新产物'}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={onRun} disabled={running}>
                {running ? '运行中…' : entry.stagesCompleted.length > 0 ? '▶ 继续运行' : '▶ 开始拆解'}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={onDelete} disabled={running}>
              删除
            </button>
          </div>
        </div>
      </div>

      {streamLog ? (
        <pre
          style={{
            background: 'var(--bg-code, #1e1e2e)',
            color: 'var(--fg-code, #cdd6f4)',
            padding: 12,
            borderRadius: 8,
            maxHeight: 240,
            overflow: 'auto',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            margin: '8px 0'
          }}
        >
          {streamLog}
        </pre>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, marginTop: 12 }}>
        {/* 产物文件树 */}
        <div>
          <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>产物文件</h3>
          {loadingFiles ? (
            <p className="empty">加载中…</p>
          ) : files.length === 0 ? (
            <p className="empty">尚无产物（拆解运行后生成）</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`nav-item${activeFile === f.path ? ' active' : ''}`}
                  style={{ fontSize: 12, padding: '4px 8px', textAlign: 'left' }}
                  title={f.path}
                  onClick={() => openFile(f.path)}
                >
                  📄 {f.path}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 文件内容预览 */}
        <div>
          {activeFile ? (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8
                }}
              >
                <strong style={{ fontSize: 13 }}>{activeFile}</strong>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigator.clipboard.writeText(fileContent)}
                >
                  复制
                </button>
              </div>
              <pre
                style={{
                  background: 'var(--bg-code, #f6f8fa)',
                  padding: 12,
                  borderRadius: 8,
                  maxHeight: 480,
                  overflow: 'auto',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  margin: 0
                }}
              >
                {fileContent}
              </pre>
            </div>
          ) : (
            <div className="placeholder" style={{ marginTop: 24 }}>
              <p style={{ margin: 0, fontSize: 13 }}>← 从左侧选择产物文件预览内容。</p>
              <p className="meta" style={{ marginTop: 8, fontSize: 12 }}>
                权威产物：节奏.md / 情绪模块.md（长篇）、情节节点.md / 写作手法.md（短篇）
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NewTeardownDialog({
  onClose,
  onStarted,
  onStart,
  onRun
}: {
  onClose: () => void
  onStarted: (route: TeardownRouteResult) => void | Promise<void>
  onStart: (
    bookName: string,
    rawText: string,
    lengthKindOverride?: TeardownLengthKind,
    platform?: string
  ) => Promise<TeardownRouteResult>
  onRun: (bookName: string, lengthKind: TeardownLengthKind) => Promise<void>
}): React.ReactElement {
  const [bookName, setBookName] = useState('')
  const [rawText, setRawText] = useState('')
  const [platform, setPlatform] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [grayZone, setGrayZone] = useState<TeardownRouteResult | null>(null)

  const submit = async (): Promise<void> => {
    if (!bookName.trim() || !rawText.trim()) return
    setStarting(true)
    setError('')
    try {
      const route = await onStart(bookName.trim(), rawText.trim(), undefined, platform.trim() || undefined)
      if (route.isGrayZone) {
        setGrayZone(route)
        return
      }
      // 直接运行
      await onRun(bookName.trim(), route.lengthKind)
      await onStarted(route)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const confirmGrayZone = async (choice: TeardownLengthKind): Promise<void> => {
    if (!bookName.trim()) return
    setStarting(true)
    setError('')
    try {
      // 重新 start，用 override 固定篇幅
      const route = await onStart(bookName.trim(), rawText.trim(), choice, platform.trim() || undefined)
      setGrayZone(null)
      await onRun(bookName.trim(), route.lengthKind)
      await onStarted(route)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <h3>拆解新书</h3>
        <p className="meta" style={{ marginTop: 4 }}>
          粘贴小说全文。系统按字数自动判定长短篇（&lt;1.5万短篇 / &gt;2万长篇 / 灰区询问）。
        </p>

        {grayZone ? (
          <div className="field">
            <label>篇幅确认</label>
            <p className="meta">
              本书约 {(grayZone.wordCount / 10000).toFixed(1)} 万字，处于 1.5-2 万灰区。
              短篇管道节点更密、反转分析更细；长篇管道按章节切片、含黄金三章。
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary" onClick={() => confirmGrayZone('short')} disabled={starting}>
                按短篇拆（推荐）
              </button>
              <button className="btn btn-ghost" onClick={() => confirmGrayZone('long')} disabled={starting}>
                按长篇拆
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label>书名 *</label>
              <input
                className="input"
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
                placeholder="《盘龙》"
                autoFocus
              />
            </div>
            <div className="field">
              <label>平台/来源（可选）</label>
              <input
                className="input"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                placeholder="起点 / 番茄 / 知乎盐言…"
              />
            </div>
            <div className="field">
              <label>原文 *</label>
              <textarea
                className="textarea"
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={10}
                placeholder="粘贴小说全文（支持「第N章」标题自动切片）…"
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <p className="meta" style={{ marginTop: 4 }}>
                约 {rawText.length.toLocaleString()} 字
              </p>
            </div>
          </>
        )}

        {error ? <p className="diag-msg" style={{ color: '#dc2626' }}>{error}</p> : null}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          {!grayZone ? (
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={starting || !bookName.trim() || !rawText.trim()}
            >
              {starting ? '启动中…' : '开始拆解'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
