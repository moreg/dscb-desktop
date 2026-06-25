import { useEffect, useMemo, useState } from 'react'
import type { AuditReport, AuditViolation, WriteAuditMode } from '../../shared/types'
import { violationKey, pruneHumanizeMap } from '../../main/data/chapter-audit'
import { dedupeForbiddenViolations } from './audit-dedupe'
import { isReviewKey } from '../../shared/review-suggestions'

interface RewriteEntry {
  oldSnippet: string
  newText: string
  at: number
  violationKey?: string
}

interface Props {
  projectId: string
  /** P17-A：当前章节号（用于把 humanize 调用归属到具体章节） */
  chapterNumber?: number
  draft?: string
  report: AuditReport | null
  loading: boolean
  mode: WriteAuditMode
  /** 触发再次质检 */
  onRunAgain?: () => void
  /** 跳到指定 offset 的回调（PR 后续接入正文滚动定位时再启用） */
  onJumpToOffset?: (offset: number) => void
  /** 把改写结果回填到正文的回调（用于「应用到正文」按钮）。
   * P6-B：第三参 violationKey 让父组件按稳定键精确记录这次应用，便于 per-violation 撤销。
   * 返回值：是否真正应用成功。false 表示 snippet 为空或在正文中找不到（如已被其他改写覆盖），
   * 此时调用方不应标记 appliedAt——否则会出现"提示已应用但正文未变"。 */
  onApplyRewrite?: (snippet: string, rewritten: string, violationKey: string) => boolean
  /** 撤销最近一次改写（顶层按钮快捷路径） */
  onUndoRewrite?: () => void | Promise<void>
  /** 撤销指定位置的改写（0=最近一次，1=次新...）— 用于下拉菜单 */
  onUndoRewriteAt?: (fromTop: number) => void | Promise<void>
  /** P6-B：按 violationKey 精确撤销对应那条应用 — 用于"↶ 撤销这次"按钮 */
  onUndoRewriteByKey?: (violationKey: string) => void | Promise<void>
  /** P7-A：重做最近一次被撤销的应用 */
  onRedoRewrite?: () => void | Promise<void>
  /** P7-A：redoStack 长度（用于按钮文案） */
  redoStackCount?: number
  /** 改写历史栈完整数据（最新在末尾）— 用于下拉菜单显示每条 */
  rewriteHistory?: readonly RewriteEntry[]
}

const CATEGORY_LABEL: Record<string, string> = {
  ending: '章末形式',
  forbidden_word: '禁用高频词',
  word_count: '字数',
  rule: '写作规则'
}

const SEVERITY_LABEL: Record<string, string> = {
  error: '错误',
  warn: '提醒',
  info: '建议'
}

const SEVERITY_CLASS: Record<string, string> = {
  error: 'audit-pill audit-pill-error',
  warn: 'audit-pill audit-pill-warn',
  info: 'audit-pill audit-pill-info'
}

