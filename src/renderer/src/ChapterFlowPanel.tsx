import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  AuditReport,
  ChapterReviewReport,
  FigureDraft,
  MemoryApplyResult,
  MemoryExtraction,
  OutlineDiffReport,
  RhythmApplyResult,
  RhythmEvaluation
} from '../../shared/types'
import {
  parseFigureDraftJson,
  parseMemoryExtractionJson,
  parseOutlineDiffJson,
  parseRhythmEvaluationJson
} from '../../shared/parsers'
import {
  parseSuggestions,
  isRewritable,
  applyCandidate,
  buildReviewKey,
  parseReviewIndex,
  computeSuggestionPositions,
  type ReviewSuggestion
} from '../../shared/review-suggestions'
import type { RewriteEntry } from '../../main/data/rewrite-history'
import ChapterAuditPanel from './ChapterAuditPanel'

interface Props {
  projectId: string
  chapterNumber: number
  draft: string
  auditReport: AuditReport | null
  reviewText: string
  reviewing: boolean
  onClose: () => void
  /** AI 改写命中段后，把 snippet 替换为 rewritten（P6-B：第三参 violationKey 用于 per-violation 撤销）。
   *  返回是否真正应用成功（见 ChapterAuditPanel.onApplyRewrite 契约）。 */
  onApplyRewrite?: (snippet: string, rewritten: string, violationKey: string) => boolean
  /** 批量应用：ChapterEditor 本地构造 nextDraft、最后只 setDraft + reAudit 一次，
   *  避免 setDraft/stale closure 丢改动且避免连发 N 次审计。edits 由调用方按位置倒序排列。 */
  onApplyRewriteBatch?: (
    edits: Array<{ snippet: string; rewritten: string; violationKey: string }>
  ) => number
  onJumpToOffset?: (offset: number) => void
  /** 重新跑质检（用于"立即质检"按钮） */
  onRunAudit?: () => void | Promise<void>
  /** 撤销最近一次改写（从正文回滚） */
  onUndoRewrite?: () => void | Promise<void>
  /** 撤销指定位置的改写（0=最近一次，1=次新...） */
  onUndoRewriteAt?: (fromTop: number) => void | Promise<void>
  /** P6-B：按 violationKey 精确撤销对应那条应用 */
  onUndoRewriteByKey?: (violationKey: string) => void | Promise<void>
  /** 改写历史栈（完整数据，用于下拉菜单显示每条） */
  rewriteHistory?: RewriteEntry[]
  /** P7-A：redoStack 长度（用于显示"重做 ×N"按钮） */
  redoStackCount?: number
  /** P7-A：重做最近一次被撤销的应用 */
  onRedoRewrite?: () => void | Promise<void>
  /** 续写应用 review 建议后跳到对应的 quote 位置（编辑器焦点定位） */
  onFocusQuote?: (quote: string) => void
  /** 细纲对照完成后回调 */
  onCompleteOutline?: () => void
  /** 记忆提取完成后回调 */
  onCompleteMemory?: () => void
  /** 节奏评估完成后回调 */
  onCompleteRhythm?: () => void
  /** 图解生成完成后回调 */
  onCompleteFigure?: () => void
  /**
   * 一键同步触发器：值变化时自动触发所有同步操作。
   * 用于从外部（如未同步提醒横幅）触发"一键同步"。
   */
  syncAllTrigger?: number
}

/**
 * 续写流程面板（Phase 12 Task 2/3/4-6）。
 * 后续 Task 7-8 会继续填充：节奏回填 / Mermaid 图解。
 */
