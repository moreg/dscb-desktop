import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type {
  AuditReport,
  ChapterContent,
  ChapterVersion,
  ChapterSource,
  ChapterStatus,
  Character,
  Foreshadowing,
  MemoryEntity,
  ProjectData,
  StyleProfile,
  WriteStyleSelection
} from '../../shared/types'
import {
  pushEntry,
  popEntry,
  popEntryAt,
  revertInDraft,
  applyToDraft,
  findEntryByViolationKey,
  pushRedo,
  popRedo,
  clearRedoStack,
  detectUndoRedoShortcut,
  type RewriteEntry
} from '../../main/data/rewrite-history'
import {
  loadState,
  saveState,
  getLocalStorage
} from '../../main/data/rewrite-persistence'
import {
  formatTokens,
  formatCost,
  formatRelativeTime,
  evaluateCostAlert,
  shouldBlockAiGenerate,
  DEFAULT_COST_THRESHOLDS,
  type CostAlertLevel
} from '../../main/data/usage-summary'
import type { UsageSummary, CostAlertConfig, UsageRecord } from '../../shared/types'
import { analyze, rhythmWarnings, type ChapterStats } from './analyze'
import type { DetailedOutlineItem } from '../../shared/types'
import { buildForeshadowingReminders } from './foreshadowingReminders'
import ChapterFlowPanel from './ChapterFlowPanel'
import WeeklyWritingStats, { reportSaveDelta } from './WeeklyWritingStats'
import { getOutlineDetailRows } from './outlineDetailFields'
import { parseForeshadowReceipt } from '../../shared/parsers'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
  onOpenOutline?: () => void
}

const SOURCE_LABEL: Record<ChapterSource, string> = {
  manual: '手写',
  ai: 'AI',
  reviewed: '润色'
}

interface ReviewSuggestion {
  quote: string
  advice: string
  why: string
}

interface CastSuggestion {
  name: string
  reason: string
  quote: string
  /** 是否已加入登场 */
  applied: boolean
  /** 匹配到的人物 id；undefined 表示未在人物库中 */
  characterId?: string
}

/** 把 LLM 流式输出的"原文 → 建议 → 理由"格式解析成结构化建议 */
function parseSuggestions(text: string): ReviewSuggestion[] {
  // 按空行分段；每段查找 原文/建议/理由 标签
  const blocks = text.split(/\n{2,}/)
  const out: ReviewSuggestion[] = []
  for (const b of blocks) {
    if (!b.trim()) continue
    const find = (label: string) => {
      const re = new RegExp(`[【\\[\\]】]?\\s*${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n[【\\[\\]】]?\\s*(?:原文|建议|理由)|$)`)
      const m = b.match(re)
      return m ? m[1].trim() : ''
    }
    const quote = find('原文')
    const advice = find('建议')
    const why = find('理由')
    if (advice || quote) {
      out.push({ quote, advice, why })
    } else {
      // 没标签时整段作为建议
      out.push({ quote: '', advice: b.trim(), why: '' })
    }
  }
  return out
}

