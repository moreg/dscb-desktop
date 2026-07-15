import { useEffect, useState } from 'react'
import type { TrackingView } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenForeshadowings: () => void
}

type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; added: number; updated: number }
  | { kind: 'error'; message: string }

/** 问题状态 -> chip class */
function issueStatusChip(status: string): string {
  if (!status) return ''
  if (status.includes('已修正') || status.includes('已解决') || status.includes('已处理')) {
    return 'chip chip-success'
  }
  if (status.includes('待处理') || status.includes('处理中') || status.includes('未解决')) {
    return 'chip chip-warning'
  }
  return 'chip'
}

/**
 * 追踪页：展示 `追踪/` 目录下的角色状态 / 时间线 / 写作进度 / 问题记录 / 伏笔统计。
 * 数据来自后端 `tracking:read` IPC（TrackingMdRepo.readForDisplay + ForeshadowingMdRepo 统计）。
 */
export default function TrackingPage({ projectId, onOpenForeshadowings }: Props) {
  const [data, setData] = useState<TrackingView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'idle' })
  const [showAllIssues, setShowAllIssues] = useState(false)
  const [timelineExpanded, setTimelineExpanded] = useState(false)

  const refresh = () => {
    setLoading(true)
    setError('')
    void window.api
      .readTracking(projectId)
      .then((result) => {
        setData(result)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }

  useEffect(() => {
    refresh()
  }, [projectId])

  const onSync = async () => {
    setSyncStatus({ kind: 'running' })
    try {
      const report = await window.api.syncMemoryIndex(projectId)
      setSyncStatus({ kind: 'done', added: report.added, updated: report.updated })
      refresh()
      setTimeout(
        () => setSyncStatus((s) => (s.kind === 'done' ? { kind: 'idle' } : s)),
        3000
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSyncStatus({ kind: 'error', message })
    }
  }

  // 解析时间线表格原文为行（复用 md-parser 的 GFM 表格逻辑的简化版）
  const timelineRows = data?.timeline ? parseTimelineRows(data.timeline) : []
  const visibleTimelineRows = timelineExpanded ? timelineRows : timelineRows.slice(0, 8)

  const issuesToShow = showAllIssues ? data?.allIssues ?? [] : data?.openIssues ?? []

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>追踪</h1>
            <p className="desc">角色状态 · 时间线 · 写作进度 · 问题记录 · 伏笔统计</p>
          </div>
          <div className="btn-group">
            <button className="btn btn-ghost btn-sm" onClick={onSync} disabled={syncStatus.kind === 'running'}>
              {syncStatus.kind === 'running' ? '同步中…' : '🔄 刷新记忆索引'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
              {loading ? '加载中…' : '⟳ 刷新'}
            </button>
          </div>
        </div>
        {syncStatus.kind === 'done' ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            ✓ 同步完成：新增 {syncStatus.added}，更新 {syncStatus.updated}
          </p>
        ) : null}
        {syncStatus.kind === 'error' ? (
          <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
            ⚠ {syncStatus.message}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="err" style={{ fontSize: 13 }}>
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="muted">加载追踪数据中…</p>
      ) : !data ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <p className="muted">尚未创建追踪文件。</p>
          <p className="meta" style={{ fontSize: 12, marginTop: 8 }}>
            可在项目目录下手动创建 `追踪/` 中的角色状态、时间线、上下文、问题记录文件。
          </p>
        </div>
      ) : (
        <>
          {/* 角色状态快照 */}
          <section className="tracking-section">
            <h2 className="tracking-section-title">
              🧑 角色状态快照
              <span className="meta" style={{ fontSize: 12, fontWeight: 400 }}>
                {data.characterStates.length} 个角色
              </span>
            </h2>
            {data.characterStates.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                暂无角色状态数据。
              </p>
            ) : (
              <div className="tracking-table-wrap">
                <table className="tracking-table">
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>当前实力</th>
                      <th>当前立场</th>
                      <th>当前目标</th>
                      <th>关键道具</th>
                      <th>关系快照</th>
                      <th>更新章节</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.characterStates.map((c, i) => (
                      <tr key={i}>
                        <td><strong>{c.name}</strong></td>
                        <td>{c.power}</td>
                        <td>{c.stance}</td>
                        <td>{c.goal}</td>
                        <td>{c.items}</td>
                        <td>{c.relations}</td>
                        <td>
                          {c.updateChapter > 0 ? `第 ${c.updateChapter} 章` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 时间线 */}
          <section className="tracking-section">
            <h2 className="tracking-section-title">
              ⌛ 时间线
              <span className="meta" style={{ fontSize: 12, fontWeight: 400 }}>
                {timelineRows.length} 条事件
              </span>
            </h2>
            {timelineRows.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                暂无时间线数据。
              </p>
            ) : (
              <div className="tracking-table-wrap">
                <table className="tracking-table">
                  <thead>
                    <tr>
                      <th>章节</th>
                      <th>事件名</th>
                      <th>时间跨度</th>
                      <th>涉及角色</th>
                      <th>详细描述</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTimelineRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.chapter}</td>
                        <td><strong>{r.event}</strong></td>
                        <td>{r.span}</td>
                        <td>{r.characters}</td>
                        <td>{r.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {timelineRows.length > 8 ? (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setTimelineExpanded((v) => !v)}
              >
                {timelineExpanded ? '收起' : `展开全部 ${timelineRows.length} 条`}
              </button>
            ) : null}
          </section>

          {/* 写作进度 */}
          <section className="tracking-section">
            <h2 className="tracking-section-title">
              📝 写作进度
              <span className="meta" style={{ fontSize: 12, fontWeight: 400 }}>
                {data.recentProgress.length} 条记录
              </span>
            </h2>
            {data.recentProgress.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                暂无写作进度记录（记忆提取应用后会自动追加）。
              </p>
            ) : (
              <div className="tracking-table-wrap">
                <table className="tracking-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>章节</th>
                      <th>进度摘要</th>
                      <th>下一章目标</th>
                      <th>阻塞点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentProgress.map((p, i) => (
                      <tr key={i}>
                        <td>{p.date}</td>
                        <td>{p.chapter}</td>
                        <td>{p.summary}</td>
                        <td>{p.nextGoal}</td>
                        <td>{p.blocker}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 问题记录 */}
          <section className="tracking-section">
            <h2 className="tracking-section-title">
              ⚠ 问题记录
              <span className="meta" style={{ fontSize: 12, fontWeight: 400 }}>
                {showAllIssues
                  ? `全部 ${data.allIssues.length} 条`
                  : `待处理 ${data.openIssues.length} 条`}
              </span>
            </h2>
            {issuesToShow.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                {showAllIssues ? '暂无问题记录。' : '暂无待处理问题。'}
              </p>
            ) : (
              <div className="tracking-table-wrap">
                <table className="tracking-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>问题描述</th>
                      <th>原因分析</th>
                      <th>修正方案</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issuesToShow.map((issue, i) => (
                      <tr key={i}>
                        <td>{issue.date}</td>
                        <td>{issue.problem}</td>
                        <td>{issue.analysis}</td>
                        <td>{issue.fix}</td>
                        <td>
                          {issue.status ? (
                            <span className={issueStatusChip(issue.status)}>{issue.status}</span>
                          ) : (
                            '-'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.allIssues.length > 0 ? (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setShowAllIssues((v) => !v)}
              >
                {showAllIssues
                  ? `只看待处理 (${data.openIssues.length})`
                  : `查看全部 (${data.allIssues.length})`}
              </button>
            ) : null}
          </section>

          {/* 伏笔统计 */}
          <section className="tracking-section">
            <h2 className="tracking-section-title">🎯 伏笔统计</h2>
            <div className="card-grid" style={{ marginBottom: 12 }}>
              <div className="card card-hover" onClick={onOpenForeshadowings}>
                <div className="memory-card">
                  <div className="memory-icon">🎯</div>
                  <div>
                    <strong style={{ fontSize: 16 }}>伏笔看板</strong>
                    <div className="muted">埋设与回收 · 状态追踪</div>
                    <div className="memory-stats">
                      <span>
                        <span className="num">{data.foreshadowingSummary.total}</span>条
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="memory-card">
                  <div className="memory-icon">📍</div>
                  <div>
                    <strong style={{ fontSize: 16 }}>状态分布</strong>
                    <div className="memory-stats" style={{ marginTop: 8, flexWrap: 'wrap' as const }}>
                      <span className="chip">待埋 {data.foreshadowingSummary.pending}</span>
                      <span className="chip chip-warning">已埋 {data.foreshadowingSummary.planted}</span>
                      <span className="chip chip-success">已收 {data.foreshadowingSummary.collected}</span>
                      <span className="chip chip-danger">遗漏 {data.foreshadowingSummary.missed}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/**
 * 解析时间线表格原文为行（简化版 GFM 表格解析，与 md-parser.parseTable 一致逻辑）。
 * 表头：章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述
 */
function parseTimelineRows(text: string): Array<{
  chapter: string
  event: string
  span: string
  characters: string
  description: string
}> {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
  if (lines.length < 2) return []
  const headers = splitRow(lines[0])
  const idx = {
    chapter: headers.findIndex((h) => h.includes('章节')),
    event: headers.findIndex((h) => h.includes('事件')),
    span: headers.findIndex((h) => h.includes('时间') || h.includes('跨度')),
    characters: headers.findIndex((h) => h.includes('角色') || h.includes('涉及')),
    description: headers.findIndex((h) => h.includes('描述') || h.includes('详细'))
  }
  const result: Array<{
    chapter: string
    event: string
    span: string
    characters: string
    description: string
  }> = []
  for (let i = 1; i < lines.length; i++) {
    if (isSeparatorRow(lines[i])) continue
    const row = splitRow(lines[i])
    if (row.every((c) => !c.trim())) continue
    result.push({
      chapter: idx.chapter >= 0 ? row[idx.chapter].trim() : '',
      event: idx.event >= 0 ? row[idx.event].trim() : '',
      span: idx.span >= 0 ? row[idx.span].trim() : '',
      characters: idx.characters >= 0 ? row[idx.characters].trim() : '',
      description: idx.description >= 0 ? row[idx.description].trim() : ''
    })
  }
  return result
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isSeparatorRow(line: string): boolean {
  return splitRow(line).every((c) => /^:?-+:?$/.test(c))
}
