import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  AuditReport,
  ChapterReviewReport,
  ChapterSelfCheckReport,
  DetailedOutlineItem,
  FigureDraft,
  MemoryApplyPreview,
  MemoryApplyResult,
  MemoryExtraction,
  OutlineDiffItem,
  OutlineDiffReport,
  RhythmApplyResult,
  RhythmEvaluation,
  SettingsApplyPreview,
  SettingsApplyResult
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
import type { PostWriteSyncPhase } from '../../shared/post-write-sync'
import { formatSyncErrorHint } from '../../shared/post-write-sync'
import ChapterAuditPanel from './ChapterAuditPanel'
import ChapterSelfCheckPanel from './ChapterSelfCheckPanel'

/** 流程面板 LLM 错误 → 中文提示（与编辑器侧 map 对齐的子集） */
function friendlyFlowError(err: string): string {
  const e = err.trim()
  if (!e) return '请求失败'
  if (e === 'LLM_TIMEOUT' || /aborted due to timeout/i.test(e)) {
    return '请求超时（正文较长或模型响应慢）。已放宽超时，请重试；若仍失败可换更快模型或缩短本章字数。'
  }
  if (e === 'LLM_RATE_LIMIT') return '请求过于频繁，请稍后再试'
  if (e === 'LLM_AUTH_FAILED' || e === 'NO_KEY' || e === 'LLM_NOT_CONFIGURED') {
    return '模型未配置或鉴权失败，请到设置检查 API Key / 功能模型分配（审稿质检）'
  }
  if (e.startsWith('AGY_ERROR:') || /Agent execution terminated/i.test(e)) {
    return 'agy 执行出错（超时/限流/网络）。可改用 Kimi 等 HTTP 模型，或检查 agy 登录与网络后重试'
  }
  if (e.startsWith('LLM_REQUEST_FAILED')) return `模型请求失败：${e}`
  if (e === 'LLM_ABORTED') return '已取消'
  return e
}

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
   * 一键同步触发器：值变化时自动触发同步操作。
   * 用于 full 后处理或外部「一键同步」。
   */
  syncAllTrigger?: number
  /**
   * 外部已完成的自动记忆/设定同步结果。
   * 注入后展示 extraction/diffs，避免面板再跑一次 extractMemory。
   */
  autoSyncSeed?: {
    extraction: MemoryExtraction
    memory: MemoryApplyResult
    settings: SettingsApplyResult
    selfCheck?: ChapterSelfCheckReport | null
  } | null
  /**
   * 当 syncAllTrigger 触发时跳过记忆提取（记忆已由 syncChapterAfterWrite 完成）。
   * 用户手动点「一键同步」仍会跑记忆提取。
   */
  skipMemoryOnAutoSyncAll?: boolean
  /** 写后自动同步状态（编辑器状态条同源，面板顶部再显一次） */
  postWriteSyncBanner?: {
    phase: PostWriteSyncPhase
    message: string
    errors: string[]
    canUndo?: boolean
    undoDepth?: number
    fromPendingQueue?: boolean
  } | null
  /** 编辑器持有的写后自检报告（与 banner 同源） */
  selfCheckReport?: ChapterSelfCheckReport | null
  /** 用当前 draft 重新跑写后自检 */
  onRerunSelfCheck?: () => void | Promise<void>
  selfCheckLoading?: boolean
  /** 自检失败项 → 按要求重写 */
  onApplySelfCheckToRewrite?: () => void
  /** 自检失败项 → 续写临时要求 */
  onApplySelfCheckToContinue?: () => void
  /** 失败 / 部分失败 / 手动补跑：重新跑记忆与设定同步 */
  onRetryAutoSync?: () => void
  /** 撤销最近一次写后自动同步（可多级） */
  onUndoAutoSync?: () => void
  /** 忽略失败队列中的本章项 */
  onDismissPendingSync?: () => void
  undoAutoSyncLoading?: boolean
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
    syncAllTrigger,
    autoSyncSeed,
    skipMemoryOnAutoSyncAll,
    postWriteSyncBanner,
    selfCheckReport,
    onRerunSelfCheck,
    selfCheckLoading,
    onApplySelfCheckToRewrite,
    onApplySelfCheckToContinue,
    onRetryAutoSync,
    onUndoAutoSync,
    onDismissPendingSync,
    undoAutoSyncLoading
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
  /** 自动部分 diff 预览（应用前读人物卡当前值） */
  const [memoryPreview, setMemoryPreview] = useState<MemoryApplyPreview | null>(null)
  const [settingsPreview, setSettingsPreview] = useState<SettingsApplyPreview | null>(null)
  const [settingsResult, setSettingsResult] = useState<SettingsApplyResult | null>(null)
  const [settingsApplying, setSettingsApplying] = useState(false)
  const [newCharResult, setNewCharResult] = useState<number | null>(null)
  const [newLocResult, setNewLocResult] = useState<number | null>(null)
  const [newItemResult, setNewItemResult] = useState<number | null>(null)
  const [newForeshadowingResult, setNewForeshadowingResult] = useState<number | null>(null)

  // 写后自检（优先用 props；autoSyncSeed 注入时覆盖本地）
  const [localSelfCheck, setLocalSelfCheck] = useState<ChapterSelfCheckReport | null>(null)
  const [localSelfCheckLoading, setLocalSelfCheckLoading] = useState(false)

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
        setOutlineError(friendlyFlowError(r.error ?? '对照失败'))
        setOutlineChecking(false)
        return
      }
      setOutlineDiff(parseOutlineDiffJson(buffer, chapterNumber))
      onCompleteOutline?.()
    } catch (e) {
      setOutlineError(friendlyFlowError((e as Error).message || '对照失败'))
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
    setMemoryPreview(null)
    setSettingsPreview(null)
    setSettingsResult(null)
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
      const extraction = parseMemoryExtractionJson(buffer, chapterNumber)
      setMemoryExtraction(extraction)
      onCompleteMemory?.()

      // 预览 diff + 自动应用状态/情节/伏笔回收（新增角色等仍需确认）
      try {
        const preview = await window.api.previewMemoryApply(projectId, extraction)
        setMemoryPreview(preview)
        const hasAuto =
          extraction.characterStateChanges.length > 0 ||
          extraction.newPlotPoints.length > 0 ||
          extraction.collectedForeshadowings.length > 0
        if (hasAuto && preview.applicableCount > 0) {
          setMemoryApplying(true)
          const result = await window.api.applyMemory(projectId, extraction)
          setMemoryResult(result)
          if (result.appliedDiffs?.length) {
            setMemoryPreview({
              diffs: result.appliedDiffs,
              applicableCount: result.appliedDiffs.length,
              confirmCount: preview.confirmCount
            })
          }
        }
        // 设定演进：预览 + 高置信自动应用
        const sPreview = await window.api.previewSettingsApply(projectId, extraction)
        setSettingsPreview(sPreview)
        if (sPreview.autoCount > 0) {
          setSettingsApplying(true)
          const sResult = await window.api.applySettingsPatches(projectId, extraction, true)
          setSettingsResult(sResult)
        }
      } catch (e) {
        setMemoryError((e as Error).message)
      } finally {
        setMemoryApplying(false)
        setSettingsApplying(false)
      }
    } catch (e) {
      setMemoryError((e as Error).message)
      setMemoryExtracting(false)
    }
  }

  const applyAutomatic = async () => {
    if (!memoryExtraction) return
    setMemoryApplying(true)
    try {
      // 再刷一次预览（应用前当前值）
      const preview = await window.api.previewMemoryApply(projectId, memoryExtraction)
      setMemoryPreview(preview)
      const result = await window.api.applyMemory(projectId, memoryExtraction)
      setMemoryResult(result)
      if (result.appliedDiffs?.length) {
        setMemoryPreview({
          diffs: result.appliedDiffs,
          applicableCount: result.appliedDiffs.length,
          confirmCount: preview.confirmCount
        })
      }
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
      const n = await window.api.applyNewLocations(
        projectId,
        memoryExtraction.newLocations,
        chapterNumber
      )
      setNewLocResult(n)
    } catch (e) {
      setMemoryError((e as Error).message)
    }
  }

  const applySettingsAll = async () => {
    if (!memoryExtraction) return
    setSettingsApplying(true)
    try {
      const result = await window.api.applySettingsPatches(projectId, memoryExtraction, false)
      setSettingsResult(result)
      const preview = await window.api.previewSettingsApply(projectId, memoryExtraction)
      setSettingsPreview(preview)
    } catch (e) {
      setMemoryError((e as Error).message)
    } finally {
      setSettingsApplying(false)
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
   * 一键同步：依次触发同步操作，每个操作独立 try/catch。
   * @param opts.skipMemory 为 true 时不跑记忆 extract（外部已 syncChapterAfterWrite）
   */
  const runAllSync = async (opts?: { skipMemory?: boolean }) => {
    if (!draft.trim()) return
    const tasks: Promise<unknown>[] = [
      runOutlineCheck(),
      runRhythmEvaluate(),
      runFigureGenerate()
    ]
    if (!opts?.skipMemory) {
      tasks.push(runMemoryExtract())
    }
    await Promise.allSettled(tasks)
    // 操作完成后刷新记忆索引（追踪/时间线 + 追踪/伏笔 -> 记忆/ 派生视图）
    try {
      await window.api.syncMemoryIndex(projectId)
    } catch (err) {
      console.warn('[runAllSync] syncMemoryIndex failed:', err)
    }
  }

  /**
   * 外部自动同步结果回填：展示 extraction / 已应用 diffs，避免重复 extract。
   * 用 seed 对象引用变化识别新一轮同步。
   * 全失败时仍写入 memoryError，避免面板空白误导用户。
   */
  const prevAutoSyncSeed = useRef<typeof autoSyncSeed>(null)
  useEffect(() => {
    if (!autoSyncSeed || autoSyncSeed === prevAutoSyncSeed.current) return
    prevAutoSyncSeed.current = autoSyncSeed
    setMemoryExtraction(autoSyncSeed.extraction)
    setMemoryResult(autoSyncSeed.memory)
    setSettingsResult(autoSyncSeed.settings)
    setMemoryExtracting(false)
    if (autoSyncSeed.selfCheck) {
      setLocalSelfCheck(autoSyncSeed.selfCheck)
    }

    const allErrors = [
      ...(autoSyncSeed.memory.errors ?? []),
      ...(autoSyncSeed.settings.errors ?? [])
    ].filter(Boolean)
    const appliedTotal =
      (autoSyncSeed.memory.applied?.stateChanges ?? 0) +
      (autoSyncSeed.memory.applied?.plotPoints ?? 0) +
      (autoSyncSeed.memory.applied?.collected ?? 0) +
      (autoSyncSeed.settings.applied ?? 0)
    if (allErrors.length > 0 && appliedTotal === 0) {
      setMemoryError(allErrors.join('；'))
    } else {
      setMemoryError('')
    }

    if (autoSyncSeed.memory.appliedDiffs?.length) {
      setMemoryPreview({
        diffs: autoSyncSeed.memory.appliedDiffs,
        applicableCount: autoSyncSeed.memory.appliedDiffs.length,
        confirmCount:
          (autoSyncSeed.extraction.newCharacters?.length ?? 0) +
          (autoSyncSeed.extraction.newLocations?.length ?? 0) +
          (autoSyncSeed.extraction.newItems?.length ?? 0) +
          (autoSyncSeed.extraction.newForeshadowings?.length ?? 0)
      })
    }
    // 设定：用已应用 diffs 填预览；其余补丁需用户手动「预览/应用」
    if (autoSyncSeed.settings.appliedDiffs?.length) {
      setSettingsPreview({
        diffs: autoSyncSeed.settings.appliedDiffs,
        autoCount: autoSyncSeed.settings.applied,
        confirmCount: 0,
        suggestionCount: autoSyncSeed.extraction.settingsSuggestions?.length ?? 0
      })
    }
    onCompleteMemory?.()
  }, [autoSyncSeed, onCompleteMemory])

  /**
   * full 后处理：syncAllTrigger 变化时跑细纲/节奏/图解；
   * 若 skipMemoryOnAutoSyncAll 则不再 extract 记忆。
   */
  const prevSyncAllTrigger = useRef(0)
  useEffect(() => {
    if (
      syncAllTrigger !== undefined &&
      syncAllTrigger > 0 &&
      prevSyncAllTrigger.current !== syncAllTrigger
    ) {
      void runAllSync({ skipMemory: skipMemoryOnAutoSyncAll === true })
    }
    if (syncAllTrigger !== undefined) {
      prevSyncAllTrigger.current = syncAllTrigger
    }
    // 只关心 syncAllTrigger 变化
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
            onClick={() => void runAllSync({ skipMemory: false })}
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
        {postWriteSyncBanner && postWriteSyncBanner.phase !== 'idle' ? (
          <div
            className={`flow-auto-sync-strip flow-auto-sync-${postWriteSyncBanner.phase}`}
            role="status"
          >
            <div className="flow-auto-sync-text">
              <strong style={{ fontSize: 12 }}>写后同步</strong>
              <span style={{ fontSize: 12, marginLeft: 6 }}>{postWriteSyncBanner.message}</span>
              {postWriteSyncBanner.errors.length > 0 &&
              postWriteSyncBanner.phase !== 'syncing' ? (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {formatSyncErrorHint(postWriteSyncBanner.errors)}
                </div>
              ) : null}
            </div>
            <div className="btn-group" style={{ flexShrink: 0 }}>
              {onUndoAutoSync &&
              postWriteSyncBanner.canUndo &&
              postWriteSyncBanner.phase !== 'syncing' ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onUndoAutoSync}
                  disabled={undoAutoSyncLoading}
                  title="撤销最近一次自动写入（可多级）"
                >
                  {undoAutoSyncLoading
                    ? '撤销中…'
                    : (postWriteSyncBanner.undoDepth ?? 0) > 1
                      ? `撤销 (${postWriteSyncBanner.undoDepth})`
                      : '撤销同步'}
                </button>
              ) : null}
              {onRetryAutoSync && postWriteSyncBanner.phase !== 'syncing' ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onRetryAutoSync}
                  disabled={undoAutoSyncLoading}
                  title="用续写完成时的正文重新提取并同步"
                >
                  {postWriteSyncBanner.fromPendingQueue ||
                  postWriteSyncBanner.phase === 'failed'
                    ? '补跑同步'
                    : postWriteSyncBanner.phase === 'partial'
                      ? '重新同步'
                      : '再同步一次'}
                </button>
              ) : null}
              {onDismissPendingSync &&
              (postWriteSyncBanner.fromPendingQueue ||
                postWriteSyncBanner.phase === 'failed') &&
              postWriteSyncBanner.phase !== 'syncing' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={onDismissPendingSync}
                  disabled={undoAutoSyncLoading}
                  title="从待同步队列移除"
                >
                  忽略
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <ChapterSelfCheckPanel
          report={selfCheckReport ?? localSelfCheck}
          defaultExpanded
          rerunLoading={selfCheckLoading || localSelfCheckLoading}
          onApplyToRewrite={onApplySelfCheckToRewrite}
          onApplyToContinue={onApplySelfCheckToContinue}
          onRerun={
            onRerunSelfCheck
              ? () => void onRerunSelfCheck()
              : async () => {
                  const api = window.api as {
                    selfCheckChapter?: (
                      pid: string,
                      ch: number,
                      content: string
                    ) => Promise<ChapterSelfCheckReport>
                  }
                  if (!api.selfCheckChapter) return
                  setLocalSelfCheckLoading(true)
                  try {
                    const r = await api.selfCheckChapter(projectId, chapterNumber, draft)
                    setLocalSelfCheck(r)
                  } catch (err) {
                    console.warn('[ChapterFlowPanel] selfCheck failed:', err)
                  } finally {
                    setLocalSelfCheckLoading(false)
                  }
                }
          }
        />

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
            <div className="btn-group" style={{ marginLeft: 'auto' }}>
              {onRetryAutoSync &&
              (postWriteSyncBanner?.phase === 'failed' ||
                postWriteSyncBanner?.phase === 'partial' ||
                memoryError) ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onRetryAutoSync}
                  disabled={memoryExtracting || postWriteSyncBanner?.phase === 'syncing'}
                  title="重新跑写后同步（提取 + 自动落盘）"
                >
                  补跑同步
                </button>
              ) : null}
              <button
                className="btn btn-sm"
                onClick={runMemoryExtract}
                disabled={memoryExtracting}
              >
                {memoryExtracting ? '提取中…' : memoryExtraction ? '重新提取' : '✦ 提取记忆'}
              </button>
            </div>
          </div>
          <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
            提取后自动写入：状态/设定变化 · 情节 · 伏笔回收（可看下方 diff）。需确认：新增角色 /
            地点 / 道具 / 伏笔。续写成功后会自动同步；失败可点「补跑同步」。
          </p>
          {memoryError ? (
            <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
              {memoryError}
            </p>
          ) : null}
          {memoryResult?.errors && memoryResult.errors.length > 0 && !memoryError ? (
            <p className="err" style={{ fontSize: 12.5, marginTop: 6 }}>
              自动写入部分失败：{memoryResult.errors.slice(0, 3).join('；')}
              {memoryResult.errors.length > 3
                ? ` 等 ${memoryResult.errors.length} 条`
                : ''}
            </p>
          ) : null}
          {memoryExtraction ? (
            <div style={{ marginTop: 8 }}>
              {/* 自动应用部分 + diff 预览 */}
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
                    {memoryResult ? '已同步（自动部分）' : '自动部分'}
                  </strong>
                  <button
                    className="btn btn-sm"
                    onClick={applyAutomatic}
                    disabled={memoryApplying || !hasAutoItems}
                    style={{ marginLeft: 'auto' }}
                    title={memoryResult ? '再次应用（会再追加状态轨迹）' : '手动应用自动部分'}
                  >
                    {memoryApplying
                      ? '应用中…'
                      : memoryResult
                        ? '重新应用'
                        : '应用自动部分'}
                  </button>
                </div>
                <ul className="bare" style={{ marginTop: 6, fontSize: 12, display: 'grid', gap: 4 }}>
                  <li>
                    角色状态/设定：{memoryExtraction.characterStateChanges.length} 项
                  </li>
                  <li>情节追加：{memoryExtraction.newPlotPoints.length} 项</li>
                  <li>伏笔回收：{memoryExtraction.collectedForeshadowings.length} 项</li>
                </ul>
                {memoryPreview && memoryPreview.diffs.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="meta" style={{ fontSize: 11.5, marginBottom: 4 }}>
                      {memoryResult ? '写入 diff' : '预览 diff'}（old → new）
                      {memoryPreview.confirmCount > 0
                        ? ` · 另有 ${memoryPreview.confirmCount} 项待确认`
                        : ''}
                    </div>
                    <ul
                      className="bare"
                      style={{
                        fontSize: 12,
                        display: 'grid',
                        gap: 6,
                        maxHeight: 200,
                        overflow: 'auto',
                        padding: '6px 8px',
                        background: 'var(--surface-2)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      {memoryPreview.diffs.map((d, i) => (
                        <li
                          key={`${d.kind}-${d.label}-${d.field ?? ''}-${i}`}
                          style={{
                            opacity: d.applicable ? 1 : 0.55,
                            lineHeight: 1.45
                          }}
                        >
                          <span className="muted" style={{ marginRight: 6 }}>
                            {d.kind === 'state'
                              ? '状态'
                              : d.kind === 'plot'
                                ? '情节'
                                : '伏笔'}
                          </span>
                          <strong>{d.label}</strong>
                          {d.field ? (
                            <span className="muted"> · {d.field}</span>
                          ) : null}
                          <div style={{ marginTop: 2 }}>
                            <span style={{ color: 'var(--ink-3)' }}>{d.oldValue || '（无）'}</span>
                            <span className="muted"> → </span>
                            <span style={{ color: 'var(--ok, #2e7d32)' }}>
                              {d.newValue || '（空）'}
                            </span>
                          </div>
                          {d.note ? (
                            <div className="muted" style={{ fontSize: 11 }}>
                              {d.note}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {memoryResult ? (
                  <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                    ✓ 已应用：状态 {memoryResult.applied.stateChanges} · 情节{' '}
                    {memoryResult.applied.plotPoints} · 伏笔 {memoryResult.applied.collected}
                    {memoryResult.errors.length > 0 ? (
                      <span className="err">（{memoryResult.errors.length} 项失败）</span>
                    ) : null}
                  </div>
                ) : memoryApplying ? (
                  <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                    正在自动写入人物状态/设定…
                  </div>
                ) : null}
              </div>

              {/* 设定演进 */}
              {settingsPreview &&
              (settingsPreview.diffs.length > 0 ||
                settingsPreview.suggestionCount > 0 ||
                (memoryExtraction.settingsSuggestions?.length ?? 0) > 0) ? (
                <div
                  style={{
                    border: '1px solid var(--line-soft)',
                    borderRadius: 'var(--r-sm)',
                    padding: 8,
                    marginBottom: 8
                  }}
                >
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 12.5 }}>设定演进</strong>
                    <button
                      className="btn btn-sm"
                      onClick={applySettingsAll}
                      disabled={
                        settingsApplying ||
                        settingsPreview.diffs.filter((d) => !d.note).length === 0
                      }
                      style={{ marginLeft: 'auto' }}
                      title="应用全部可写设定补丁（不含题材定位底稿）"
                    >
                      {settingsApplying
                        ? '应用中…'
                        : settingsResult
                          ? '重新应用设定'
                          : '应用设定补丁'}
                    </button>
                  </div>
                  <p className="meta" style={{ fontSize: 11.5, marginTop: 4 }}>
                    增量写入世界观/势力/关系等；题材定位不自动改。高置信已随同步自动写入。
                  </p>
                  {settingsPreview.diffs.length > 0 ? (
                    <ul
                      className="bare"
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        display: 'grid',
                        gap: 6,
                        maxHeight: 160,
                        overflow: 'auto',
                        padding: '6px 8px',
                        background: 'var(--surface-2)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      {settingsPreview.diffs.map((d, i) => (
                        <li key={`${d.fileName}-${d.title}-${i}`}>
                          <span className="muted">
                            {d.autoEligible ? '自动' : d.note ? '跳过' : '确认'} · {d.target}/
                            {d.fileName}
                          </span>
                          <div>
                            <strong>{d.title}</strong>
                            {d.confidence ? (
                              <span className="muted"> · {d.confidence}</span>
                            ) : null}
                          </div>
                          <div style={{ color: 'var(--ink-2)' }}>{d.content.slice(0, 120)}</div>
                          {d.reason ? (
                            <div className="muted" style={{ fontSize: 11 }}>
                              依据：{d.reason}
                            </div>
                          ) : null}
                          {d.note ? (
                            <div className="muted" style={{ fontSize: 11 }}>
                              {d.note}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {memoryExtraction.settingsSuggestions &&
                  memoryExtraction.settingsSuggestions.length > 0 ? (
                    <ul className="bare" style={{ marginTop: 6, fontSize: 12 }}>
                      {memoryExtraction.settingsSuggestions.map((s, i) => (
                        <li key={`sug-${i}`} className="muted">
                          建议手改 {s.suggestedPath}：{s.topic}（{s.reason}）
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {settingsResult ? (
                    <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                      ✓ 设定已应用 {settingsResult.applied} 项
                      {settingsResult.skipped > 0
                        ? ` · 跳过 ${settingsResult.skipped}`
                        : ''}
                      {settingsResult.errors.length > 0 ? (
                        <span className="err">
                          （{settingsResult.errors.length} 项失败）
                        </span>
                      ) : null}
                    </div>
                  ) : settingsApplying ? (
                    <div className="meta" style={{ marginTop: 6, fontSize: 11.5 }}>
                      正在写入设定补丁…
                    </div>
                  ) : null}
                </div>
              ) : null}

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
