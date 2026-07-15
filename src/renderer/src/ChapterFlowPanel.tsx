import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  AuditReport,
  ChapterReviewReport,
  DetailedOutlineItem,
  FigureDraft,
  MemoryApplyResult,
  MemoryExtraction,
  OutlineDiffItem,
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
  canUpdateOutlineFromDiff,
  collectOutlinePatchesFromDiffs,
  formatOutlinePatchPreview,
  isRecommendedOutlineUpdate,
  needsConfirmOutlineUpdate,
  recomputeOutlineDiffPassed
} from '../../shared/outline-diff-apply'
import type { RewriteEntry } from '../../main/data/rewrite-history'
import ChapterAuditPanel from './ChapterAuditPanel'

interface Props {
  projectId: string
  chapterNumber: number
  draft: string
  auditReport: AuditReport | null
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
  /** 以正文回写细纲成功后，把最新细纲同步到编辑器 */
  onOutlineUpdated?: (item: DetailedOutlineItem) => void
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
    onOutlineUpdated,
    onCompleteMemory,
    onCompleteRhythm,
    onCompleteFigure,
    syncAllTrigger
  } = props

  const [outlineChecking, setOutlineChecking] = useState(false)
  const [outlineDiff, setOutlineDiff] = useState<OutlineDiffReport | null>(null)
  const [outlineError, setOutlineError] = useState('')
  /** 已忽略的差异下标（相对于 outlineDiff.diffs 原序） */
  const [outlineIgnored, setOutlineIgnored] = useState<Set<number>>(() => new Set())
  /** 已成功回写细纲的差异下标 */
  const [outlineApplied, setOutlineApplied] = useState<Set<number>>(() => new Set())
  const [outlineApplying, setOutlineApplying] = useState(false)
  const [outlineApplyError, setOutlineApplyError] = useState('')
  /** 防连点：state 禁用前的同步锁 */
  const outlineApplyingRef = useRef(false)

  // 记忆提取状态
  const [memoryExtracting, setMemoryExtracting] = useState(false)
  const [memoryExtraction, setMemoryExtraction] = useState<MemoryExtraction | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const [memoryApplying, setMemoryApplying] = useState(false)
  const [memoryResult, setMemoryResult] = useState<MemoryApplyResult | null>(null)
  const [newCharResult, setNewCharResult] = useState<number | null>(null)
  const [newLocResult, setNewLocResult] = useState<number | null>(null)
  const [newItemResult, setNewItemResult] = useState<number | null>(null)
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
    setOutlineIgnored(new Set())
    setOutlineApplied(new Set())
    setOutlineApplyError('')
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

  const markOutlineResolved = (indexes: number[], mode: 'ignore' | 'apply') => {
    if (mode === 'ignore') {
      setOutlineIgnored((prev) => {
        const next = new Set(prev)
        for (const i of indexes) next.add(i)
        return next
      })
    } else {
      setOutlineApplied((prev) => {
        const next = new Set(prev)
        for (const i of indexes) next.add(i)
        return next
      })
    }
  }

  const loadCurrentOutline = async (): Promise<DetailedOutlineItem | null> => {
    const items = await window.api.listDetailedOutline(projectId)
    return items.find((x) => x.chapterNumber === chapterNumber) ?? null
  }

  /**
   * 将选中的差异以正文为准合并后写回细纲。
   * indexes 为 outlineDiff.diffs 原序下标。
   * 仅标记真正产出补丁的项；顺序叠合 plotSummary，避免互相覆盖。
   */
  const applyOutlineFromContent = async (indexes: number[]) => {
    if (!outlineDiff || indexes.length === 0) return
    if (outlineApplyingRef.current) return

    const unique = [...new Set(indexes)].filter(
      (i) =>
        i >= 0 &&
        i < outlineDiff.diffs.length &&
        !outlineIgnored.has(i) &&
        !outlineApplied.has(i)
    )
    if (unique.length === 0) return

    const targets = unique
      .map((i) => ({ index: i, diff: outlineDiff.diffs[i] }))
      .filter(({ diff }) => canUpdateOutlineFromDiff(diff))

    if (targets.length === 0) {
      setOutlineApplyError('选中项无法回写细纲（漏写类请补写正文）')
      return
    }

    outlineApplyingRef.current = true
    setOutlineApplying(true)
    setOutlineApplyError('')
    try {
      const current = await loadCurrentOutline()
      const collected = collectOutlinePatchesFromDiffs(targets, current)

      if (collected.appliedIndexes.length === 0 || Object.keys(collected.merged).length === 0) {
        setOutlineApplyError('无法从差异生成细纲补丁（缺少正文侧描述）')
        return
      }

      const needsConfirm = targets.some(({ diff }) => needsConfirmOutlineUpdate(diff))
      // 任意回写都展示字段预览；核心/结构类额外提示
      const preview = formatOutlinePatchPreview(current, collected.merged)
      const head = needsConfirm
        ? `以下差异涉及核心事件或结构，将以正文为准更新细纲。\n（后续章节若依赖旧细纲，请一并检查。）\n\n`
        : `将以正文为准更新细纲，请确认字段变更：\n\n`
      const ok = window.confirm(`${head}${preview}`)
      if (!ok) return

      const updated = await window.api.updateDetailedOutline(
        projectId,
        chapterNumber,
        collected.merged
      )
      markOutlineResolved(collected.appliedIndexes, 'apply')
      onOutlineUpdated?.(updated)

      if (collected.skippedIndexes.length > 0) {
        setOutlineApplyError(
          `${collected.skippedIndexes.length} 项无法生成补丁，未标记为已回写`
        )
      }
    } catch (e) {
      setOutlineApplyError((e as Error).message || '回写细纲失败')
    } finally {
      outlineApplyingRef.current = false
      setOutlineApplying(false)
    }
  }

  const ignoreOutlineDiff = (index: number) => {
    markOutlineResolved([index], 'ignore')
    setOutlineApplyError('')
  }

  const applyRecommendedOutlineUpdates = async () => {
    if (!outlineDiff) return
    const indexes = outlineDiff.diffs
      .map((d, i) => ({ d, i }))
      .filter(
        ({ d, i }) =>
          !outlineIgnored.has(i) &&
          !outlineApplied.has(i) &&
          isRecommendedOutlineUpdate(d) &&
          !needsConfirmOutlineUpdate(d)
      )
      .map(({ i }) => i)
    if (indexes.length === 0) {
      setOutlineApplyError('没有可一键回写的推荐项（类型 2/3）；核心偏离请逐条确认')
      return
    }
    await applyOutlineFromContent(indexes)
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
    setNewItemResult(null)
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

  const applyItems = async () => {
    if (!memoryExtraction?.newItems.length) return
    try {
      const n = await window.api.applyNewItems(projectId, memoryExtraction.newItems)
      setNewItemResult(n)
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

  const sortedDiffs = useMemo(() => {
    if (!outlineDiff) return [] as { diff: OutlineDiffItem; index: number }[]
    const order = { P0: 0, P1: 1, P2: 2 } as const
    return outlineDiff.diffs
      .map((diff, index) => ({ diff, index }))
      .sort((a, b) => order[a.diff.priority] - order[b.diff.priority])
  }, [outlineDiff])

  const outlineResolvedIndexes = useMemo(() => {
    const s = new Set<number>()
    for (const i of outlineIgnored) s.add(i)
    for (const i of outlineApplied) s.add(i)
    return s
  }, [outlineIgnored, outlineApplied])

  const outlineEffectivePassed = useMemo(() => {
    if (!outlineDiff) return true
    return recomputeOutlineDiffPassed(outlineDiff.diffs, outlineResolvedIndexes)
  }, [outlineDiff, outlineResolvedIndexes])

  const recommendedOutlineCount = useMemo(() => {
    if (!outlineDiff) return 0
    return outlineDiff.diffs.filter(
      (d, i) =>
        !outlineResolvedIndexes.has(i) &&
        isRecommendedOutlineUpdate(d) &&
        !needsConfirmOutlineUpdate(d)
    ).length
  }, [outlineDiff, outlineResolvedIndexes])

  const pendingOutlineCount = useMemo(() => {
    if (!outlineDiff) return 0
    return outlineDiff.diffs.filter((_, i) => !outlineResolvedIndexes.has(i)).length
  }, [outlineDiff, outlineResolvedIndexes])

  const hasAutoItems =
    memoryExtraction &&
    (memoryExtraction.characterStateChanges.length > 0 ||
      memoryExtraction.newPlotPoints.length > 0 ||
      memoryExtraction.collectedForeshadowings.length > 0)

  /**
   * 一键同步：依次触发四个同步操作，每个操作独立 try/catch 确保互不影响。
   * 注意：这只是启动生成流程，应用操作（如 applyMemory）仍需用户确认。
   * 四个操作完成后刷新记忆索引，让 记忆/ 派生视图与 追踪/ 文件保持一致。
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
    // 四个操作完成后刷新记忆索引（追踪/时间线 + 追踪/伏笔 -> 记忆/ 派生视图）
    try {
      await window.api.syncMemoryIndex(projectId)
    } catch (err) {
      console.warn('[runAllSync] syncMemoryIndex failed:', err)
    }
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

      <div className="ep-body">
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
          <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
            差异可「以正文更新细纲」或「忽略」。类型 2/3 推荐回写细纲；类型 1 请补写正文；类型 4/5
            需确认。
          </p>
          {outlineError ? (
            <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
              {outlineError}
            </p>
          ) : null}
          {outlineApplyError ? (
            <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
              {outlineApplyError}
            </p>
          ) : null}
          {outlineDiff ? (
            outlineDiff.diffs.length === 0 ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                ✓ 无差异，可放心保存。
              </p>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
                  <p className="meta" style={{ fontSize: 12, margin: 0 }}>
                    共 {outlineDiff.diffs.length} 项 · 待处理 {pendingOutlineCount}
                    {pendingOutlineCount === 0
                      ? ' · 已全部处理'
                      : outlineEffectivePassed
                        ? ' · 无未处理 P0/P1'
                        : ' · 仍有 P0/P1 待处理'}
                  </p>
                  {recommendedOutlineCount > 0 ? (
                    <button
                      className="btn btn-sm"
                      disabled={outlineApplying}
                      onClick={() => void applyRecommendedOutlineUpdates()}
                      title="将类型 2/3 等推荐项以正文为准批量回写细纲"
                      style={{ marginLeft: 'auto' }}
                    >
                      {outlineApplying
                        ? '回写中…'
                        : `以正文更新细纲（推荐 ${recommendedOutlineCount}）`}
                    </button>
                  ) : null}
                </div>
                {pendingOutlineCount === 0 ? (
                  <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    ✓ 待处理差异已全部忽略或已回写细纲（下方可回看处理结果）。
                  </p>
                ) : null}
                <ul className="bare" style={{ display: 'grid', gap: 8 }}>
                  {sortedDiffs.map(({ diff: d, index }) => {
                    const ignored = outlineIgnored.has(index)
                    const applied = outlineApplied.has(index)
                    const resolved = ignored || applied
                    const canUpdate = canUpdateOutlineFromDiff(d)
                    return (
                      <li
                        key={index}
                        style={{
                          border: '1px solid var(--line-soft)',
                          borderRadius: 'var(--r-sm)',
                          padding: 8,
                          fontSize: 12.5,
                          opacity: resolved ? 0.65 : 1
                        }}
                      >
                        <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
                          <span
                            className={`chip ${d.priority === 'P0' ? 'chip-danger' : d.priority === 'P1' ? 'chip-warning' : ''}`}
                          >
                            {d.priority}
                          </span>
                          <strong>{d.typeLabel}</strong>
                          {applied ? (
                            <span className="chip" style={{ marginLeft: 6 }}>
                              已回写细纲
                            </span>
                          ) : null}
                          {ignored ? (
                            <span className="chip" style={{ marginLeft: 6 }}>
                              已忽略
                            </span>
                          ) : null}
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
                        {!resolved ? (
                          <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                            {canUpdate ? (
                              <button
                                className="btn btn-sm"
                                disabled={outlineApplying}
                                onClick={() => void applyOutlineFromContent([index])}
                                title={
                                  needsConfirmOutlineUpdate(d)
                                    ? '核心/结构级差异，点击后需确认'
                                    : '把正文实际内容写回细纲对应字段'
                                }
                              >
                                以正文更新细纲
                                {needsConfirmOutlineUpdate(d) ? '（需确认）' : ''}
                              </button>
                            ) : (
                              <span className="muted" style={{ fontSize: 11.5 }}>
                                漏写类请在正文补写，不宜改细纲
                              </span>
                            )}
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={outlineApplying}
                              onClick={() => ignoreOutlineDiff(index)}
                            >
                              忽略
                            </button>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
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
            自动应用：状态变化 / 情节追加 / 伏笔回收；需确认：新增角色 / 地点 / 道具 / 伏笔。
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

              {/* 新增道具（需确认） */}
              {memoryExtraction.newItems.length > 0 ? (
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
                      新增道具（{memoryExtraction.newItems.length}）
                    </strong>
                    <button
                      className="btn btn-sm"
                      onClick={applyItems}
                      disabled={newItemResult !== null}
                      style={{ marginLeft: 'auto' }}
                    >
                      {newItemResult !== null ? `已应用 ${newItemResult}` : '确认应用'}
                    </button>
                  </div>
                  <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                    {memoryExtraction.newItems.map((it) => (
                      <li key={it.name}>
                        <strong>{it.name}</strong>
                        <span className="muted">
                          {' '}
                          · {it.category} · {it.notes}
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
    </div>
  )
}