export default function ChapterAuditPanel({
  projectId,
  chapterNumber,
  draft,
  report,
  loading,
  mode,
  onRunAgain,
  onJumpToOffset,
  onApplyRewrite,
  onUndoRewrite,
  onUndoRewriteAt,
  onUndoRewriteByKey,
  onRedoRewrite,
  redoStackCount,
  rewriteHistory
}: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 })
  const [undoMenuOpen, setUndoMenuOpen] = useState(false)
  // 每条 violation 的 humanize 状态：key = violationKey(v)，value = {loading, result, error, appliedAt}
  // appliedAt 标记"用户已把此条改写应用到正文"，用于显示"已应用"角标和"↶ 撤销这次"按钮。
  const [humanizeMap, setHumanizeMap] = useState<
    Record<
      string,
      {
        loading: boolean
        result?: { rewritten: string; reason: string }
        error?: string
        appliedAt?: number
      }
    >
  >({})

  // P4-C + P5-C 修复：re-audit 后报告结构可能变化（旧违例消失/新违例出现/顺序变化）。
  // P4-C 一刀切清空：安全但丢失工作。
  // P5-C 升级：按稳定键（category:word:offset）选择性清理——仍存在的违例保留 humanize 结果。
  useEffect(() => {
    if (report) {
      setHumanizeMap((m) => pruneHumanizeMap(report.violations, m))
    } else {
      setHumanizeMap({})
    }
    setUndoMenuOpen(false)
  }, [report])

  // 点下拉菜单外区域时关闭
  useEffect(() => {
    if (!undoMenuOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('.audit-undo-menu-root')) return
      setUndoMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [undoMenuOpen])

  const handleHumanize = async (v: AuditViolation, key: string) => {
    if (!v.snippet) return
    setHumanizeMap((m) => ({ ...m, [key]: { loading: true } }))
    try {
      const result = await window.api.humanizeSegment(
        projectId,
        v.snippet,
        v.ruleId ?? v.message,
        chapterNumber
      )
      if (!result.rewritten) {
        setHumanizeMap((m) => ({
          ...m,
          [key]: { loading: false, error: result.reason || '改写失败' }
        }))
      } else {
        setHumanizeMap((m) => ({ ...m, [key]: { loading: false, result } }))
      }
    } catch (err) {
      setHumanizeMap((m) => ({
        ...m,
        [key]: { loading: false, error: (err as Error).message }
      }))
    }
  }

  const copyRewrite = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore
    }
  }

  /**
   * 批量改写本面板所有可改写的违例（串行，避免并发触发 LLM 限流）。
   * 已有 result 的会跳过；失败的会标 error 不阻断后续。
   */
  const handleBatchHumanize = async () => {
    if (!report) return
    const targets: Array<{ v: AuditViolation; key: string }> = []
    for (const cat of Object.keys(grouped) as Array<keyof typeof grouped>) {
      const items = grouped[cat]
      if (!items) continue
      items.slice(0, 50).forEach((v, i) => {
        if (!v.snippet || v.category === 'word_count') return
        const key = `${cat}-${i}`
        if (humanizeMap[key]?.result) return // 已有结果
        targets.push({ v, key })
      })
    }
    if (targets.length === 0) return
    setBatchRunning(true)
    setBatchProgress({ done: 0, total: targets.length })
    for (let i = 0; i < targets.length; i++) {
      const { v, key } = targets[i]
      setHumanizeMap((m) => ({ ...m, [key]: { loading: true } }))
      try {
        const result = await window.api.humanizeSegment(
          projectId,
          v.snippet!,
          v.ruleId ?? v.message,
          chapterNumber
        )
        if (!result.rewritten) {
          setHumanizeMap((m) => ({
            ...m,
            [key]: { loading: false, error: result.reason || '改写失败' }
          }))
        } else {
          setHumanizeMap((m) => ({ ...m, [key]: { loading: false, result } }))
        }
      } catch (err) {
        setHumanizeMap((m) => ({
          ...m,
          [key]: { loading: false, error: (err as Error).message }
        }))
      }
      setBatchProgress({ done: i + 1, total: targets.length })
    }
    setBatchRunning(false)
  }

  const grouped = useMemo(() => groupViolations(report?.violations ?? []), [report])
  // 展示计数基于去重后的 grouped，与列表实际条数一致；
  // report.counts 仍含前缀重叠的重复命中（如「轰」+「轰然」），不宜直接用于展示。
  const { errorCount, warnCount, infoCount } = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 }
    for (const k of Object.keys(grouped) as Array<keyof typeof grouped>) {
      for (const v of grouped[k] ?? []) c[v.severity]++
    }
    return { errorCount: c.error, warnCount: c.warn, infoCount: c.info }
  }, [grouped])

  if (!report && !loading) {
    return (
      <div className="audit-panel audit-panel-idle">
        <span className="muted">尚未质检</span>
        {onRunAgain && (
          <button className="btn btn-sm" onClick={onRunAgain}>
            ▶ 立即质检
          </button>
        )}
      </div>
    )
  }

  const blocked = mode === 'strict' && errorCount > 0

  return (
    <div className={`audit-panel ${blocked ? 'audit-panel-blocked' : ''}`}>
      <div className="audit-panel-header">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="audit-panel-title">
          {loading ? '质检中…' : '续写质检'}
        </span>
        {report && (
          <>
            <span className="audit-counts">
              <span className={SEVERITY_CLASS.error}>错误 {errorCount}</span>
              <span className={SEVERITY_CLASS.warn}>提醒 {warnCount}</span>
              <span className={SEVERITY_CLASS.info}>建议 {infoCount}</span>
            </span>
            <span className="audit-wordcount">
              字数 <strong>{report.wordCount}</strong>
              {report.passed.wordCount ? '' : ' ⚠'}
            </span>
          </>
        )}
        <span className="spacer" />
        {blocked && (
          <span className="audit-blocked-hint">strict 模式：错误需修复后才能保存</span>
        )}
        {batchRunning && (
          <span className="muted" style={{ fontSize: 12 }}>
            批量改写 {batchProgress.done}/{batchProgress.total}…
          </span>
        )}
        {onUndoRewrite && (rewriteHistory?.length ?? 0) > 0 && (
          <div className="audit-undo-menu-root" style={{ position: 'relative' }}>
            <button
              className="btn btn-sm"
              onClick={() => setUndoMenuOpen((o) => !o)}
              title="把已应用的改写从正文回滚（可选择具体某条）"
            >
              ↶ 撤销{(rewriteHistory?.length ?? 0) > 1 ? ` ×${rewriteHistory?.length}` : ''} ▾
            </button>
            {onRedoRewrite && (redoStackCount ?? 0) > 0 && (
              <button
                className="btn btn-sm"
                onClick={onRedoRewrite}
                title="重做最近一次被撤销的改写"
                style={{ marginLeft: 4 }}
              >
                ↷ 重做{(redoStackCount ?? 0) > 1 ? ` ×${redoStackCount}` : ''}
              </button>
            )}
            {undoMenuOpen && rewriteHistory && (
              <div className="audit-undo-dropdown" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-lg)', width: '340px' }}>
                <div className="audit-undo-dropdown-title">
                  选择要撤销的改写（最近的在最上）
                </div>
                <ul className="audit-undo-list">
                  {(() => {
                    const getRuleName = (key?: string) => {
                      if (!key) return '自定义改写'
                      if (isReviewKey(key)) return 'AI 改稿建议'
                      const v = report?.violations.find(x => violationKey(x) === key)
                      if (v) {
                        if (v.category === 'forbidden_word') return '禁用高频词: ' + v.word
                        if (v.category === 'rule') {
                          if (v.ruleId === 'cliche') return '水文/套路检查'
                          return v.ruleId || '规则违例'
                        }
                        return v.message || v.category
                      }
                      const parts = key.split(':')
                      if (parts.length > 0) {
                        const cat = parts[0]
                        if (cat === 'forbidden_word') return '禁用高频词: ' + (parts[1] || '')
                        if (cat === 'cliche') return '水文套路'
                        if (cat === 'rule') return parts[1] || '规则检查'
                        return cat
                      }
                      return '质检改写'
                    }

                    return rewriteHistory
                      .slice()
                      .reverse()
                      .map((e, i) => {
                        const fromTop = rewriteHistory.length - 1 - i
                        return (
                          <li key={e.at} className="audit-undo-card" style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                            <div className="undo-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <span className="undo-badge" style={{ background: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--ink-2)', fontSize: '10.5px', padding: '1px 5px', borderRadius: 3 }}>{getRuleName(e.violationKey)}</span>
                              <span className="undo-time" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>{new Date(e.at).toLocaleTimeString()}</span>
                            </div>
                            <div className="undo-card-diff" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 11, fontFamily: 'var(--font-serif)', lineHeight: 1.4, maxHeight: 100, overflowY: 'auto' }}>
                              <div className="diff-line del" style={{ color: 'var(--vermilion)', textDecoration: 'line-through', marginBottom: 3, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>- {e.oldSnippet}</div>
                              <div className="diff-line add" style={{ color: 'var(--success)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>+ {e.newText}</div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => {
                                  setUndoMenuOpen(false)
                                  void onUndoRewriteAt?.(fromTop)
                                }}
                                style={{ padding: '2px 8px', fontSize: 11 }}
                              >
                                ↶ 撤销此条
                              </button>
                            </div>
                          </li>
                        )
                      })
                  })()}
                </ul>
                {onUndoRewrite && (
                  <div className="audit-undo-dropdown-footer">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setUndoMenuOpen(false)
                        void onUndoRewrite()
                      }}
                    >
                      撤销最近一条（快捷）
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <button
          className="btn btn-sm"
          onClick={handleBatchHumanize}
          disabled={batchRunning || !report}
          title="串行改写所有可改写的违例（约 1-2 秒/条）"
        >
          {batchRunning ? `改写中…` : '✎ 批量改写'}
        </button>
        {onRunAgain && (
          <button className="btn btn-sm" onClick={onRunAgain} disabled={loading}>
            重新质检
          </button>
        )}
      </div>

      {!collapsed && report && (
        <div className="audit-panel-body">
          {(Object.keys(grouped) as Array<keyof typeof grouped>).map((cat) => {
            const items = grouped[cat]
            if (!items || items.length === 0) return null
            return (
              <section className="audit-section" key={cat}>
                <h4 className="audit-section-title">
                  {CATEGORY_LABEL[cat] ?? cat}
                  <span className="muted">（{items.length}）</span>
                </h4>
                <ul className="audit-list">
                  {items.slice(0, 50).map((v, i) => {
                    const hKey = violationKey(v)
                    const hState = humanizeMap[hKey]
                    const lineNum = v.offset != null && draft
                      ? draft.substring(0, v.offset).split('\n').length
                      : null
                    return (
                      <li key={i} className={`audit-item audit-item-${v.severity}`}>
                        <span className={SEVERITY_CLASS[v.severity]}>
                          {SEVERITY_LABEL[v.severity] ?? v.severity}
                        </span>
                        {lineNum != null && (
                          <span
                            className="audit-pill"
                            style={{
                              marginLeft: 4,
                              background: 'var(--surface-2)',
                              color: 'var(--ink-2)',
                              borderColor: 'var(--line-soft)',
                              fontSize: '10.5px'
                            }}
                          >
                            第 {lineNum} 行
                          </span>
                        )}
                        <span className="audit-message">{v.message}</span>
                        {v.snippet && (
                          <code
                            className="audit-snippet"
                            title={v.snippet}
                            onClick={
                              v.offset != null && onJumpToOffset
                                ? () => onJumpToOffset(v.offset!)
                                : undefined
                            }
                            style={{
                              cursor: v.offset != null && onJumpToOffset ? 'pointer' : 'default'
                            }}
                          >
                            {v.snippet}
                          </code>
                        )}
                        {v.suggestion && (
                          <span className="audit-suggestion">→ {v.suggestion}</span>
                        )}
                        {/* 改写按钮：仅当有 snippet 且不是章末/字数违例时启用 */}
                        {v.snippet && v.category !== 'word_count' && (
                          <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleHumanize(v, hKey)}
                              disabled={hState?.loading}
                              title="调用 LLM 按 humanizer 技能改写这段"
                            >
                              {hState?.loading ? '改写中…' : '✎ AI 改写'}
                            </button>
                            {hState?.result && (
                              <>
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => copyRewrite(hState.result!.rewritten)}
                                >
                                  复制改写
                                </button>
                                {onApplyRewrite && !hState.appliedAt && (
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                      // 1. 通知父组件 apply（修改 draft + 压栈）。
                                      // 必须按返回值决定是否标记 appliedAt——
                                      // 若 snippet 在正文中找不到（如已被其他改写覆盖），
                                      // 父组件不会改 draft，此时标"已应用"会导致
                                      // "提示已应用但正文未变"。
                                      const ok = onApplyRewrite(v.snippet!, hState.result!.rewritten, hKey)
                                      if (!ok) return
                                      // 2. 真正应用成功才标记本条为"已应用"，显示角标
                                      setHumanizeMap((m) => ({
                                        ...m,
                                        [hKey]: { ...m[hKey], appliedAt: Date.now() }
                                      }))
                                    }}
                                    title="用改写后的文本替换正文中的命中段"
                                  >
                                    应用到正文
                                  </button>
                                )}
                                {hState.appliedAt && onUndoRewrite && (
                                  <span
                                    className="audit-applied-badge"
                                    title={`已于 ${new Date(hState.appliedAt).toLocaleTimeString()} 应用此改写`}
                                  >
                                    ✓ 已应用
                                  </span>
                                )}
                                {hState.appliedAt && onUndoRewriteByKey && (
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                      // P6-B：按 violationKey 精确撤销（不影响其他已应用条目）
                                      void onUndoRewriteByKey(hKey)
                                      setHumanizeMap((m) => {
                                        const e = m[hKey]
                                        if (!e) return m
                                        return { ...m, [hKey]: { ...e, appliedAt: undefined } }
                                      })
                                    }}
                                    title="只撤销这条改写（不影响其他已应用的条目）"
                                  >
                                    ↶ 撤销这次
                                  </button>
                                )}
                              </>
                            )}
                            {hState?.error && (
                              <span className="muted" style={{ fontSize: 12 }}>
                                ⚠ {hState.error}
                              </span>
                            )}
                          </div>
                        )}
                        {hState?.result && (
                          <div className="audit-rewrite-result">
                            <div className="audit-rewrite-diff">
                              <div className="audit-rewrite-side">
                                <div className="audit-rewrite-side-label">原文</div>
                                <div className="audit-rewrite-side-text original">
                                  {v.snippet}
                                </div>
                              </div>
                              <div className="audit-rewrite-arrow">→</div>
                              <div className="audit-rewrite-side">
                                <div className="audit-rewrite-side-label rewritten-label">改写后</div>
                                <div className="audit-rewrite-side-text rewritten">
                                  {hState.result.rewritten}
                                </div>
                              </div>
                            </div>
                            {hState.result.reason && (
                              <div className="audit-rewrite-reason">
                                💡 {hState.result.reason}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                  {items.length > 50 && (
                    <li className="muted">…还有 {items.length - 50} 条同类违规未展示</li>
                  )}
                </ul>
              </section>
            )
          })}
          {report.violations.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              ✓ 三项检查全部通过
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface GroupedViolations {
  ending: AuditViolation[]
  forbidden_word: AuditViolation[]
  word_count: AuditViolation[]
  rule: AuditViolation[]
}

function groupViolations(violations: AuditViolation[]): GroupedViolations {
  const out: GroupedViolations = {
    ending: [],
    forbidden_word: [],
    word_count: [],
    rule: []
  }
  for (const v of violations) {
    out[v.category].push(v)
  }
  // 禁用词：同一 offset 上前缀重叠的词条会叠多条命中
  // （如「轰」+「轰然」、「嘴角勾起」+「嘴角勾起一抹弧度」+ 嘴角_弧度 底层模式）。
  // 展示前按 offset 去重，保留 word 最长（最具体）的那一条，避免重复提醒。
  out.forbidden_word = dedupeForbiddenViolations(out.forbidden_word)
  // 同 category 内按 severity 排序：error → warn → info
  const order: Record<string, number> = { error: 0, warn: 1, info: 2 }
  for (const k of Object.keys(out) as Array<keyof GroupedViolations>) {
    out[k].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  }
  return out
}