export default function ChapterFlowPanel(props: Props) {
  const {
    projectId,
    chapterNumber,
    draft,
    auditReport,
    reviewing,
    reviewText,
    onClose,
    onApplyRewrite,
    onApplyRewriteBatch,
    onJumpToOffset,
    onRunAudit,
    onUndoRewrite,
    onUndoRewriteAt,
    onUndoRewriteByKey,
    onRedoRewrite,
    redoStackCount,
    rewriteHistory,
    onCompleteOutline,
    onCompleteMemory,
    onCompleteRhythm,
    onCompleteFigure,
    syncAllTrigger,
    onFocusQuote
  } = props

  // 解析流式 review 文本为结构化卡片（原句 / 改写 / 理由）
  const reviewSuggestions = useMemo(
    () => (reviewText ? parseSuggestions(reviewText) : []),
    [reviewText]
  )

  // 从 rewriteHistory 反推已应用的建议索引（与 ChapterEditor 旧实现一致）
  const appliedReviewIndexes = useMemo(() => {
    const set = new Set<number>()
    for (const e of rewriteHistory ?? []) {
      if (!e.violationKey) continue
      const idx = parseReviewIndex(e.violationKey)
      if (idx != null) set.add(idx)
    }
    return set
  }, [rewriteHistory])

  // 同 quote 多条建议依次匹配 draft 中的下一处
  const suggestionPositions = useMemo(
    () => computeSuggestionPositions(reviewSuggestions, draft, appliedReviewIndexes),
    [reviewSuggestions, draft, appliedReviewIndexes]
  )

  const handleApplyReviewSuggestion = (
    quote: string,
    candidate: string,
    index: number
  ): boolean => {
    if (!quote || !onApplyRewrite) return false
    const check = isRewritable(candidate, quote)
    if (!check.ok) return false
    const pos = suggestionPositions[index] ?? -1
    if (pos === -1) return false
    return onApplyRewrite(quote, candidate, buildReviewKey(index, pos))
  }

  const handleApplyAllReviewSuggestions = (): number => {
    // 优先用批量通道：ChapterEditor 本地构造 nextDraft，避免同步循环 setDraft
    // 只会保留最后一次的 closure-staleness 问题；并避免连发 N 次 reAudit。
    if (onApplyRewriteBatch) {
      const finalList = [...reviewSuggestions]
        .map((s, i) => {
          const candidate = applyCandidate(s)
          return { s, candidate, originalIndex: i, pos: suggestionPositions[i] ?? -1 }
        })
        .filter(
          (item) =>
            !!item.s.quote &&
            item.pos !== -1 &&
            !!item.candidate &&
            isRewritable(item.candidate, item.s.quote).ok
        )
        .sort((a, b) => a.pos - b.pos || b.s.quote.length - a.s.quote.length)
      let lastEnd = -1
      for (let i = 0; i < finalList.length; i++) {
        const item = finalList[i]
        if (item.pos < lastEnd) {
          finalList.splice(i, 1)
          i--
          continue
        }
        lastEnd = item.pos + item.s.quote.length
      }
      // 倒序传给 ChapterEditor：让那边在本地 nextDraft 上 indexOf 也不会因为前序替换错位
      finalList.sort((a, b) => b.pos - a.pos)
      const edits = finalList.map((item) => ({
        snippet: item.s.quote,
        rewritten: item.candidate as string,
        violationKey: buildReviewKey(item.originalIndex, item.pos)
      }))
      return onApplyRewriteBatch(edits)
    }

    // 兼容性回退：单条通道（旧用法），保留原本 N 次 onApplyRewrite 行为。
    if (!onApplyRewrite) return 0
    const finalList = [...reviewSuggestions]
      .map((s, i) => {
        const candidate = applyCandidate(s)
        return { s, candidate, originalIndex: i, pos: suggestionPositions[i] ?? -1 }
      })
      .filter(
        (item) =>
          !!item.s.quote &&
          item.pos !== -1 &&
          !!item.candidate &&
          isRewritable(item.candidate, item.s.quote).ok
      )
      .sort((a, b) => a.pos - b.pos || b.s.quote.length - a.s.quote.length)
    let lastEnd = -1
    for (let i = 0; i < finalList.length; i++) {
      const item = finalList[i]
      if (item.pos < lastEnd) {
        finalList.splice(i, 1)
        i--
        continue
      }
      lastEnd = item.pos + item.s.quote.length
    }
    finalList.sort((a, b) => b.pos - a.pos)
    let appliedCount = 0
    for (const item of finalList) {
      const ok = onApplyRewrite(
        item.s.quote,
        item.candidate as string,
        buildReviewKey(item.originalIndex, item.pos)
      )
      if (ok) appliedCount++
    }
    return appliedCount
  }

  const handleFocusReviewQuote = (quote: string) => {
    if (!quote || !onFocusQuote) return
    onFocusQuote(quote)
  }

  const [outlineChecking, setOutlineChecking] = useState(false)
  const [outlineDiff, setOutlineDiff] = useState<OutlineDiffReport | null>(null)
  const [outlineError, setOutlineError] = useState('')

  // 记忆提取状态
  const [memoryExtracting, setMemoryExtracting] = useState(false)
  const [memoryExtraction, setMemoryExtraction] = useState<MemoryExtraction | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const [memoryApplying, setMemoryApplying] = useState(false)
  const [memoryResult, setMemoryResult] = useState<MemoryApplyResult | null>(null)
  const [newCharResult, setNewCharResult] = useState<number | null>(null)
  const [newLocResult, setNewLocResult] = useState<number | null>(null)
  const [newForeshadowingResult, setNewForeshadowingResult] = useState<number | null>(null)

  // 节奏评估状态
  const [rhythmEvaluating, setRhythmEvaluating] = useState(false)
  const [rhythmEvaluation, setRhythmEvaluation] = useState<RhythmEvaluation | null>(null)
  const [rhythmError, setRhythmError] = useState('')
  const [rhythmApplying, setRhythmApplying] = useState(false)
  const [rhythmResult, setRhythmResult] = useState<RhythmApplyResult | null>(null)

  // 图解生成状态
  const [figureGenerating, setFigureGenerating] = useState(false)
  const [figureDraft, setFigureDraft] = useState<FigureDraft | null>(null)
  const [figureError, setFigureError] = useState('')
  const [figureSaving, setFigureSaving] = useState(false)
  const [figureSaved, setFigureSaved] = useState('')

  // 结构化审核报告状态（对齐「正文审核」技能第 6 步，合并进 ChapterAuditPanel）
  const [reviewReport, setReviewReport] = useState<ChapterReviewReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null)
  const [panelDragging, setPanelDragging] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelDragRef = useRef<{ offsetX: number; offsetY: number; width: number } | null>(null)

  const clampPanelPosition = (left: number, top: number, width: number) => {
    const margin = 8
    const maxLeft = Math.max(margin, window.innerWidth - width - margin)
    const maxTop = Math.max(margin, window.innerHeight - 80)
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    }
  }

  const startPanelDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, select, textarea')) return

    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return

    panelDragRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width
    }
    setPanelPosition(clampPanelPosition(rect.left, rect.top, rect.width))
    setPanelDragging(true)
    e.preventDefault()
  }

  useEffect(() => {
    if (!panelDragging) return

    const handleMove = (e: MouseEvent) => {
      const drag = panelDragRef.current
      if (!drag) return
      setPanelPosition(
        clampPanelPosition(e.clientX - drag.offsetX, e.clientY - drag.offsetY, drag.width)
      )
    }

    const handleUp = () => {
      setPanelDragging(false)
      panelDragRef.current = null
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [panelDragging])

  const generateReport = async () => {
    if (!draft.trim()) return
    setReportLoading(true)
    setReportError('')
    try {
      const r = await window.api.generateReviewReport(projectId, draft, chapterNumber)
      setReviewReport(r)
    } catch (err) {
      setReportError((err as Error).message || '生成审核报告失败')
    } finally {
      setReportLoading(false)
    }
  }

  const runOutlineCheck = async () => {
    if (!draft.trim()) {
      setOutlineError('正文为空，无法对照')
      return
    }
    setOutlineChecking(true)
    setOutlineDiff(null)
    setOutlineError('')
    let buffer = ''
    try {
      const r = await window.api.checkOutlineStream(
        projectId,
        chapterNumber,
        '',
        draft,
        (token, done) => {
          if (token) buffer += token
          if (done) setOutlineChecking(false)
        }
      )
      if (!r.ok) {
        setOutlineError(r.error ?? '对照失败')
        setOutlineChecking(false)
        return
      }
      setOutlineDiff(parseOutlineDiffJson(buffer, chapterNumber))
      onCompleteOutline?.()
    } catch (e) {
      setOutlineError((e as Error).message)
      setOutlineChecking(false)
    }
  }

  const runMemoryExtract = async () => {
    if (!draft.trim()) {
      setMemoryError('正文为空，无法提取')
      return
    }
    setMemoryExtracting(true)
    setMemoryExtraction(null)
    setMemoryError('')
    setMemoryResult(null)
    setNewCharResult(null)
    setNewLocResult(null)
    setNewForeshadowingResult(null)
    let buffer = ''
    try {
      const r = await window.api.extractMemoryStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (token) buffer += token
          if (done) setMemoryExtracting(false)
        }
      )
      if (!r.ok) {
        setMemoryError(r.error ?? '提取失败')
        setMemoryExtracting(false)
        return
      }
      setMemoryExtraction(parseMemoryExtractionJson(buffer, chapterNumber))
      onCompleteMemory?.()
    } catch (e) {
      setMemoryError((e as Error).message)
      setMemoryExtracting(false)
    }
  }

  const applyAutomatic = async () => {
    if (!memoryExtraction) return
    setMemoryApplying(true)
    try {
      const result = await window.api.applyMemory(projectId, memoryExtraction)
      setMemoryResult(result)
    } catch (e) {
      setMemoryError((e as Error).message)
    } finally {
      setMemoryApplying(false)
    }
  }

  const applyChars = async () => {
    if (!memoryExtraction?.newCharacters.length) return
    try {
      const n = await window.api.applyNewCharacters(projectId, memoryExtraction.newCharacters)
      setNewCharResult(n)
    } catch (e) {
      setMemoryError((e as Error).message)
    }
  }

  const applyLocs = async () => {
    if (!memoryExtraction?.newLocations.length) return
    try {
      const n = await window.api.applyNewLocations(projectId, memoryExtraction.newLocations)
      setNewLocResult(n)
    } catch (e) {
      setMemoryError((e as Error).message)
    }
  }

  const applyForeshadowings = async () => {
    if (!memoryExtraction?.newForeshadowings.length) return
    try {
      const n = await window.api.applyNewForeshadowings(
        projectId,
        memoryExtraction.newForeshadowings
      )
      setNewForeshadowingResult(n)
    } catch (e) {
      setMemoryError((e as Error).message)
    }
  }

  const runRhythmEvaluate = async () => {
    if (!draft.trim()) {
      setRhythmError('正文为空，无法评估')
      return
    }
    setRhythmEvaluating(true)
    setRhythmEvaluation(null)
    setRhythmError('')
    setRhythmResult(null)
    let buffer = ''
    try {
      const r = await window.api.evaluateRhythmStream(projectId, chapterNumber, (token, done) => {
        if (token) buffer += token
        if (done) setRhythmEvaluating(false)
      })
      if (!r.ok) {
        setRhythmError(r.error ?? '评估失败')
        setRhythmEvaluating(false)
        return
      }
      // parseRhythmEvaluationJson 优先用 LLM 输出的 expectedEmotion（透传字段）
      const evaluation = parseRhythmEvaluationJson(buffer, chapterNumber, 5)
      setRhythmEvaluation(evaluation)
      onCompleteRhythm?.()
      // 自动应用（diff ≤ 1）
      if (evaluation?.autoApply) {
        await applyRhythm(evaluation)
      }
    } catch (e) {
      setRhythmError((e as Error).message)
      setRhythmEvaluating(false)
    }
  }

  const applyRhythm = async (evaluation: RhythmEvaluation) => {
    setRhythmApplying(true)
    try {
      const result = await window.api.applyRhythmEvaluation(projectId, evaluation)
      setRhythmResult(result)
    } catch (e) {
      setRhythmError((e as Error).message)
    } finally {
      setRhythmApplying(false)
    }
  }

  const runFigureGenerate = async () => {
    if (!draft.trim()) {
      setFigureError('正文为空，无法生成图解')
      return
    }
    setFigureGenerating(true)
    setFigureDraft(null)
    setFigureError('')
    setFigureSaved('')
    let buffer = ''
    try {
      const r = await window.api.generateFigureStream(projectId, chapterNumber, (token, done) => {
        if (token) buffer += token
        if (done) setFigureGenerating(false)
      })
      if (!r.ok) {
        setFigureError(r.error ?? '生成失败')
        setFigureGenerating(false)
        return
      }
      setFigureDraft(parseFigureDraftJson(buffer, chapterNumber))
      onCompleteFigure?.()
    } catch (e) {
      setFigureError((e as Error).message)
      setFigureGenerating(false)
    }
  }

  const saveFigureDraft = async () => {
    if (!figureDraft?.shouldGenerate || !figureDraft.fileName || !figureDraft.html) return
    setFigureSaving(true)
    try {
      const saved = await window.api.saveFigure(
        projectId,
        figureDraft.fileName,
        figureDraft.html
      )
      setFigureSaved(saved)
    } catch (e) {
      setFigureError((e as Error).message)
    } finally {
      setFigureSaving(false)
    }
  }

  const sortedDiffs = outlineDiff
    ? [...outlineDiff.diffs].sort((a, b) => {
        const order = { P0: 0, P1: 1, P2: 2 } as const
        return order[a.priority] - order[b.priority]
      })
    : []

  const hasAutoItems =
    memoryExtraction &&
    (memoryExtraction.characterStateChanges.length > 0 ||
      memoryExtraction.newPlotPoints.length > 0 ||
      memoryExtraction.collectedForeshadowings.length > 0)

  /**
   * 一键同步：依次触发四个同步操作，每个操作独立 try/catch 确保互不影响。
   * 注意：这只是启动生成流程，应用操作（如 applyMemory）仍需用户确认。
   */
  const runAllSync = async () => {
    if (!draft.trim()) return
    // 并发执行四个操作，内部均已处理异常与状态设置
    await Promise.allSettled([
      runOutlineCheck(),
      runMemoryExtract(),
      runRhythmEvaluate(),
      runFigureGenerate()
    ])
  }

  /**
   * 一键同步：当 syncAllTrigger 变化时，依次触发四个同步操作。
   * 使用 useRef 避免首次渲染时触发。
   */
  const prevSyncAllTrigger = useRef(0)
  useEffect(() => {
    if (
      syncAllTrigger !== undefined &&
      syncAllTrigger > 0 &&
      prevSyncAllTrigger.current !== syncAllTrigger
    ) {
      void runAllSync()
    }
    if (syncAllTrigger !== undefined) {
      prevSyncAllTrigger.current = syncAllTrigger
    }
    // 只关心 syncAllTrigger 变化，runAllSync 在组件内定义且引用稳定
  }, [syncAllTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={panelRef}
      className={`editor-panel chapter-flow-panel${panelDragging ? ' dragging' : ''}`}
      style={panelPosition ? { left: panelPosition.left, top: panelPosition.top } : undefined}
    >
      <div className="ep-head" onMouseDown={startPanelDrag}>
        <div className="ep-title">续写流程面板</div>
        <div className="btn-group">
          <button
            className="btn btn-sm"
            onClick={() => void runAllSync()}
            disabled={
              outlineChecking || memoryExtracting || rhythmEvaluating || figureGenerating
            }
            title="依次触发细纲对照、记忆提取、节奏评估、图解生成"
          >
            ⟳ 一键同步
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            收起
          </button>
        </div>
      </div>

      {auditReport ? (
        <div style={{ marginTop: 8 }}>
          <ChapterAuditPanel
            projectId={projectId}
            chapterNumber={chapterNumber}
            draft={draft}
            report={auditReport}
            loading={false}
            mode="soft"
            onRunAgain={onRunAudit}
            onJumpToOffset={onJumpToOffset}
            onApplyRewrite={onApplyRewrite}
            onUndoRewrite={onUndoRewrite}
            onUndoRewriteAt={onUndoRewriteAt}
            onUndoRewriteByKey={onUndoRewriteByKey}
            onRedoRewrite={onRedoRewrite}
            redoStackCount={redoStackCount}
            rewriteHistory={rewriteHistory}
            reviewReport={reviewReport}
            reportLoading={reportLoading}
            reportError={reportError}
            onGenerateReport={generateReport}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 13 }}>AI 审稿建议</strong>
          {reviewSuggestions.length > 0 && !reviewing && (onApplyRewriteBatch || onApplyRewrite) ? (
            <button
              className="btn btn-sm"
              onClick={() => {
                handleApplyAllReviewSuggestions()
              }}
              title="按位置倒序应用所有可自动替换的改写建议"
            >
              应用全部
            </button>
          ) : null}
        </div>
        {reviewing && reviewSuggestions.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            审稿中…
          </p>
        ) : reviewSuggestions.length === 0 && !reviewText ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            暂无审稿结果（续写完成后会自动生成）。
          </p>
        ) : reviewSuggestions.length === 0 ? (
          <pre
            className="body"
            style={{ whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 12.5, maxHeight: 240, overflow: 'auto' }}
          >
            {reviewText}
          </pre>
        ) : (
          <div className="review-suggestion-list">
            {reviewSuggestions.map((s, i) => {
              const candidate = applyCandidate(s)
              const rewritable = !!candidate && isRewritable(candidate, s.quote).ok
              const copyText = [candidate, s.why].filter(Boolean).join('\n\n')
              const applied = appliedReviewIndexes.has(i)
              return (
                <div
                  key={i}
                  className={`review-suggestion ${applied ? 'review-suggestion-applied' : ''}`}
                  onClick={() => handleFocusReviewQuote(s.quote)}
                  style={{ cursor: s.quote ? 'pointer' : 'default' }}
                >
                  {s.quote ? <div className="quote">「{s.quote}」</div> : null}
                  {s.rewrite ? (
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>改写 · {s.rewrite}</div>
                  ) : s.advice ? (
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>说明 · {s.advice}</div>
                  ) : null}
                  {s.why ? <div className="why">理由 · {s.why}</div> : null}
                  {(rewritable || copyText) && (
                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                      {applied ? (
                        <span
                          className="audit-applied-badge"
                          title="已应用到正文。撤销请用编辑器顶部「↶ 撤销」。"
                        >
                          ✓ 已应用
                        </span>
                      ) : rewritable && s.quote ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleApplyReviewSuggestion(s.quote, candidate!, i)
                          }}
                        >
                          应用
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          title="无法自动应用，复制说明后手动修改"
                          onClick={(e) => {
                            e.stopPropagation()
                            void navigator.clipboard.writeText(copyText).catch(() => {})
                          }}
                        >
                          复制说明
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {reviewing ? (
              <div className="review-streaming muted" style={{ fontSize: 12 }}>
                ▍ 还在收尾…
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <strong style={{ fontSize: 13 }}>细纲对照（5 种差异分类）</strong>
          <button
            className="btn btn-sm"
            onClick={runOutlineCheck}
            disabled={outlineChecking}
            style={{ marginLeft: 'auto' }}
          >
            {outlineChecking ? '对照中…' : outlineDiff ? '重新对照' : '✦ 开始对照'}
          </button>
        </div>
        {outlineError ? (
          <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
            {outlineError}
          </p>
        ) : null}
        {outlineDiff ? (
          outlineDiff.passed ? (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              ✓ 无 P0/P1 差异，可放心保存。
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              <p className="meta" style={{ fontSize: 12, marginBottom: 6 }}>
                共 {outlineDiff.diffs.length} 项差异（按优先级排序，仅报告 + 建议，由你决策处理）
              </p>
              <ul className="bare" style={{ display: 'grid', gap: 8 }}>
                {sortedDiffs.map((d, i) => (
                  <li
                    key={i}
                    style={{
                      border: '1px solid var(--line-soft)',
                      borderRadius: 'var(--r-sm)',
                      padding: 8,
                      fontSize: 12.5
                    }}
                  >
                    <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
                      <span
                        className={`chip ${d.priority === 'P0' ? 'chip-danger' : d.priority === 'P1' ? 'chip-warning' : ''}`}
                      >
                        {d.priority}
                      </span>
                      <strong>{d.typeLabel}</strong>
                      <span className="meta" style={{ marginLeft: 'auto', fontSize: 11 }}>
                        类型 {d.type}
                      </span>
                    </div>
                    {d.outline ? (
                      <div className="meta" style={{ marginBottom: 2 }}>
                        <strong>细纲</strong>：{d.outline}
                      </div>
                    ) : null}
                    {d.actual ? (
                      <div className="meta" style={{ marginBottom: 2 }}>
                        <strong>正文</strong>：{d.actual}
                      </div>
                    ) : null}
                    {d.suggestion ? (
                      <div style={{ marginTop: 4 }}>
                        <span className="muted">建议</span>：{d.suggestion}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <strong style={{ fontSize: 13 }}>记忆提取（混合回写策略）</strong>
          <button
            className="btn btn-sm"
            onClick={runMemoryExtract}
            disabled={memoryExtracting}
            style={{ marginLeft: 'auto' }}
          >
            {memoryExtracting ? '提取中…' : memoryExtraction ? '重新提取' : '✦ 提取记忆'}
          </button>
        </div>
        <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
          自动应用：状态变化 / 情节追加 / 伏笔回收；需确认：新增角色 / 地点 / 伏笔。
        </p>
        {memoryError ? (
          <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
            {memoryError}
          </p>
        ) : null}
        {memoryExtraction ? (
          <div style={{ marginTop: 8 }}>
            {/* 自动应用部分 */}
            <div
              style={{
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--r-sm)',
                padding: 8,
                marginBottom: 8
              }}
            >
              <div className="row" style={{ alignItems: 'baseline' }}>
                <strong style={{ fontSize: 12.5 }}>自动应用部分</strong>
                <button
                  className="btn btn-sm"
                  onClick={applyAutomatic}
                  disabled={memoryApplying || !hasAutoItems || !!memoryResult}
                  style={{ marginLeft: 'auto' }}
                >
                  {memoryApplying ? '应用中…' : memoryResult ? '已应用' : '应用自动部分'}
                </button>
              </div>
              <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                <li>
                  角色状态变化：{memoryExtraction.characterStateChanges.length} 项
                  {memoryExtraction.characterStateChanges.length > 0 ? (
                    <span className="muted">
                      {' '}
                     （
                      {memoryExtraction.characterStateChanges
                        .map((c) => `${c.name}.${c.field}→${c.newValue}`)
                        .join('；')}
                      ）
                    </span>
                  ) : null}
                </li>
                <li>
                  情节追加：{memoryExtraction.newPlotPoints.length} 项
                  {memoryExtraction.newPlotPoints.length > 0 ? (
                    <span className="muted">
                      {' '}
                     （{memoryExtraction.newPlotPoints.map((p) => p.title).join('、')}）
                    </span>
                  ) : null}
                </li>
                <li>
                  伏笔回收：{memoryExtraction.collectedForeshadowings.length} 项
                  {memoryExtraction.collectedForeshadowings.length > 0 ? (
                    <span className="muted">
                      {' '}
                      （{memoryExtraction.collectedForeshadowings.map((f) => f.content).join('；')}）
                    </span>
                  ) : null}
                </li>
              </ul>
              {memoryResult ? (
                <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                  ✓ 已应用：状态 {memoryResult.applied.stateChanges} · 情节{' '}
                  {memoryResult.applied.plotPoints} · 伏笔 {memoryResult.applied.collected}
                  {memoryResult.errors.length > 0 ? (
                    <span className="err">（{memoryResult.errors.length} 项失败）</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* 新增角色（需确认） */}
            {memoryExtraction.newCharacters.length > 0 ? (
              <div
                style={{
                  border: '1px solid var(--line-soft)',
                  borderRadius: 'var(--r-sm)',
                  padding: 8,
                  marginBottom: 8
                }}
              >
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 12.5 }}>
                    新增角色（{memoryExtraction.newCharacters.length}）
                  </strong>
                  <button
                    className="btn btn-sm"
                    onClick={applyChars}
                    disabled={newCharResult !== null}
                    style={{ marginLeft: 'auto' }}
                  >
                    {newCharResult !== null ? `已应用 ${newCharResult}` : '确认应用'}
                  </button>
                </div>
                <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                  {memoryExtraction.newCharacters.map((c, i) => (
                    <li key={i}>
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {' '}
                        · {c.role} · {c.identity} · {c.personality}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* 新增地点（需确认） */}
            {memoryExtraction.newLocations.length > 0 ? (
              <div
                style={{
                  border: '1px solid var(--line-soft)',
                  borderRadius: 'var(--r-sm)',
                  padding: 8,
                  marginBottom: 8
                }}
              >
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 12.5 }}>
                    新增地点（{memoryExtraction.newLocations.length}）
                  </strong>
                  <button
                    className="btn btn-sm"
                    onClick={applyLocs}
                    disabled={newLocResult !== null}
                    style={{ marginLeft: 'auto' }}
                  >
                    {newLocResult !== null ? `已应用 ${newLocResult}` : '确认应用'}
                  </button>
                </div>
                <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                  {memoryExtraction.newLocations.map((l, i) => (
                    <li key={i}>
                      <strong>{l.name}</strong>
                      <span className="muted">
                        {' '}
                        · {l.category} · {l.notes}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* 新增伏笔（需确认） */}
            {memoryExtraction.newForeshadowings.length > 0 ? (
              <div
                style={{
                  border: '1px solid var(--line-soft)',
                  borderRadius: 'var(--r-sm)',
                  padding: 8
                }}
              >
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 12.5 }}>
                    新增伏笔（{memoryExtraction.newForeshadowings.length}）
                  </strong>
                  <button
                    className="btn btn-sm"
                    onClick={applyForeshadowings}
                    disabled={newForeshadowingResult !== null}
                    style={{ marginLeft: 'auto' }}
                  >
                    {newForeshadowingResult !== null
                      ? `已应用 ${newForeshadowingResult}`
                      : '确认应用'}
                  </button>
                </div>
                <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                  {memoryExtraction.newForeshadowings.map((f, i) => (
                    <li key={i}>
                      <strong>{f.content}</strong>
                      <span className="muted">
                        {' '}
                        · 预计第 {f.expectedCollect ?? '?'} 章回收
                        {f.note ? ` · ${f.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <strong style={{ fontSize: 13 }}>节奏图谱回填</strong>
          <button
            className="btn btn-sm"
            onClick={runRhythmEvaluate}
            disabled={rhythmEvaluating}
            style={{ marginLeft: 'auto' }}
          >
            {rhythmEvaluating ? '评估中…' : rhythmEvaluation ? '重新评估' : '✦ 评估节奏'}
          </button>
        </div>
        <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
          LLM 评估实际情绪值；差异 ≤1 自动回写，否则需你确认。
        </p>
        {rhythmError ? (
          <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
            {rhythmError}
          </p>
        ) : null}
        {rhythmEvaluation ? (
          <div
            style={{
              marginTop: 8,
              border: '1px solid var(--line-soft)',
              borderRadius: 'var(--r-sm)',
              padding: 8,
              fontSize: 12.5
            }}
          >
            <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
              <span>预期 {rhythmEvaluation.expectedEmotion}</span>
              <span style={{ margin: '0 6' }}>→</span>
              <strong>实际 {rhythmEvaluation.actualEmotion}</strong>
              <span
                className={`chip ${rhythmEvaluation.diff > 1 ? 'chip-warning' : ''}`}
                style={{ marginLeft: 8 }}
              >
                差异 {rhythmEvaluation.diff}
              </span>
              <span className="meta" style={{ marginLeft: 'auto', fontSize: 11 }}>
                {rhythmEvaluation.autoApply ? '✓ 自动回写' : '⚠ 需确认'}
              </span>
            </div>
            {rhythmEvaluation.reason ? (
              <div className="muted" style={{ fontSize: 12 }}>
                依据：{rhythmEvaluation.reason}
              </div>
            ) : null}
            {!rhythmEvaluation.autoApply && !rhythmResult ? (
              <button
                className="btn btn-sm"
                onClick={() => applyRhythm(rhythmEvaluation)}
                disabled={rhythmApplying}
                style={{ marginTop: 6 }}
              >
                {rhythmApplying ? '回写中…' : '确认回写'}
              </button>
            ) : null}
            {rhythmResult ? (
              <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                ✓ 已回写：{rhythmResult.previousEmotion} → {rhythmResult.newEmotion}
                {rhythmResult.actualized ? ' · actualized=true' : ''}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <strong style={{ fontSize: 13 }}>Mermaid 图解生成</strong>
          <button
            className="btn btn-sm"
            onClick={runFigureGenerate}
            disabled={figureGenerating}
            style={{ marginLeft: 'auto' }}
          >
            {figureGenerating ? '生成中…' : figureDraft ? '重新生成' : '✦ 生成图解'}
          </button>
        </div>
        <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
          关键转折点（战斗/势力/突破/关系/剧情/伏笔回收）自动生成 Mermaid 图解。
        </p>
        {figureError ? (
          <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
            {figureError}
          </p>
        ) : null}
        {figureDraft ? (
          figureDraft.shouldGenerate ? (
            <div
              style={{
                marginTop: 8,
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--r-sm)',
                padding: 8,
                fontSize: 12.5
              }}
            >
              <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
                <span className="chip">{figureDraft.type}</span>
                <strong>{figureDraft.topic}</strong>
                <span className="meta" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  {figureDraft.fileName}
                </span>
              </div>
              {figureDraft.reason ? (
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  触发理由：{figureDraft.reason}
                </div>
              ) : null}
              <pre
                className="body"
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 11.5,
                  maxHeight: 160,
                  overflow: 'auto',
                  background: 'var(--bg-soft, #f6f8fa)',
                  padding: 6,
                  borderRadius: 'var(--r-sm)'
                }}
              >
                {figureDraft.html}
              </pre>
              {figureSaved ? (
                <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                  ✓ 已保存到 图解/{figureSaved}
                </div>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={saveFigureDraft}
                  disabled={figureSaving}
                  style={{ marginTop: 6 }}
                >
                  {figureSaving ? '保存中…' : '保存到 图解/'}
                </button>
              )}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              本章非关键转折点，跳过图解生成。
              {figureDraft.reason ? `（${figureDraft.reason}）` : ''}
            </p>
          )
        ) : null}
      </div>
    </div>
  )
}
