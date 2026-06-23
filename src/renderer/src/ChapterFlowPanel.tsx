import { useState, useEffect, useRef } from 'react'
import type {
  AuditReport,
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
import ChapterAuditPanel from './ChapterAuditPanel'

interface Props {
  projectId: string
  chapterNumber: number
  draft: string
  auditReport: AuditReport | null
  reviewText: string
  reviewing: boolean
  onClose: () => void
  /** AI 改写命中段后，把 snippet 替换为 rewritten（P6-B：第三参 violationKey 用于 per-violation 撤销） */
  onApplyRewrite?: (snippet: string, rewritten: string, violationKey: string) => void
  /** 重新跑质检（用于"立即质检"按钮） */
  onRunAudit?: () => void | Promise<void>
  /** 撤销最近一次改写（从正文回滚） */
  onUndoRewrite?: () => void | Promise<void>
  /** 撤销指定位置的改写（0=最近一次，1=次新...） */
  onUndoRewriteAt?: (fromTop: number) => void | Promise<void>
  /** P6-B：按 violationKey 精确撤销对应那条应用 */
  onUndoRewriteByKey?: (violationKey: string) => void | Promise<void>
  /** 改写历史栈（完整数据，用于下拉菜单显示每条） */
  rewriteHistory?: Array<{ oldSnippet: string; newText: string; at: number }>
  /** P7-A：redoStack 长度（用于显示"重做 ×N"按钮） */
  redoStackCount?: number
  /** P7-A：重做最近一次被撤销的应用 */
  onRedoRewrite?: () => void | Promise<void>
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
    syncAllTrigger
  } = props
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
  const prevSyncAllTrigger = useRef(syncAllTrigger)
  useEffect(() => {
    // 跳过首次渲染
    if (prevSyncAllTrigger.current === syncAllTrigger) return
    prevSyncAllTrigger.current = syncAllTrigger
    void runAllSync()
    // 只关心 syncAllTrigger 变化，runAllSync 在组件内定义且引用稳定
  }, [syncAllTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="editor-panel" style={{ marginTop: 12 }}>
      <div className="ep-head">
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
            report={auditReport}
            loading={false}
            mode="soft"
            onRunAgain={onRunAudit}
            onApplyRewrite={onApplyRewrite}
            onUndoRewrite={onUndoRewrite}
            onUndoRewriteAt={onUndoRewriteAt}
            onUndoRewriteByKey={onUndoRewriteByKey}
            onRedoRewrite={onRedoRewrite}
            redoStackCount={redoStackCount}
            rewriteHistory={rewriteHistory}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <strong style={{ fontSize: 13 }}>AI 审稿建议</strong>
        {reviewing ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            审稿中…
          </p>
        ) : reviewText ? (
          <pre
            className="body"
            style={{ whiteSpace: 'pre-wrap', marginTop: 4, fontSize: 12.5, maxHeight: 240, overflow: 'auto' }}
          >
            {reviewText}
          </pre>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            暂无审稿结果。
          </p>
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