export default function ChapterEditor({ projectId, chapterNumber, onOpenOutline }: Props) {
  const [data, setData] = useState<ChapterContent | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<ChapterVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)
  const [viewing, setViewing] = useState<ChapterVersion | null>(null)
  const [generating, setGenerating] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [showCast, setShowCast] = useState(false)
  const [savingCast, setSavingCast] = useState(false)
  const [showVersionDialog, setShowVersionDialog] = useState(false)
  const [foreshadowings, setForeshadowings] = useState<Foreshadowing[]>([])
  const [locations, setLocations] = useState<MemoryEntity[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [chapterOutline, setChapterOutline] = useState<DetailedOutlineItem | null>(null)
  const [showChapterOutline, setShowChapterOutline] = useState(false)
  const [generatingOutline, setGeneratingOutline] = useState(false)
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [styleProfiles, setStyleProfiles] = useState<StyleProfile[]>([])
  const [styleSelection, setStyleSelection] = useState<WriteStyleSelection>({
    mode: 'projectDefault',
    styleProfileId: null
  })

  // 番茄钟默认值
  const DEFAULT_POMODORO_FOCUS_MINUTES = 25
  const DEFAULT_POMODORO_BREAK_MINUTES = 5

  const [pomoFocus, setPomoFocus] = useState(DEFAULT_POMODORO_FOCUS_MINUTES)
  const [pomoBreak, setPomoBreak] = useState(DEFAULT_POMODORO_BREAK_MINUTES)
  const [pomoMode, setPomoMode] = useState<'focus' | 'break'>('focus')
  const [pomoSecs, setPomoSecs] = useState(25 * 60)
  const [pomoRunning, setPomoRunning] = useState(false)
  const [pomoSessions, setPomoSessions] = useState(0)
  const [dailyGoal, setDailyGoal] = useState(3000)
  const [sessionStartWords, setSessionStartWords] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [reviewText, setReviewText] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [castSuggestions, setCastSuggestions] = useState<CastSuggestion[]>([])
  const [castApplied, setCastApplied] = useState(false)
  const [showCastPanel, setShowCastPanel] = useState(false)
  const [flowPanelOpen, setFlowPanelOpen] = useState(false)
  const [autoAudit, setAutoAudit] = useState<AuditReport | null>(null)
  const [reAuditLoading, setReAuditLoading] = useState(false)
  const [writeAuditMode, setWriteAuditMode] = useState<'soft' | 'strict'>('soft')
  /**
   * P11-A：上次持久化时间戳（毫秒）。null = 从未保存过。
   * 显示"已保存 X 秒前"小指示器，让用户知道"工作已自动保存"。
   * 切章时重置。
   */
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  /** 持久化是否正在 debounce 等待中（用于"保存中…"指示器） */
  const [isSaving, setIsSaving] = useState(false)
  /**
   * P10-A：用量统计 — 工具栏显示"今日 ¥X.XX"小徽章，点击展开 popover。
   * aiGenerate 完成时自动刷新（自动累加 LLM 调用）。
   */
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [usagePopoverOpen, setUsagePopoverOpen] = useState(false)
  // P16-C：点击趋势图某一天 → 显示当天 LLM 调用详情
  const [dayDetail, setDayDetail] = useState<{ date: string; records: UsageRecord[] } | null>(null)
  const [dayDetailLoading, setDayDetailLoading] = useState(false)
  // P12-C：用量预警（默认阈值；可后续接设置项做用户自定义）
  // P13-C + P14-C：从 settings 加载 costAlert config（用户在 SettingsPage 设置）
  const [costAlertConfig, setCostAlertConfig] = useState<CostAlertConfig>({
    enabled: true,
    warning: DEFAULT_COST_THRESHOLDS.warning,
    exceeded: DEFAULT_COST_THRESHOLDS.exceeded,
    blockOnExceeded: false
  })
  const [costAlertDismissed, setCostAlertDismissed] = useState<CostAlertLevel | null>(null)
  const refreshUsage = () => {
    void window.api.getUsageSummary().then((s) => {
      setUsage(s)
      // P12-C + P13-C：刷新后检查用量预警（用加载的 config，禁用时不检查）
      if (!costAlertConfig.enabled) return
      const alert = evaluateCostAlert(s.month.cost, {
        warning: costAlertConfig.warning,
        exceeded: costAlertConfig.exceeded
      })
      // 已 dismiss 同一等级不重复弹
      if (alert.level !== 'ok' && alert.level !== costAlertDismissed) {
        const message =
          alert.level === 'exceeded'
            ? `本月 AI 费用已达 ${formatCost(alert.cost)}，超过预警线 ${formatCost(alert.threshold!)}！建议检查用量或暂停续写。`
            : `本月 AI 费用已达 ${formatCost(alert.cost)}，接近预警线 ${formatCost(alert.threshold!)}。`
        setUndoToast({ message, type: alert.level === 'exceeded' ? 'error' : 'warning' })
        setCostAlertDismissed(alert.level)
      }
    })
  }
  /**
   * P16-C：点击趋势图某一天 → 拉取当天所有 LLM 调用记录。
   * 复用现有 popover 展示（节省模态框），用户可点 ✕ 关闭。
   */
  const loadDayDetail = async (date: string) => {
    setDayDetailLoading(true)
    setDayDetail({ date, records: [] }) // 占位（loading 状态）
    try {
      const records = await window.api.getUsageDayDetail(date)
      setDayDetail({ date, records })
    } catch {
      setDayDetail({ date, records: [] })
    } finally {
      setDayDetailLoading(false)
    }
  }

  /**
   * P6-C：撤销失败时显示的 toast 提示。
   * 简单实现：3 秒后自动消失。type 区分 warning（黄色）/ error（朱红）。
   */
  const [undoToast, setUndoToast] = useState<{ message: string; type: 'warning' | 'error' } | null>(null)
  useEffect(() => {
    if (!undoToast) return
    const id = setTimeout(() => setUndoToast(null), 3000)
    return () => clearTimeout(id)
  }, [undoToast])
  /**
   * 改写应用历史：每条 { oldSnippet, newText } 是一次 apply 操作。
   * "↶ 撤销" 弹最近一条（栈顶），把正文中的 newText 还原为 oldSnippet。
   * 容量上限 10 条，纯函数封装在 src/main/data/rewrite-history.ts（便于单测）。
   */
  const [rewriteHistory, setRewriteHistory] = useState<RewriteEntry[]>([])
  /**
   * P7-A：重做栈——undo 时把条目推入，redo 时弹出。
   * 任何新 apply 都清空 redoStack（标准编辑器行为）。
   */
  const [redoStack, setRedoStack] = useState<RewriteEntry[]>([])

  /**
   * 把一次成功的"应用到正文"压栈。
   * 切章/project 时清空（避免跨项目串台）。
   * P6-B：传 violationKey（来自 ChapterAuditPanel），用于 per-violation 精确撤销。
   */
  const pushRewrite = (oldSnippet: string, newText: string, violationKey?: string) => {
    setRewriteHistory((s) => pushEntry(s, oldSnippet, newText, Date.now(), violationKey))
    setRedoStack(clearRedoStack())
  }

  /**
   * 撤销最近一次改写：把 draft 中上一次应用的新文本还原成原文。
   * 还原后调用 reAudit 刷新违例清单。
   * 失败（P6-C）显示 toast 提示用户。
   */
  const undoLastRewrite = async () => {
    let popped: RewriteEntry | null = null
    setRewriteHistory((s) => {
      const r = popEntry(s)
      popped = r.popped
      return r.next
    })
    if (!popped) return
    applyRevert(popped)
  }

  /**
   * 撤销指定位置的改写（0 = 栈顶最近一次，1 = 次新...）。
   * 用于面板下拉菜单"撤销任意一条"。
   */
  const undoRewriteAt = async (fromTop: number) => {
    let popped: RewriteEntry | null = null
    setRewriteHistory((s) => {
      const r = popEntryAt(s, fromTop)
      popped = r.popped
      return r.next
    })
    if (!popped) return
    applyRevert(popped)
  }

  /**
   * P6-B：按 violationKey 找到最近一条对应条目并撤销。
   * 用于"↶ 撤销这次"按钮——只撤销用户实际点的那条应用，不影响其他已应用条目。
   */
  const undoRewriteByKey = async (violationKey: string) => {
    let popped: RewriteEntry | null = null
    let poppedIdx = -1
    setRewriteHistory((s) => {
      const idx = findEntryByViolationKey(s, violationKey)
      if (idx < 0) {
        // 找不到对应条目（可能已被撤销或 violationKey 未传）
        return s
      }
      popped = s[idx]
      poppedIdx = idx
      return [...s.slice(0, idx), ...s.slice(idx + 1)]
    })
    if (!popped) {
      setUndoToast({ message: '未找到这条改写的记录（可能已被撤销）', type: 'warning' })
      return
    }
    applyRevert(popped)
  }

  /**
   * P7-A：重做最近一次被撤销的应用。
   * 把 redoStack 顶部条目推回 history，并在 draft 中应用 oldSnippet → newText。
   * 失败（draft 中找不到 oldSnippet）显示 toast 并把条目塞回 redoStack。
   */
  const redoLastRewrite = async () => {
    let popped: RewriteEntry | null = null
    setRedoStack((s) => {
      const r = popRedo(s)
      popped = r.popped
      return r.next
    })
    if (!popped) return
    // 重做：把 newText 重新应用到 draft
    setDraft((d) => {
      const next = applyToDraft(d, popped!.oldSnippet, popped!.newText)
      if (next === d) {
        // 找不到 oldSnippet（可能用户手动改过）— toast 提示并把条目塞回 redoStack
        setRedoStack((rs) => pushRedo(rs, popped!))
        setUndoToast({
          message: '重做失败：正文中找不到原片段（可能被手动改过）',
          type: 'warning'
        })
        return d
      }
      // 成功：把条目推回 history
      setRewriteHistory((h) => pushEntry(h, popped!.oldSnippet, popped!.newText, popped!.at, popped!.violationKey))
      return next
    })
    setDirty(true)
    setTimeout(() => void reAudit(), 0)
  }

  /** 内部：把 popped 的 newText 还原成 oldSnippet，再触发 reAudit */
  const applyRevert = (popped: RewriteEntry) => {
    setDraft((d) => {
      const next = revertInDraft(d, popped.newText, popped.oldSnippet)
      if (next === d) {
        // 找不到新文本（可能用户手动改过）— P6-C 显示 toast
        setUndoToast({
          message: '撤销失败：正文中找不到改写片段（可能被手动改过）',
          type: 'warning'
        })
        return d
      }
      // 成功：把条目推到 redoStack 供 P7-A 重做
      setRedoStack((rs) => pushRedo(rs, popped))
      return next
    })
    setDirty(true)
    // 给 setDraft 一点时间生效再重跑（react 18 batching）
    setTimeout(() => void reAudit(), 0)
  }
  const reviewRef = useRef(0)
  const castRef = useRef(0)
  const genRef = useRef(0)

function parseCastJson(text: string): Omit<CastSuggestion, 'applied' | 'characterId'>[] {
  // LLM 可能输出 ```json ... ``` 或多余文本；尝试提取首个 JSON 数组
  const m = text.match(/\[\s*[\s\S]*?\]\s*(?=$|[^\]]*$)/)
  const candidate = m ? m[0] : text
  try {
    const arr = JSON.parse(candidate)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.name === 'string')
      .map((x) => ({
        name: String(x.name).trim(),
        reason: typeof x.reason === 'string' ? x.reason.trim() : '',
        quote: typeof x.quote === 'string' ? x.quote.trim() : ''
      }))
      .filter((x) => x.name)
  } catch {
    return []
  }
}

  const refreshVersions = () => {
    void window.api.listChapterVersions(projectId, chapterNumber).then(setVersions)
  }
  const refreshCharacters = () => {
    void window.api.listCharacters(projectId).then(setCharacters)
  }
  const refreshMemory = () => {
    void window.api.listForeshadowings(projectId).then(setForeshadowings)
    void window.api.listMemoryEntities(projectId, 'location').then(setLocations)
  }
  const refreshProjectStyleData = () => {
    void window.api.getProject(projectId).then(setProjectData)
    void window.api.listStyleProfiles(projectId).then(setStyleProfiles)
  }

  const refreshChapterOutline = () => {
    void window.api.listDetailedOutline(projectId).then((items) => {
      setChapterOutline(items.find((it) => it.chapterNumber === chapterNumber) ?? null)
    })
  }

  useEffect(() => {
    ++genRef.current
    setGenerating(false)
    // 切章/project 时清空内存中的改写历史（避免跨章串台）
    setRewriteHistory([])
    setRedoStack([])
    setLastSavedAt(null) // P11-A：切章时重置"上次保存"指示
    // P9-A：从 localStorage 加载该章的持久化改写历史（如果存在）
    const storage = getLocalStorage()
    const persisted = loadState(storage, projectId, chapterNumber)
    if (persisted) {
      setRewriteHistory(persisted.history)
      setRedoStack(persisted.redoStack)
      setLastSavedAt(Date.now()) // P11-A：刚加载时也算"已保存"
    }
    void window.api.getChapter(projectId, chapterNumber).then((c) => {
      setData(c)
      setDraft(c.content)
      setDirty(false)
      setSessionStartWords(c.meta.wordCount)
    })
    refreshVersions()
    refreshCharacters()
    refreshMemory()
    refreshChapterOutline()
    refreshProjectStyleData()
    setStyleSelection({ mode: 'projectDefault', styleProfileId: null })
  }, [projectId, chapterNumber])

  // P9-A：debounced 持久化。rewriteHistory 或 redoStack 变化时延迟 200ms 写入 localStorage。
  // 延迟合并：连续 apply/undo/redo 操作只在用户停手后写一次。
  useEffect(() => {
    const storage = getLocalStorage()
    if (!storage) return
    setIsSaving(true) // P11-A：标记正在 debounce
    const timer = setTimeout(() => {
      const ok = saveState(storage, projectId, chapterNumber, {
        version: 1,
        history: rewriteHistory,
        redoStack
      })
      if (ok) setLastSavedAt(Date.now()) // P11-A：成功后更新指示器
      setIsSaving(false)
    }, 200)
    return () => {
      clearTimeout(timer)
      // 注意：不要在这里 setIsSaving(false)，因为可能下一个 useEffect run 还在 debouncing
      // 真正的 false 在 setTimeout 回调里设置
    }
  }, [rewriteHistory, redoStack, projectId, chapterNumber])

  // P19-A：自动保存草稿。draft 变化时延迟 800ms 写入 `.draft-NNN.md`。
  // 与正式保存（💾 Save）独立——正式保存会清掉 draft。
  const [draftBanner, setDraftBanner] = useState<{ content: string; at: number } | null>(null)
  useEffect(() => {
    // 跳过"刚加载章节"和"切章中"的初始化写
    if (!data) return
    // 跳过未变更的"setDraft(c.content)"——data.content === draft 时没必要写
    if (data.content === draft) return
    const timer = setTimeout(() => {
      void window.api.saveDraft(projectId, chapterNumber, draft)
    }, 800)
    return () => clearTimeout(timer)
  }, [draft, projectId, chapterNumber, data])

  // P19-A：打开章节时检查 draft，存在且与正文不同则提示恢复
  useEffect(() => {
    if (!data) return
    void window.api.readDraft(projectId, chapterNumber).then((d) => {
      if (d && d.different) {
        setDraftBanner({ content: d.content, at: d.at })
      } else {
        setDraftBanner(null)
      }
    })
  }, [projectId, chapterNumber, data?.content]) // eslint-disable-line react-hooks/exhaustive-deps

  const defaultStyleProfile = projectData?.defaultStyleProfileId
    ? styleProfiles.find((item) => item.id === projectData.defaultStyleProfileId) ?? null
    : null
  const activeStyleProfile =
    styleSelection.mode === 'custom'
      ? styleProfiles.find((item) => item.id === styleSelection.styleProfileId) ?? null
      : defaultStyleProfile
  const requestedStyleProfileId =
    styleSelection.mode === 'custom' ? styleSelection.styleProfileId : null

  // P19-A：正式保存（💾 Save）成功后清掉 draft（已生效，不再需要备份）
  // 实现：包装 save 为 saveAndClearDraft（用 ref 避免循环引用）
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const saveAndClearDraft = useCallback(async () => {
    await saveRef.current()
    // P19-B：上报保存 delta 到 weekly stats
    const delta = (data?.content.length ?? 0) - draft.length
    reportSaveDelta(-delta) // 注意：save 后的字 = data.content.length（旧的），增量 = 新字 - 旧字 = -delta
    await window.api.discardDraft(projectId, chapterNumber)
    setDraftBanner(null)
  }, [projectId, chapterNumber, data, draft])

  // 加载番茄钟配置 + 每日目标 + 写作品质模式
  useEffect(() => {
    void window.api.getPomodoroConfig().then((cfg) => {
      setPomoFocus(cfg.focus)
      setPomoBreak(cfg.brk)
      setPomoSecs(cfg.focus * 60)
    })
    void window.api.getDailyWordGoal().then(setDailyGoal)
    void window.api.getWriteAuditConfig().then((cfg) => setWriteAuditMode(cfg.mode))
    // P13-C：加载用量预警配置
    void window.api.getCostAlertConfig().then(setCostAlertConfig)
  }, [])

  // P10-A：加载用量统计（页面打开时 + 切章时刷新）
  useEffect(() => {
    refreshUsage()
  }, [projectId])

  // P10-A：点 popover 外区域关闭
  useEffect(() => {
    if (!usagePopoverOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('.usage-popover-root')) return
      setUsagePopoverOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [usagePopoverOpen])

  // P11-A：每 10 秒重渲染一次，让"X 秒前"指示器保持新鲜
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  // 全局快捷键：Ctrl+Shift+A 重新质检 + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 重新质检：Ctrl+Shift+A
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        void reAudit()
        return
      }
      // Undo/Redo：通过纯函数判断（跨平台兼容 + 不在 textarea 内拦截）
      const intent = detectUndoRedoShortcut({
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
        key: e.key,
        targetTag: (e.target as HTMLElement | null)?.tagName ?? ''
      })
      if (intent === 'undo' && rewriteHistory.length > 0) {
        e.preventDefault()
        void undoLastRewrite()
      } else if (intent === 'redo' && redoStack.length > 0) {
        e.preventDefault()
        void redoLastRewrite()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 闭包依赖 rewriteHistory.length + redoStack.length + reAudit/undoLastRewrite/redoLastRewrite；
  }, [draft, rewriteHistory.length, redoStack.length])

  // P19-A：离开页面/切章前提醒未保存内容
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = '' // 触发浏览器原生确认弹窗
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /**
   * 手动重新跑 AI 味检查（写完之后任何时候都能重看违例清单）。
   * 不修改正文，只刷新 autoAudit 并打开 flowPanel 让用户看结果。
   */
  const reAudit = async () => {
    setReAuditLoading(true)
    try {
      const report = await window.api.auditChapter(projectId, draft)
      setAutoAudit(report)
      setFlowPanelOpen(true)
    } catch {
      // 静默失败
    } finally {
      setReAuditLoading(false)
    }
  }

  const save = async () => {
    // 保存前自动跑一次检查；strict 模式下若 error > 0 弹窗确认
    let preAudit: AuditReport | null = null
    if (writeAuditMode === 'strict') {
      try {
        preAudit = await window.api.auditChapter(projectId, draft)
        setAutoAudit(preAudit)
        if (preAudit.counts.error > 0) {
          const proceed = window.confirm(
            `检测到 ${preAudit.counts.error} 处 error 级违例（章末/禁用词/规则等）。strict 模式要求修复后再保存，是否仍要保存？`
          )
          if (!proceed) {
            setFlowPanelOpen(true)
            return
          }
        }
      } catch {
        // skip：检查失败不阻断保存
      }
    } else {
      // soft 模式：保存前静默跑一次，刷新 audit 面板即可
      try {
        preAudit = await window.api.auditChapter(projectId, draft)
        setAutoAudit(preAudit)
      } catch {
        // skip
      }
    }
    setSaving(true)
    try {
      const meta = await window.api.updateChapterContent(projectId, chapterNumber, draft)
      setData({ meta, content: draft })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }
  saveRef.current = save // P19-A：让 saveAndClearDraft 在保存后清掉 draft

  const saveAsVersion = async () => setShowVersionDialog(true)

  const submitVersion = async (source: ChapterSource, note: string) => {
    setSavingVersion(true)
    setShowVersionDialog(false)
    try {
      await window.api.createChapterVersion(projectId, chapterNumber, {
        source,
        content: draft,
        note: note.trim() || undefined
      })
      refreshVersions()
    } finally {
      setSavingVersion(false)
    }
  }

  const aiGenerate = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    // P14-C：硬上限拦截——若 usage 已超阈值且用户开启 blockOnExceeded，弹确认
    if (usage && shouldBlockAiGenerate(usage.month.cost, costAlertConfig)) {
      const proceed = window.confirm(
        `本月 AI 费用已达 ${formatCost(usage.month.cost)}，超过预警线 ${formatCost(costAlertConfig.exceeded)}。\n\n确认继续续写？\n\n（提示：可在 设置 → 用量与费用 关闭"exceeded 时弹确认"）`
      )
      if (!proceed) return
    }
    setGenerating(true)
    setDraft('')
    setFlowPanelOpen(false)
    setAutoAudit(null)
    setReviewText('')
    const myGen = ++genRef.current
    let finalDraft = ''
    try {
      const result = await window.api.generateChapterStream(
        projectId,
        chapterNumber,
        requestedStyleProfileId,
        (token, done) => {
          if (genRef.current !== myGen) return
          if (token) {
            finalDraft += token
            setDraft((d) => d + token)
          }
          if (done) {
            setGenerating(false)
            refreshUsage() // P10-A：续写完成更新今日用量
            const { receipt, stripped } = parseForeshadowReceipt(finalDraft)
            if (receipt) {
              setDraft(stripped)
              window.api.applyForeshadowReceipt(projectId, chapterNumber, receipt)
                .then(res => {
                  if (res.planted > 0 || res.collected > 0) {
                    setUndoToast({ message: `AI自动记录了伏笔：新增 ${res.planted} 条，回收 ${res.collected} 条`, type: 'warning' })
                  }
                })
                .catch(console.error)
            }
          }
        }
      )
      if (genRef.current !== myGen) return
      if (!result.ok) {
        setGenerating(false)
        const msg =
          result.error === 'LLM_AUTH_FAILED'
            ? '认证失败，请检查 API Key'
            : result.error === 'LLM_RATE_LIMIT'
              ? '请求过于频繁，请稍后再试'
              : '生成失败，请重试'
        window.alert(msg)
        return
      }
      setDirty(true)
      // Phase 12 Task 2：续写完成后自动跑质检 + 自动审核
      try {
        const report = await window.api.auditChapter(projectId, finalDraft)
        if (genRef.current !== myGen) return
        setAutoAudit(report)
      } catch {
        // 质检失败不阻断
      }
      if (await window.api.hasLlmKey()) {
        setReviewOpen(true)
        setReviewing(true)
        setReviewText('')
        const myReview = ++reviewRef.current
        try {
          const r = await window.api.reviewChapterStream(
            projectId,
            chapterNumber,
            (token, done) => {
              if (reviewRef.current !== myReview) return
              if (token) setReviewText((t) => t + token)
              if (done) {
                setReviewing(false)
                refreshUsage() // P10-A：审稿完成更新今日用量
              }
            }
          )
          if (reviewRef.current !== myReview) return
          if (!r.ok) {
            setReviewing(false)
            setReviewText(
              (t) =>
                t +
                (r.error === 'LLM_AUTH_FAILED'
                  ? '\n\n⚠ 认证失败，请检查 API Key'
                  : '\n\n⚠ 生成失败：' + (r.error ?? '未知错误'))
            )
          }
        } catch {
          if (reviewRef.current === myReview) setReviewing(false)
        }
      }
      setFlowPanelOpen(true)
    } catch {
      if (genRef.current === myGen) setGenerating(false)
    }
  }

  const startReview = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setReviewOpen(true)
    setReviewing(true)
    setReviewText('')
    const myReview = ++reviewRef.current
    try {
      const result = await window.api.reviewChapterStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (reviewRef.current !== myReview) return
          if (token) setReviewText((t) => t + token)
          if (done) setReviewing(false)
        }
      )
      if (reviewRef.current !== myReview) return
      if (!result.ok) {
        setReviewing(false)
        setReviewText(
          (t) =>
            t +
            (result.error === 'LLM_AUTH_FAILED'
              ? '\n\n⚠ 认证失败，请检查 API Key'
              : '\n\n⚠ 生成失败：' + (result.error ?? '未知错误'))
        )
      }
    } catch {
      if (reviewRef.current === myReview) setReviewing(false)
    }
  }

  const startDetectCast = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setShowCastPanel(true)
    setDetecting(true)
    setCastSuggestions([])
    setCastApplied(false)
    const myCast = ++castRef.current
    let buffer = ''
    try {
      const result = await window.api.detectCastStream(
        projectId,
        chapterNumber,
        (token, done) => {
          if (castRef.current !== myCast) return
          if (token) buffer += token
          if (done) setDetecting(false)
        }
      )
      if (castRef.current !== myCast) return
      if (!result.ok) {
        setDetecting(false)
        window.alert('识别失败：' + (result.error ?? '未知错误'))
        return
      }
      const parsed = parseCastJson(buffer)
      // 匹配人物库
      const merged: CastSuggestion[] = parsed.map((p) => {
        const found = characters.find((c) => c.name === p.name)
        return { ...p, applied: false, characterId: found?.id }
      })
      setCastSuggestions(merged)
    } catch {
      if (castRef.current === myCast) setDetecting(false)
    }
  }

  const applyCastSuggestions = async () => {
    if (!data) return
    const matched = castSuggestions.filter((s) => s.characterId && !s.applied)
    if (matched.length === 0) return
    const ids = new Set(appearing)
    matched.forEach((s) => s.characterId && ids.add(s.characterId))
    setSavingCast(true)
    try {
      const meta = await window.api.updateChapterMeta(projectId, chapterNumber, {
        appearingCharacters: [...ids]
      })
      setData({ ...data, meta })
      setCastSuggestions((arr) =>
        arr.map((s) => (matched.find((m) => m.name === s.name) ? { ...s, applied: true } : s))
      )
      setCastApplied(true)
    } finally {
      setSavingCast(false)
    }
  }

  const rollback = async (v: ChapterVersion) => {
    if (!window.confirm(`回滚到版本 ${v.versionNumber}（${SOURCE_LABEL[v.source]}）？当前正文将被覆盖。`))
      return
    const meta = await window.api.rollbackChapter(projectId, chapterNumber, v.versionNumber)
    setDraft(v.content)
    setData({ meta, content: v.content })
    setDirty(false)
    setViewing(null)
  }

  const removeVersion = async (v: ChapterVersion) => {
    if (!window.confirm(`删除版本 ${v.versionNumber}？`)) return
    await window.api.deleteChapterVersion(projectId, chapterNumber, v.versionNumber)
    refreshVersions()
  }

  const appearing = data?.meta.appearingCharacters ?? []
  const appearingSet = useMemo(() => new Set(appearing), [appearing])

  const toggleCast = async (id: string) => {
    if (!data) return
    const next = appearingSet.has(id)
      ? appearing.filter((x) => x !== id)
      : [...appearing, id]
    setSavingCast(true)
    try {
      const meta = await window.api.updateChapterMeta(projectId, chapterNumber, {
        appearingCharacters: next
      })
      setData({ ...data, meta })
    } finally {
      setSavingCast(false)
    }
  }

  const cycleStatus = async () => {
    if (!data) return
    const order: ChapterStatus[] = ['outline', 'draft', 'reviewed', 'published']
    const idx = order.indexOf(data.meta.status)
    const next = order[(idx + 1) % order.length]
    const meta = await window.api.updateChapterMeta(projectId, chapterNumber, { status: next })
    setData({ ...data, meta })
  }

  // 番茄钟计时
  useEffect(() => {
    if (!pomoRunning) return
    const id = setInterval(() => {
      setPomoSecs((s) => {
        if (s > 1) return s - 1
        // 倒计时结束
        setPomoRunning(false)
        if (pomoMode === 'focus') {
          setPomoSessions((n) => n + 1)
          setPomoMode('break')
          return pomoBreak * 60
        } else {
          setPomoMode('focus')
          return pomoFocus * 60
        }
      })
    }, 1000)
    return () => clearInterval(id)
  }, [pomoRunning, pomoMode, pomoFocus, pomoBreak])

  const pomoToggle = () => setPomoRunning((r) => !r)
  const pomoReset = () => {
    setPomoRunning(false)
    setPomoMode('focus')
    setPomoSecs(pomoFocus * 60)
  }

  const generateThisChapterOutline = async () => {
    if (!(await window.api.hasLlmKey())) {
      window.alert('请先在「⚙ 设置 → 模型服务」中配置 provider')
      return
    }
    setGeneratingOutline(true)
    try {
      await window.api.generateDetailedOutline(projectId, chapterNumber)
      refreshChapterOutline()
    } finally {
      setGeneratingOutline(false)
    }
  }

  // 会话字数：当前字数 - 进入时字数
  const sessionWords = useMemo(() => {
    const cur = (draft.match(/\S/g) ?? []).length
    return Math.max(0, cur - sessionStartWords)
  }, [draft, sessionStartWords])

  // 联动高亮：构建 (text, kind) 序列
  const previewSegments = useMemo(() => {
    if (!showPreview) return null
    type Hit = { start: number; end: number; kind: 'char' | 'foreshadow' | 'location'; label: string }
    const hits: Hit[] = []
    const pushHits = (terms: string[], kind: Hit['kind'], label: string) => {
      for (const t of terms) {
        if (!t) continue
        let idx = 0
        while ((idx = draft.indexOf(t, idx)) >= 0) {
          hits.push({ start: idx, end: idx + t.length, kind, label })
          idx += t.length
        }
      }
    }
    pushHits(
      characters.map((c) => c.name),
      'char',
      '人物'
    )
    pushHints()
    function pushHints() {
      for (const f of foreshadowings) {
        if (f.content) {
          let idx = 0
          while ((idx = draft.indexOf(f.content, idx)) >= 0) {
            hits.push({ start: idx, end: idx + f.content.length, kind: 'foreshadow', label: '伏笔' })
            idx += f.content.length
          }
        }
      }
      for (const l of locations) {
        if (l.name) {
          let idx = 0
          while ((idx = draft.indexOf(l.name, idx)) >= 0) {
            hits.push({ start: idx, end: idx + l.name.length, kind: 'location', label: '地点' })
            idx += l.name.length
          }
        }
      }
    }
    // 合并重叠区间，保留 kind 优先级 char > foreshadow > location
    if (hits.length === 0) return []
    hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    const merged: Hit[] = []
    for (const h of hits) {
      const last = merged[merged.length - 1]
      if (last && h.start < last.end) {
        // 重叠：跳过，避免嵌套
        continue
      }
      merged.push(h)
    }
    const out: { text: string; hl?: Hit }[] = []
    let cursor = 0
    for (const h of merged) {
      if (h.start > cursor) out.push({ text: draft.slice(cursor, h.start) })
      out.push({ text: draft.slice(h.start, h.end), hl: h })
      cursor = h.end
    }
    if (cursor < draft.length) out.push({ text: draft.slice(cursor) })
    return out
  }, [showPreview, draft, characters, foreshadowings, locations])

  const onPreviewClick = (kind: string, text: string) => {
    if (kind === 'char') {
      const c = characters.find((x) => x.name === text)
      if (c) window.alert(`人物 · ${c.name}\n身份：${c.identity ?? '—'}\n性格：${c.personality ?? '—'}`)
    } else if (kind === 'foreshadow') {
      const f = foreshadowings.find((x) => x.content === text)
      if (f) window.alert(`伏笔 · ${f.content}\n状态：${f.status}`)
    } else if (kind === 'location') {
      const l = locations.find((x) => x.name === text)
      if (l) window.alert(`地点 · ${l.name}\n分类：${l.category ?? '—'}`)
    }
  }

  const suggestions = useMemo(() => (reviewText ? parseSuggestions(reviewText) : []), [reviewText])
  const foreshadowingReminders = useMemo(
    () => buildForeshadowingReminders(chapterNumber, chapterOutline, foreshadowings),
    [chapterNumber, chapterOutline, foreshadowings]
  )
  const foreshadowingReminderCount =
    foreshadowingReminders.plant.length +
    foreshadowingReminders.reinforce.length +
    foreshadowingReminders.collect.length

  if (!data) return <p className="empty">展卷中…</p>

  const STATUS_FULL: Record<ChapterStatus, string> = {
    outline: '大纲',
    draft: '草稿',
    reviewed: '润色',
    published: '定稿'
  }
  const STATUS_CLASS: Record<ChapterStatus, string> = {
    outline: 'status-outline',
    draft: 'status-draft',
    reviewed: 'status-reviewed',
    published: 'status-published'
  }

  return (
    <div className={`chapter-editor-shell${reviewOpen ? ' review-open' : ''}`}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>第 {data.meta.chapterNumber} 章 · {data.meta.title}</h1>
            <p className="desc">
              <span className="num">{data.meta.wordCount.toLocaleString()}</span> 字 ·{' '}
              <span className="num">{versions.length}</span> 版
            </p>
          </div>
          <span
            className={`editor-status ${STATUS_CLASS[data.meta.status]}`}
            onClick={cycleStatus}
            title="点击切换状态"
          >
            {STATUS_FULL[data.meta.status]} ↻
          </span>
        </div>
      </div>

      {/* P19-A：草稿恢复 banner（检测到比正文更新的 draft 时显示） */}
      {draftBanner ? (
        <div className="draft-banner">
          <span>
            📝 检测到 {formatRelativeTime(draftBanner.at, Date.now())} 的未保存草稿（{draftBanner.content.length} 字）
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setDraft(draftBanner.content)
                setDirty(true)
                setDraftBanner(null)
              }}
            >
              恢复
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void window.api.discardDraft(projectId, chapterNumber)
                setDraftBanner(null)
              }}
            >
              丢弃
            </button>
          </div>
        </div>
      ) : null}

      {/* 操作工具栏 */}
      <div className="editor-toolbar">
        <button
          className="btn btn-sm"
          onClick={saveAndClearDraft}
          disabled={!dirty || saving}
        >
          {saving ? '保存中…' : dirty ? '保存 ·' : '已存'}
        </button>
        <button className="btn btn-sm" onClick={saveAsVersion} disabled={savingVersion}>
          存版本
        </button>
        <button className="btn btn-sm" onClick={() => setShowVersions((s) => !s)}>
          {showVersions ? '收起版本' : `版本 ${versions.length}`}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setShowPreview((s) => !s)}
          title="按人物/伏笔/地点高亮正文"
        >
          {showPreview ? '收起预览' : '👁 预览'}
        </button>
        <span className="spacer" />
        {/* P11-A：保存指示器 — 让用户知道"工作已自动保存" */}
        {lastSavedAt !== null ? (
          <span
            className="save-indicator"
            title={isSaving ? '正在保存…' : `上次保存：${new Date(lastSavedAt).toLocaleTimeString()}`}
          >
            {isSaving ? '⟳ 保存中…' : `✓ 已保存 ${formatRelativeTime(lastSavedAt, Date.now())}`}
          </span>
        ) : null}
        {/* P10-A：用量徽章 — 显示今日费用，点击展开 popover */}
        <div className="usage-popover-root" style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setUsagePopoverOpen((o) => !o)}
            title="今日 AI 用量（点击查看详情）"
          >
            📊 今日{usage ? ` ${formatCost(usage.today.cost)}` : '…'}
          </button>
          {usagePopoverOpen && usage ? (
            <div className="usage-popover">
              <div className="usage-popover-title">用量统计</div>
              <div className="usage-popover-grid">
                <div className="usage-popover-cell">
                  <div className="label">今日</div>
                  <div className="tokens">{formatTokens(usage.today.total)}</div>
                  <div className="cost">{formatCost(usage.today.cost)}</div>
                </div>
                <div className="usage-popover-cell">
                  <div className="label">本月</div>
                  <div className="tokens">{formatTokens(usage.month.total)}</div>
                  <div className="cost">{formatCost(usage.month.cost)}</div>
                </div>
                <div className="usage-popover-cell">
                  <div className="label">累计</div>
                  <div className="tokens">{formatTokens(usage.allTime.total)}</div>
                  <div className="cost">{formatCost(usage.allTime.cost)}</div>
                </div>
              </div>
              {usage.byFeature.length > 0 ? (
                <div className="usage-popover-features">
                  <div className="usage-popover-section-title">按功能</div>
                  {usage.byFeature.map((f) => (
                    <div key={f.feature} className="usage-popover-row">
                      <span style={{ minWidth: 70 }}>{f.feature}</span>
                      <span className="meta" style={{ marginLeft: 'auto' }}>
                        {formatTokens(f.total)} · {formatCost(f.cost)} · {f.calls}次
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* P15-A：最近 7 天趋势图 */}
              {usage.byDay && usage.byDay.length > 0 ? (
                <div className="usage-popover-trend">
                  <div className="usage-popover-section-title">最近 7 天（点击查看详情）</div>
                  <div className="usage-trend-chart">
                    {(() => {
                      const max = Math.max(...usage.byDay.map((d) => d.cost), 0.01)
                      return usage.byDay.map((d) => {
                        const pct = (d.cost / max) * 100
                        const dateLabel = d.date.slice(5) // MM-DD
                        const isSelected = dayDetail?.date === d.date
                        return (
                          <div
                            key={d.date}
                            className={`usage-trend-col${isSelected ? ' selected' : ''}`}
                            title={`${d.date}: ${formatCost(d.cost)} · ${d.calls}次（点击查看详情）`}
                            onClick={() => loadDayDetail(d.date)}
                          >
                            <div className="usage-trend-bar-wrap">
                              <div
                                className="usage-trend-bar"
                                style={{ height: `${Math.max(pct, 2)}%` }}
                              />
                            </div>
                            <div className="usage-trend-label">{dateLabel}</div>
                            <div className="usage-trend-value">{formatCost(d.cost)}</div>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              ) : null}

              {/* P16-C：单日详情 */}
              {dayDetail ? (
                <div className="usage-day-detail">
                  <div className="usage-popover-section-title" style={{ display: 'flex', alignItems: 'center' }}>
                    <span>{dayDetail.date} 的 LLM 调用</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setDayDetail(null)}
                      style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11 }}
                      title="关闭详情"
                    >
                      ✕
                    </button>
                  </div>
                  {dayDetailLoading ? (
                    <div className="muted" style={{ fontSize: 11, padding: '4px 0' }}>加载中…</div>
                  ) : dayDetail.records.length === 0 ? (
                    <div className="muted" style={{ fontSize: 11, padding: '4px 0' }}>这天没有 LLM 调用</div>
                  ) : (
                    <ul className="usage-day-list">
                      {dayDetail.records.map((r, i) => (
                        <li key={i} className="usage-day-list-item">
                          <span className="usage-day-time">{r.at.slice(11, 16)}</span>
                          <span className="usage-day-feature">{r.feature}</span>
                          <span className="usage-day-meta">
                            {formatTokens(r.totalTokens)} · {r.model}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          className="btn btn-sm"
          onClick={reAudit}
          disabled={reAuditLoading}
          title="对当前 draft 重新跑 AI 味检查（章末/禁用词/规则/字数）"
        >
          {reAuditLoading ? '检查中…' : '🔍 重新质检'}
        </button>
        <button className="btn btn-sm" onClick={startReview} disabled={reviewing}>
          {reviewing ? '审稿中…' : '✎ AI 改稿'}
        </button>
        <button className="btn btn-primary btn-sm" onClick={aiGenerate} disabled={generating}>
          {generating ? '落墨中…' : '✦ 续写'}
        </button>
      </div>

      {/* 番茄钟 + 写作进度 */}
      <div className="chapter-workbench">
        <div className="chapter-side-block">
      <div className="row" style={{ marginTop: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className={`pomodoro ${pomoMode === 'break' ? 'break' : ''}`}>
          <span
            className={`dot ${pomoRunning ? 'running' : ''}`}
            title={pomoMode === 'focus' ? '专注中' : '休息中'}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {pomoMode === 'focus' ? '专注' : '休息'}
          </span>
          <span className="time">
            {String(Math.floor(pomoSecs / 60)).padStart(2, '0')}:
            {String(pomoSecs % 60).padStart(2, '0')}
          </span>
          <button onClick={pomoToggle} title={pomoRunning ? '暂停' : '开始'}>
            {pomoRunning ? '⏸' : '▶'}
          </button>
          <button onClick={pomoReset} title="重置">
            ↺
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            今日 {pomoSessions} 番
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="goal-row">
            <span>本次会话</span>
            <span className="num">+{sessionWords}</span>
            <span>字 · 每日目标</span>
            <span className="num">{dailyGoal.toLocaleString()}</span>
            <span>字</span>
          </div>
          <div className="goal-bar">
            <div
              className={`fill ${sessionWords >= dailyGoal ? 'done' : ''}`}
              style={{ width: `${Math.min(100, (sessionWords / Math.max(1, dailyGoal)) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* P19-B：7 日热力图 + 跨章节今日字数 */}
      <div className="card" style={{ marginBottom: 12, padding: 12 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13.5 }}>文风</strong>
          <span className="chip">
            {activeStyleProfile?.name ?? defaultStyleProfile?.name ?? '无'}
          </span>
          <span className="meta" style={{ fontSize: 12 }}>
            {styleSelection.mode === 'custom' ? '本章临时文风' : '项目默认文风'}
          </span>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <select
            className="select"
            value={
              styleSelection.mode === 'custom'
                ? styleSelection.styleProfileId ?? ''
                : '__project_default__'
            }
            onChange={(e) => {
              const value = e.target.value
              if (value === '__project_default__') {
                setStyleSelection({ mode: 'projectDefault', styleProfileId: null })
                return
              }
              setStyleSelection({ mode: 'custom', styleProfileId: value || null })
            }}
            style={{ minWidth: 240 }}
          >
            <option value="__project_default__">
              使用项目默认{defaultStyleProfile ? `（${defaultStyleProfile.name}）` : '（无）'}
            </option>
            {styleProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setStyleSelection({ mode: 'projectDefault', styleProfileId: null })}
            disabled={styleSelection.mode === 'projectDefault'}
          >
            恢复默认
          </button>
          <span className="meta" style={{ fontSize: 12 }}>
            {activeStyleProfile?.identifiedStyle ?? '未指定文风'}
          </span>
        </div>
      </div>

      <WeeklyWritingStats projectId={projectId} dailyTarget={dailyGoal} />

      {/* 本章细纲 */}
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setShowChapterOutline((s) => !s)}
        >
          {showChapterOutline ? '收起本章细纲' : '📜 本章细纲'}
        </button>
        {onOpenOutline ? (
          <button className="btn btn-sm btn-ghost" onClick={onOpenOutline}>
            大纲页 →
          </button>
        ) : null}
      </div>
      {showChapterOutline ? (
        <div className="chapter-outline-panel">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <strong style={{ fontSize: 13.5 }}>
              第 {chapterNumber} 章细纲
            </strong>
            <button
              className="btn btn-sm"
              onClick={generateThisChapterOutline}
              disabled={generatingOutline}
              style={{ marginLeft: 'auto' }}
            >
              {generatingOutline
                ? '运笔中…'
                : chapterOutline
                  ? '重新生成'
                  : '✦ 生成细纲'}
            </button>
          </div>
          {chapterOutline ? (
            <>
              <div className="outline-detail-fields">
                {getOutlineDetailRows(chapterOutline).map((row) => (
                  <OutlineDetailField key={row.label} row={row} />
                ))}
              </div>
              {/* P19-D：本章出场角色速查 */}
              {chapterOutline.charactersAppearing?.length ? (
                <div className="outline-characters-row" style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>本章出场：</span>
                  {chapterOutline.charactersAppearing.map((name) => {
                    const c = characters.find((x) => x.name === name)
                    return (
                      <span
                        key={name}
                        className="character-chip"
                        title={c ? `${c.role ?? '角色'}` : '本章规划出场'}
                      >
                        {name}
                      </span>
                    )
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <p className="missing">本章暂无细纲，点「生成细纲」让 AI 据总纲铺陈。</p>
          )}
        </div>
      ) : null}

      <div className="chapter-outline-panel" style={{ marginTop: 10, marginBottom: 10 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <strong style={{ fontSize: 13.5 }}>本章伏笔提醒</strong>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            {foreshadowingReminderCount > 0
              ? `${foreshadowingReminderCount} 条待关注`
              : '暂无本章伏笔任务'}
          </span>
        </div>
        {foreshadowingReminderCount > 0 ? (
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {foreshadowingReminders.plant.length > 0 ? (
              <ReminderGroup title="细纲提示" items={foreshadowingReminders.plant.map((item) => item.content)} tone="hook" />
            ) : null}
            {foreshadowingReminders.reinforce.length > 0 ? (
              <ReminderGroup title="待埋 / 待强化" items={foreshadowingReminders.reinforce.map((item) => item.content)} tone="cool" />
            ) : null}
            {foreshadowingReminders.collect.length > 0 ? (
              <ReminderGroup title="本章待回收" items={foreshadowingReminders.collect.map((item) => item.content)} tone="emotion" />
            ) : null}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            细纲和伏笔库里没有匹配到当前章节的铺设或回收任务。
          </p>
        )}
      </div>

      {flowPanelOpen ? (
        <ChapterFlowPanel
          projectId={projectId}
          chapterNumber={chapterNumber}
          draft={draft}
          auditReport={autoAudit}
          reviewText={reviewText}
          reviewing={reviewing}
          onClose={() => setFlowPanelOpen(false)}
          onRunAudit={reAudit}
          onApplyRewrite={(snippet, rewritten, violationKey) => {
            // 用改写后的文本替换 draft 中的命中段（保留前后原文）
            if (!snippet) return
            const idx = draft.indexOf(snippet)
            if (idx < 0) {
              window.alert('未在正文中找到原片段（可能已被改写），请手动应用')
              return
            }
            const next = draft.slice(0, idx) + rewritten + draft.slice(idx + snippet.length)
            setDraft(next)
            setDirty(true)
            // 压栈：记录这次 apply 用于"↶ 撤销"。P6-B 传 violationKey 用于 per-violation 撤销。
            pushRewrite(snippet, rewritten, violationKey)
            // 应用后自动重跑一次，让违例清单反映新正文
            void reAudit()
          }}
          rewriteHistory={rewriteHistory}
          redoStackCount={redoStack.length}
          onUndoRewrite={undoLastRewrite}
          onUndoRewriteAt={undoRewriteAt}
          onUndoRewriteByKey={undoRewriteByKey}
          onRedoRewrite={redoLastRewrite}
        />
      ) : null}

      {/* P6-C：撤销失败 toast（fixed 定位，不被面板遮挡） */}
        </div>

        <div className="chapter-main-pane">
      {undoToast ? (
        <div className={`undo-toast undo-toast-${undoToast.type}`} role="status">
          {undoToast.message}
        </div>
      ) : null}

      <textarea
        className="editor-text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(true)
        }}
        placeholder="此处落笔，或点「续写」让 AI 接续成文……"
        style={{ marginTop: 16 }}
      />

      {showPreview ? (
        <div className="chapter-main-preview">
          <div className="row" style={{ marginTop: 16, marginBottom: 4 }}>
            <strong style={{ fontSize: 13.5 }}>联动预览</strong>
            <div className="row" style={{ gap: 12, fontSize: 12, color: 'var(--ink-3)' }}>
              <span><span className="hl char" style={{ padding: '1px 4px' }}>人物</span></span>
              <span><span className="hl foreshadow" style={{ padding: '1px 4px' }}>伏笔</span></span>
              <span><span className="hl location" style={{ padding: '1px 4px' }}>地点</span></span>
            </div>
          </div>
          <div className="editor-preview">
            {previewSegments && previewSegments.length > 0 ? (
              previewSegments.map((seg, i) =>
                seg.hl ? (
                  <span
                    key={i}
                    className={`hl ${seg.hl.kind}`}
                    title={`${seg.hl.label} · ${seg.text}`}
                    onClick={() => onPreviewClick(seg.hl!.kind, seg.text)}
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span key={i}>{seg.text}</span>
                )
              )
            ) : (
              <span className="muted">暂无可联动高亮的内容。</span>
            )}
          </div>
        </div>
      ) : null}

        </div>

        <div className="chapter-side-block">
      <div className="editor-panel">
        <div className="ep-head">
          <div className="ep-title">
            本章登场人物
            <span className="count">
              {appearing.length} 位{savingCast ? ' · 保存中…' : ''}
            </span>
          </div>
          <div className="btn-group">
            <button
              className="btn btn-sm"
              onClick={startDetectCast}
              disabled={detecting}
              title="让 AI 扫描本章，自动列出出场人物"
            >
              {detecting ? '识别中…' : '🤖 AI 识别'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setShowCast((s) => !s)}
              disabled={characters.length === 0}
            >
              {showCast ? '收起' : '编辑登场'}
            </button>
          </div>
        </div>
        {appearing.length > 0 ? (
          <div className="outline-tags" style={{ marginTop: 4 }}>
            {appearing.map((id) => {
              const c = characters.find((x) => x.id === id)
              return (
                <span key={id} className="outline-tag emotion">
                  {c?.name ?? '（已删除）'}
                </span>
              )
            })}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            暂未标记。点「编辑登场」勾选本章出场的人物。
          </p>
        )}
        {showCast ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 6,
              marginTop: 10
            }}
          >
            {characters.length === 0 ? (
              <p className="empty" style={{ padding: 4 }}>
                尚无人物
              </p>
            ) : (
              characters.map((c) => {
                const on = appearingSet.has(c.id)
                return (
                  <span
                    key={c.id}
                    className={`filter-chip ${on ? 'active' : ''}`}
                    onClick={() => toggleCast(c.id)}
                  >
                    {on ? '✓ ' : ''}
                    {c.name}
                    {c.role ? ` · ${c.role}` : ''}
                  </span>
                )
              })
            )}
          </div>
        ) : null}
      </div>

      {showCastPanel ? (
        <CastSuggestionPanel
          suggestions={castSuggestions}
          characters={characters}
          detecting={detecting}
          applied={castApplied}
          onApply={applyCastSuggestions}
          onClose={() => setShowCastPanel(false)}
        />
      ) : null}

      <AnalysisPanel text={draft} />

      {showVersions ? (
        <div className="editor-panel">
          <div className="ep-head">
            <div className="ep-title">
              版本历史
              <span className="count">{versions.length}</span>
            </div>
          </div>
          {versions.length === 0 ? (
            <p className="empty">尚无版本，点「存版本」留存。</p>
          ) : (
            <ul className="bare">
              {[...versions].reverse().map((v) => (
                <li
                  key={v.versionNumber}
                  className="row"
                  style={{ borderBottom: '1px solid var(--line-soft)', paddingBottom: 8, paddingTop: 4 }}
                >
                  <div>
                    <strong>#{v.versionNumber}</strong>{' '}
                    <span className={`chip ${sourceChipClass(v.source)}`}>
                      {SOURCE_LABEL[v.source]}
                    </span>{' '}
                    <span className="meta">
                      {v.wordCount} 字 · {v.createdAt.replace('T', ' ').slice(0, 16)}
                    </span>
                    {v.note ? <div className="muted">{v.note}</div> : null}
                  </div>
                  <div className="btn-group">
                    <button className="btn btn-sm" onClick={() => setViewing(v)}>
                      查看
                    </button>
                    <button className="btn btn-sm" onClick={() => rollback(v)}>
                      回滚
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => removeVersion(v)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

        </div>
      </div>

      {viewing ? (
        <div className="dialog-overlay" onClick={() => setViewing(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              版本 #{viewing.versionNumber} · {SOURCE_LABEL[viewing.source]} · {viewing.wordCount} 字
            </h3>
            <pre className="body">{viewing.content}</pre>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setViewing(null)}>
                关闭
              </button>
              <button className="btn btn-primary" onClick={() => rollback(viewing)}>
                回滚到此版
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showVersionDialog ? (
        <VersionDialog
          onClose={() => setShowVersionDialog(false)}
          onSubmit={submitVersion}
        />
      ) : null}

      {reviewOpen ? (
        <ReviewPanel
          text={reviewText}
          streaming={reviewing}
          suggestions={suggestions}
          onClose={() => setReviewOpen(false)}
          onCopy={async () => {
            await navigator.clipboard.writeText(reviewText)
          }}
        />
      ) : null}
    </div>
  )
}

function OutlineDetailField({ row }: { row: { label: string; value?: string; items?: string[] } }) {
  return (
    <section className="outline-detail-field">
      <div className="outline-detail-label">{row.label}</div>
      {row.value ? <div className="outline-detail-value">{row.value}</div> : null}
      {row.items && row.items.length > 0 ? (
        <ul className="outline-detail-list">
          {row.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function ReminderGroup({
  title,
  items,
  tone
}: {
  title: string
  items: string[]
  tone: 'hook' | 'cool' | 'emotion'
}) {
  return (
    <div className="outline-tags">
      <span className={`outline-tag ${tone}`}>{title}</span>
      {items.map((item) => (
        <span key={item} className="outline-tag">
          {item}
        </span>
      ))}
    </div>
  )
}

function ReviewPanel({
  text,
  streaming,
  suggestions,
  onClose,
  onCopy
}: {
  text: string
  streaming: boolean
  suggestions: ReviewSuggestion[]
  onClose: () => void
  onCopy: () => void | Promise<void>
}) {
  return (
    <aside className="review-panel">
      <header>
        <h3>AI 改稿建议</h3>
        <div className="btn-group">
          <button className="btn btn-sm" onClick={onCopy} disabled={!text}>
            复制
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      <div className="body-area">
        {suggestions.length === 0 && !streaming ? (
          <div className="review-empty">
            点击「✎ AI 改稿」后，建议会出现在这里。
          </div>
        ) : suggestions.length === 0 ? (
          <div className="review-empty review-streaming">审稿中…</div>
        ) : (
          <>
            {suggestions.map((s, i) => (
              <div key={i} className="review-suggestion">
                {s.quote ? <div className="quote">「{s.quote}」</div> : null}
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  建议 · {s.advice}
                </div>
                {s.why ? <div className="why">理由 · {s.why}</div> : null}
              </div>
            ))}
            {streaming ? (
              <div className="review-streaming muted" style={{ fontSize: 12 }}>
                ▍ 还在收尾…
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}

function CastSuggestionPanel({
  suggestions,
  characters,
  detecting,
  applied,
  onApply,
  onClose
}: {
  suggestions: CastSuggestion[]
  characters: Character[]
  detecting: boolean
  applied: boolean
  onApply: () => void | Promise<void>
  onClose: () => void
}) {
  const matched = suggestions.filter((s) => s.characterId)
  const unmatched = suggestions.filter((s) => !s.characterId)
  const charById = new Map<string, Character>(characters.map((c) => [c.id, c]))
  return (
    <div className="editor-panel">
      <div className="ep-head">
        <div className="ep-title">🤖 AI 识别结果</div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>
      {detecting ? (
        <p className="muted" style={{ fontSize: 13 }}>
          正在让 AI 扫描本章出场人物…
        </p>
      ) : suggestions.length === 0 ? (
        <p className="empty" style={{ padding: 8 }}>
          AI 未识别到出场人物。
        </p>
      ) : (
        <>
          {unmatched.length > 0 ? (
            <div
              style={{
                background: 'var(--warning-soft)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)',
                padding: 8,
                marginBottom: 10
              }}
            >
              <strong style={{ fontSize: 12.5, color: 'var(--warning)' }}>
                ⚠ {unmatched.length} 位未在人物库中
              </strong>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                建议先到「人物」页补建：
                {unmatched.map((s) => s.name).join('、')}
              </p>
            </div>
          ) : null}
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="meta">
              共 {suggestions.length} 人 · {matched.length} 可一键应用
              {applied ? ' · 已应用' : ''}
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={onApply}
              disabled={matched.length === 0 || matched.every((m) => m.applied)}
            >
              {matched.every((m) => m.applied) ? '已应用' : `应用 ${matched.length} 个到登场`}
            </button>
          </div>
          {suggestions.map((s, i) => (
            <div
              key={i}
              className={`cast-suggestion ${s.characterId ? 'known' : 'unknown'} ${
                s.applied ? 'applied' : ''
              }`}
            >
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="name">
                  {s.name}
                  {s.applied ? <span className="chip chip-success" style={{ marginLeft: 8 }}>已加入</span> : null}
                </span>
                <span
                  className="meta"
                  style={{ marginLeft: 'auto', fontSize: 11.5 }}
                >
                  {s.characterId
                    ? charById.get(s.characterId)?.role ?? '人物库'
                    : '未在人物库'}
                </span>
              </div>
              {s.reason ? <div className="reason">{s.reason}</div> : null}
              {s.quote ? <div className="quote">「{s.quote}」</div> : null}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function AnalysisPanel({ text }: { text: string }) {
  const stats: ChapterStats = useMemo(() => analyze(text, 12), [text])
  const warnings = useMemo(() => rhythmWarnings(stats), [stats])
  return (
    <div className="editor-panel">
      <div className="ep-head">
        <div className="ep-title">
          📊 章节分析
          <span className="count">实时</span>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat-cell">
          <div className="label">字数</div>
          <div className="val">{stats.wordCount.toLocaleString()}</div>
        </div>
        <div className="stat-cell">
          <div className="label">段落</div>
          <div className="val">{stats.paragraphCount}</div>
        </div>
        <div className="stat-cell">
          <div className="label">句数</div>
          <div className="val">{stats.sentenceCount}</div>
        </div>
        <div className="stat-cell">
          <div className="label">平均句长</div>
          <div className="val">{stats.avgSentenceLen}</div>
          <div className="sub">字/句</div>
        </div>
        <div className="stat-cell">
          <div className="label">对话占比</div>
          <div className="val">{Math.round(stats.dialogueRatio * 100)}%</div>
          <div className="sub">「」/"" 字符</div>
        </div>
        <div className="stat-cell">
          <div className="label">虚词占比</div>
          <div className="val">{Math.round(stats.fillerRatio * 100)}%</div>
          <div className="sub">的/了/着…</div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>情绪曲线</span>
          <span className="meta" style={{ fontSize: 11 }}>
            消极 ← 积极
          </span>
        </div>
        <div className="emotion-curve" title="按章分段估算的极性">
          {stats.emotionCurve.map((v, i) => {
            const maxAbs = 100
            const halfH = 32 // 上下各 32px
            const intensity = Math.min(1, Math.abs(v) / maxAbs)
            const h = Math.max(2, intensity * halfH)
            const positive = v >= 0
            return (
              <div
                key={i}
                className={`emotion-bar ${v > 5 ? 'positive' : v < -5 ? 'negative' : 'neutral'}`}
                style={{
                  height: positive ? `${h}px` : `${h}px`,
                  marginTop: positive ? `${halfH - h}px` : '32px',
                  alignSelf: positive ? 'flex-end' : 'flex-start'
                }}
              />
            )
          })}
        </div>
        <div className="emotion-axis">
          <span>开头</span>
          <span>中段</span>
          <span>结尾</span>
        </div>
      </div>
      {warnings.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {warnings.map((w, i) => (
            <span key={i} className={`warning-pill level-${w.level}`}>
              {w.level === 2 ? '⚠ ' : '· '}
              {w.msg}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function VersionDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void
  onSubmit: (source: ChapterSource, note: string) => Promise<void>
}) {
  const [source, setSource] = useState<ChapterSource>('manual')
  const [note, setNote] = useState('')
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>保存为版本</h3>
        <div className="field">
          <label>来源</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['manual', 'ai', 'reviewed'] as ChapterSource[]).map((s) => (
              <span
                key={s}
                className={`filter-chip ${source === s ? 'active' : ''}`}
                onClick={() => setSource(s)}
              >
                {SOURCE_LABEL[s]}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>备注（可留空）</label>
          <textarea
            className="textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="如：第一稿 / 重大修订 / AI 续写后润色"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => onSubmit(source, note)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function sourceChipClass(s: ChapterSource): string {
  if (s === 'ai') return 'chip-accent'
  if (s === 'reviewed') return 'chip-success'
  return ''
}
