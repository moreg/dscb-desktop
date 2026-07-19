import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type {
  AuditReport,
  ChapterContent,
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
  findRewriteTarget,
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
import type { DetailedOutlineItem, DeslopScanReport, DeslopResult } from '../../shared/types'
import { findFirstDiffWindow, listChangeHunks, summarizeTextDiff } from '../../shared/text-diff'
import { buildForeshadowingReminders, type ForeshadowingReminderItem } from './foreshadowingReminders'
import ChapterFlowPanel from './ChapterFlowPanel'
import WeeklyWritingStats, { reportSaveDelta } from './WeeklyWritingStats'
import { getOutlineDetailRows } from './outlineDetailFields'
import { parseForeshadowReceipt } from '../../shared/parsers'
import {
  summarizePostWriteSync,
  formatSyncErrorHint,
  type PostWriteSyncPhase
} from '../../shared/post-write-sync'
import {
  pushSyncHistory,
  popSyncHistory,
  peekSyncHistory,
  loadPendingSyncQueue,
  savePendingSyncQueue,
  upsertPendingSync,
  removePendingSync,
  findPendingForChapter,
  receiptHasUndoableWrites,
  makeSyncId,
  loadSyncHistory,
  saveSyncHistory,
  type SyncHistoryEntry,
  type SyncUndoReceipt
} from '../../shared/post-write-sync-session'
import AlertDialog from './AlertDialog'
import {
  DEFAULT_WRITING_REQUIREMENT_TEMPLATES,
  composeWritingRequirements,
  getWritingRequirementTemplate
} from '../../shared/writing-requirement-templates'
import type { WritingRequirementTemplate } from '../../shared/writing-requirement-templates'

interface Props {
  projectId: string
  chapterNumber: number
  onBack: () => void
  onOpenOutline?: () => void
  onOpenCharacters?: () => void
  onNavigateChapter?: (chapterNumber: number) => void
}

/**
 * LLM 错误码 -> 用户可读的中文提示。
 * 覆盖所有协议（openai/anthropic/antigravity/codex/grok）的错误码。
 */
function friendlyLlmError(err: string | undefined): string {
  if (!err) return '生成失败，请重试'
  const map: Record<string, string> = {
    LLM_NOT_CONFIGURED: '请先在「⚙ 设置 -> 模型服务」中配置 provider',
    LLM_AUTH_FAILED: 'API Key 认证失败，请检查 provider 配置',
    AGY_AUTH_EXPIRED: 'AI 服务暂时连接失败，请稍后重试',
    CODEX_AUTH_EXPIRED: 'AI 服务暂时连接失败，请稍后重试',
    GROK_AUTH_EXPIRED: 'Grok 登录态失效，请在终端运行 grok login',
    LLM_RATE_LIMIT: '请求过于频繁，请稍后再试',
    LLM_TIMEOUT: '生成超时（内容过长或网络较慢），请重试',
    LLM_ABORTED: '已取消生成',
    LLM_OUTPUT_TRUNCATED: '输出不完整，可点击重试',
    LLM_AGENT_META:
      '模型输出了写作流程说明而非小说正文，已拦截未写入。请直接再点一次「续写」重试',
    LLM_RESPONSE_TOO_LARGE: '生成内容过长，请尝试简化提示词',
    LLM_REQUEST_FAILED: '请求失败，请检查网络连接',
    NETWORK_ERROR: '网络连接失败，请检查网络',
    AGY_NOT_FOUND: '未检测到 agy CLI，请先安装 Antigravity CLI',
    AGY_SPAWN_FAILED: 'agy CLI 启动失败，请检查安装',
    CODEX_NOT_FOUND: '未检测到 codex CLI，请先安装 Codex CLI',
    CODEX_MODEL_ERROR: 'codex 模型配置有误，请检查模型名',
    GROK_NOT_FOUND: '未检测到 grok CLI，请先安装 Grok',
    GROK_SPAWN_FAILED: 'grok CLI 启动失败，请检查安装',
    // agy 内部 agent 执行失败的通用错误
    'Agent execution terminated': 'agy 执行出错（模型调用失败或超时），请检查网络连接后重试',
    'exited with code': 'agy 进程异常退出，请重试或检查 CLI 安装',
    // codex 网络错误
    'tls handshake': 'TLS 握手失败，请检查网络代理设置或 OpenAI 服务器连接',
    'stream disconnected': '连接中断，请检查网络稳定性后重试',
    'Reconnecting': '正在重连，请检查网络连接'
  }
  // 精确匹配（err 可能是 "AGY_ERROR: xxx" 形式，用 includes 匹配前缀）
  const lowerErr = err.toLowerCase()
  for (const [key, msg] of Object.entries(map)) {
    if (lowerErr.includes(key.toLowerCase())) return msg
  }
  // AGY_ERROR / CODEX_ERROR / GROK_ERROR 带具体信息
  if (err.startsWith('AGY_ERROR: ')) return `agy 执行出错：${err.slice(11).slice(0, 100)}`
  if (err.startsWith('CODEX_ERROR: ')) return `codex 执行出错：${err.slice(13).slice(0, 100)}`
  if (err.startsWith('GROK_ERROR: ')) {
    const detail = err.slice(12)
    if (/Couldn't create session|unsatisfied requirements|agent building failed/i.test(detail)) {
      return 'Grok 会话创建失败，请重启应用后重试；若仍失败请在终端运行 grok login'
    }
    return `grok 执行出错：${detail.slice(0, 120)}`
  }
  return err
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

export default function ChapterEditor({
  projectId,
  chapterNumber,
  onOpenOutline,
  onOpenCharacters,
  onBack,
  onNavigateChapter
}: Props) {
  const [data, setData] = useState<ChapterContent | null>(null)

  // 侧边栏拖拽宽度调整逻辑
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('ai-writer:editor-sidebar-width')
    if (saved) {
      const parsed = parseInt(saved, 10)
      if (!isNaN(parsed) && parsed >= 240 && parsed <= 600) {
        return parsed
      }
    }
    return 320
  })
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false)
  const dragStartRef = useRef<{ mouseX: number; width: number } | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingSidebar(true)
    dragStartRef.current = {
      mouseX: e.clientX,
      width: sidebarWidth
    }
  }

  useEffect(() => {
    if (!isDraggingSidebar) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return
      const deltaX = e.clientX - dragStartRef.current.mouseX
      let nextWidth = dragStartRef.current.width - deltaX
      if (nextWidth < 240) nextWidth = 240
      if (nextWidth > 600) nextWidth = 600
      setSidebarWidth(nextWidth)
    }

    const handleMouseUp = () => {
      setIsDraggingSidebar(false)
      dragStartRef.current = null
      localStorage.setItem('ai-writer:editor-sidebar-width', String(sidebarWidthRef.current))
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingSidebar])

  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineGutterRef = useRef<HTMLDivElement>(null)
  const lineGutterInnerRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    return localStorage.getItem('ai-writer:show-line-numbers') !== 'false'
  })
  const [lineHeights, setLineHeights] = useState<number[]>([])
  /** textarea 单行基准高度（未折行时一行的高度），用于 lineHeights 滞后时的兜底，
   *  替代写死的魔法数 32——避免字体回退/缩放导致行号与正文行高不符而错位。 */
  const [baseLineHeight, setBaseLineHeight] = useState(32)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [showCast, setShowCast] = useState(false)
  const [savingCast, setSavingCast] = useState(false)
  const [foreshadowings, setForeshadowings] = useState<Foreshadowing[]>([])
  const [locations, setLocations] = useState<MemoryEntity[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<'highlight' | 'markdown'>('highlight')
  const [chapterOutline, setChapterOutline] = useState<DetailedOutlineItem | null>(null)
  const [generatingOutline, setGeneratingOutline] = useState(false)
  const [isEditingReqs, setIsEditingReqs] = useState(false)
  const [editingReqsTemplateId, setEditingReqsTemplateId] = useState('')
  const [editingReqsCustomText, setEditingReqsCustomText] = useState('')
  const [savingReqs, setSavingReqs] = useState(false)
  const [writingRequirementTemplates, setWritingRequirementTemplates] = useState<
    WritingRequirementTemplate[]
  >(DEFAULT_WRITING_REQUIREMENT_TEMPLATES)
  const writingTemplateApi = window.api as typeof window.api & {
    getWritingRequirementTemplates?: () => Promise<WritingRequirementTemplate[]>
  }

  useEffect(() => {
    setEditingReqsTemplateId(chapterOutline?.writingRequirementTemplateId ?? '')
    setEditingReqsCustomText(
      chapterOutline?.writingRequirementCustomText ?? chapterOutline?.writingRequirements ?? ''
    )
    setIsEditingReqs(false)
  }, [chapterOutline])

  const handleSaveReqs = async () => {
    setSavingReqs(true)
    try {
      const updated = await window.api.updateDetailedOutline(projectId, chapterNumber, {
        writingRequirements: composeWritingRequirements(
          editingReqsTemplateId,
          editingReqsCustomText,
          '',
          writingRequirementTemplates
        ),
        writingRequirementTemplateId: editingReqsTemplateId,
        writingRequirementCustomText: editingReqsCustomText
      })
      setChapterOutline(updated)
      setIsEditingReqs(false)
    } catch (err) {
      console.error('Failed to save writing requirements:', err)
      alert('保存写作要求失败: ' + (err as Error).message)
    } finally {
      setSavingReqs(false)
    }
  }

  const activeRequirementTemplate = useMemo(
    () =>
      getWritingRequirementTemplate(
        chapterOutline?.writingRequirementTemplateId,
        writingRequirementTemplates
      ),
    [chapterOutline?.writingRequirementTemplateId, writingRequirementTemplates]
  )

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
  const [chapterGoal, setChapterGoal] = useState<number>(() => {
    const saved = localStorage.getItem(`ai-writer:word-target:${projectId}:${chapterNumber}`)
    return saved ? Number(saved) : 3000
  })
  const [isEditingGoal, setIsEditingGoal] = useState(false)
  const [editingGoalVal, setEditingGoalVal] = useState('3000')
  const [findBarOpen, setFindBarOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [findResults, setFindResults] = useState<number[]>([])
  const [currentResultIndex, setCurrentResultIndex] = useState(-1)
  const [sessionStartWords, setSessionStartWords] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const [reviewText, setReviewText] = useState('')
  const [showContinueDialog, setShowContinueDialog] = useState(false)
  const [showAdjustDialog, setShowAdjustDialog] = useState(false)
  const [adjustInstruction, setAdjustInstruction] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  // 正文追问（chat）：全书视野回答写作疑问，不修改正文
  const [showAskDialog, setShowAskDialog] = useState(false)
  const [askQuestion, setAskQuestion] = useState('')
  const [askMessages, setAskMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [asking, setAsking] = useState(false)
  const [deslopScanReport, setDeslopScanReport] = useState<DeslopScanReport | null>(null)
  const [deslopScanning, setDeslopScanning] = useState(false)
  const [deslopRunning, setDeslopRunning] = useState(false)
  const [deslopLog, setDeslopLog] = useState('')
  const [deslopResult, setDeslopResult] = useState<DeslopResult | null>(null)
  const [deslopDiffFull, setDeslopDiffFull] = useState(false)
  const [deslopCollapsedGates, setDeslopCollapsedGates] = useState<Set<string>>(new Set())
  const [tempContextInput, setTempContextInput] = useState('')
  const [allChapters, setAllChapters] = useState<{ chapterNumber: number; title: string }[]>([])

  // 章名命名 / 手动改名（ChapterEditor 正文区 P39）
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraftInput, setTitleDraftInput] = useState('')
  /** AI 命名候选标题（空字符串 = 未生成 / 已取消） */
  const [nameCandidate, setNameCandidate] = useState<{
    title: string
    reason: string
  } | null>(null)
  const [namingLoading, setNamingLoading] = useState(false)
  const [savingTitle, setSavingTitle] = useState(false)
  const [alertInfo, setAlertInfo] = useState<{ message: string } | null>(null)
  const [previewCard, setPreviewCard] = useState<{
    kind: 'char' | 'foreshadow' | 'location'
    text: string
    x: number
    y: number
    details: { title: string; subtitle?: string; content?: string }
  } | null>(null)
  const [flowSyncTrigger, setFlowSyncTrigger] = useState(0)
  /** 写后自动同步结果，回填流程面板避免二次 extract */
  const [autoSyncSeed, setAutoSyncSeed] = useState<{
    extraction: import('../../shared/types').MemoryExtraction
    memory: import('../../shared/types').MemoryApplyResult
    settings: import('../../shared/types').SettingsApplyResult
  } | null>(null)
  /**
   * 写后同步状态条：比 3s toast 更持久，支持失败一键补跑 / 多级撤销 / 失败队列。
   * contentForRetry 保存触发同步时的正文快照（续写/调整完成后的全文）。
   * undoDepth：会话内可撤销层数（LIFO 栈）。
   * fromPendingQueue：由 localStorage 失败队列恢复的提示。
   */
  const [postWriteSync, setPostWriteSync] = useState<{
    phase: PostWriteSyncPhase
    message: string
    errors: string[]
    contentForRetry: string
    at: number
    canUndo: boolean
    undoDepth: number
    fromPendingQueue?: boolean
    receipt: SyncUndoReceipt | null
  } | null>(null)
  const [undoSyncLoading, setUndoSyncLoading] = useState(false)
  /** 会话内同步撤销栈（仅当前编辑会话；切章清空） */
  const syncHistoryRef = useRef<SyncHistoryEntry[]>([])
  const [syncHistoryDepth, setSyncHistoryDepth] = useState(0)
  /** full 流水线触发时跳过记忆 extract */
  const [skipMemoryOnAutoSyncAll, setSkipMemoryOnAutoSyncAll] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [castSuggestions, setCastSuggestions] = useState<CastSuggestion[]>([])
  const [castApplied, setCastApplied] = useState(false)
  const [showCastPanel, setShowCastPanel] = useState(false)
  const [flowPanelOpen, setFlowPanelOpen] = useState(false)
  const [outlinePanelOpen, setOutlinePanelOpen] = useState(true) // 细纲展开/收起
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
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false)
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
  const [undoToast, setUndoToast] = useState<{ message: string; type: 'warning' | 'error' | 'info' } | null>(null)
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
  const askRef = useRef(0)

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
  const refreshWritingRequirementTemplates = () => {
    if (typeof writingTemplateApi.getWritingRequirementTemplates !== 'function') {
      setWritingRequirementTemplates(DEFAULT_WRITING_REQUIREMENT_TEMPLATES)
      return
    }
    void writingTemplateApi
      .getWritingRequirementTemplates()
      .then(setWritingRequirementTemplates)
      .catch(() => setWritingRequirementTemplates(DEFAULT_WRITING_REQUIREMENT_TEMPLATES))
  }

  const refreshChapterOutline = () => {
    void window.api.listDetailedOutline(projectId).then((items) => {
      setChapterOutline(items.find((it) => it.chapterNumber === chapterNumber) ?? null)
    })
  }

  useEffect(() => {
    ++genRef.current
    setGenerating(false)
    setAdjusting(false)
    // 切章/project 时清空内存中的改写历史（避免跨章串台）
    setRewriteHistory([])
    setRedoStack([])
    setLastSavedAt(null) // P11-A：切章时重置"上次保存"指示
    // 切章时清空追问对话历史（追问是针对本章的，跨章不再相关）
    ++askRef.current
    setAsking(false)
    setAskMessages([])
    setAskQuestion('')
    setShowAskDialog(false)
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
    void window.api.getChapterWordSummary(projectId).then((res) => {
      if (res) {
        const sorted = res.chapters.map((c) => ({ chapterNumber: c.chapterNumber, title: c.title }))
          .sort((a, b) => a.chapterNumber - b.chapterNumber)
        setAllChapters(sorted)
      }
    })
    refreshCharacters()
    refreshMemory()
    refreshChapterOutline()
    refreshProjectStyleData()
    refreshWritingRequirementTemplates()
    setStyleSelection({ mode: 'projectDefault', styleProfileId: null })
    setAutoSyncSeed(null)
    setPostWriteSync(null)
    setSkipMemoryOnAutoSyncAll(false)
    setFlowSyncTrigger(0)
    // 切章：从 localStorage 恢复撤销栈 + 失败队列
    try {
      const storage = getLocalStorage()
      const hist = loadSyncHistory(storage, projectId, chapterNumber)
      syncHistoryRef.current = hist
      setSyncHistoryDepth(hist.length)
      const pending = findPendingForChapter(
        loadPendingSyncQueue(storage),
        projectId,
        chapterNumber
      )
      if (pending?.content?.trim()) {
        setPostWriteSync({
          phase: 'failed',
          message: `有未完成的记忆同步（${new Date(pending.at).toLocaleString()} 失败，已尝试 ${pending.attempts} 次）`,
          errors: pending.errors,
          contentForRetry: pending.content,
          at: pending.at,
          canUndo: hist.length > 0,
          undoDepth: hist.length,
          fromPendingQueue: true,
          receipt: peekSyncHistory(hist)?.receipt ?? null
        })
      } else if (hist.length > 0) {
        const peek = peekSyncHistory(hist)
        setPostWriteSync({
          phase: 'ok',
          message: `已恢复 ${hist.length} 条可撤销同步（跨会话）`,
          errors: [],
          contentForRetry: draft || '',
          at: peek?.at ?? Date.now(),
          canUndo: true,
          undoDepth: hist.length,
          receipt: peek?.receipt ?? null
        })
      }
    } catch {
      syncHistoryRef.current = []
      setSyncHistoryDepth(0)
    }
  }, [projectId, chapterNumber])

  // 订阅外部文件变更：细纲/节奏图谱变 → 刷新本章 meta（标题/情绪/爽点等）。
  // 仅当用户无未保存正文输入（!dirty）时刷新，避免覆盖正在编辑的内容。
  useEffect(() => {
    const off = window.api.onProjectFilesChanged((e) => {
      if (e.projectId !== projectId) return
      if (e.kind !== 'outline' && e.kind !== 'rhythm' && e.kind !== 'progress') return
      if (dirty) return // 用户有未保存输入，跳过，保存后会重新读盘
      void window.api.getChapter(projectId, chapterNumber).then((c) => {
        setData(c)
        setDraft(c.content)
        setSessionStartWords(c.meta.wordCount)
      })
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, chapterNumber, dirty])

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

  useEffect(() => {
    const saved = localStorage.getItem(`ai-writer:word-target:${projectId}:${chapterNumber}`)
    setChapterGoal(saved ? Number(saved) : 3000)
    setIsEditingGoal(false)
  }, [projectId, chapterNumber])

  const handleSaveChapterGoal = (val: number) => {
    setChapterGoal(val)
    localStorage.setItem(`ai-writer:word-target:${projectId}:${chapterNumber}`, String(val))
  }

  // 点 popover 或预览卡片外区域关闭
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (toolbarMoreOpen) {
        if (!(target && target.closest('.toolbar-more'))) {
          setToolbarMoreOpen(false)
        }
      }
      if (previewCard) {
        if (!(target && target.closest('.preview-inline-card'))) {
          setPreviewCard(null)
        }
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [toolbarMoreOpen, previewCard])

  // P11-A：每 10 秒重渲染一次，让"X 秒前"指示器保持新鲜
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  // 行号：切换时持久化
  useEffect(() => {
    localStorage.setItem('ai-writer:show-line-numbers', String(showLineNumbers))
  }, [showLineNumbers])

  // 行号：计算每行渲染高度（用隐藏的 mirror div 精确测量自动换行后的实际行高）
  useEffect(() => {
    if (!showLineNumbers || !mirrorRef.current || !textareaRef.current) {
      setLineHeights([])
      return
    }
    const measure = () => {
      const mirror = mirrorRef.current
      const textarea = textareaRef.current
      if (!mirror || !textarea) return
      const cs = getComputedStyle(textarea)
      // 复制所有影响断行的计算样式到 mirror，让每行换行点和行数与 textarea 完全一致，
      // 否则一行长正文自动折行后行号会累积偏移。wordBreak/overflowWrap/textWrap 尤为关键。
      Object.assign(mirror.style, {
        font: cs.font,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        wordSpacing: cs.wordSpacing,
        textIndent: cs.textIndent,
        tabSize: cs.tabSize,
        textTransform: cs.textTransform,
        whiteSpace: 'pre-wrap',
        wordBreak: cs.wordBreak,
        overflowWrap: cs.overflowWrap,
        // CSS Text 4：textarea 默认会自动换行，镜像也要换行，否则中英混排断行点不一致。
        textWrap: 'wrap',
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        paddingTop: '0px',
        paddingBottom: '0px',
        width: `${textarea.clientWidth}px`,
        boxSizing: 'border-box'
      })
      const lines = draft.split('\n')
      mirror.innerHTML = ''
      for (const line of lines) {
        const div = document.createElement('div')
        div.textContent = line || '​'
        mirror.appendChild(div)
      }
      const heights: number[] = []
      for (let i = 0; i < mirror.children.length; i++) {
        heights.push((mirror.children[i] as HTMLElement).offsetHeight)
      }
      setLineHeights(heights)
      // 基准行高 = 未折行行的最小高度（折行行只会更高）。
      // 草稿为空 / 全部折行时回退到 getComputedStyle 的 line-height（已是像素值），保证兜底始终反映真实排版。
      const minH = heights.length > 0 ? Math.min(...heights) : 0
      if (minH > 0) {
        setBaseLineHeight(minH)
      } else {
        const lh = parseFloat(cs.lineHeight)
        setBaseLineHeight(Number.isFinite(lh) && lh > 0 ? lh : 32)
      }
      // 把 gutter 高度锁定为 textarea 的可视高度（单一事实源）。
      // textarea 是高度权威（max-height / resize 手柄 / 响应式都在它身上），
      // gutter 直接抄它的 clientHeight，无需在 CSS 里复制同一份高度表达式，
      // 彻底消除「两处各写一份 calc、改一处忘另一处」的耦合错位。
      const gutter = lineGutterRef.current
      if (gutter) gutter.style.height = `${textarea.clientHeight}px`
    }
    measure()
    // ResizeObserver 回调用 rAF 合并同帧内的多次触发，避免回调里改 DOM 尺寸
    // 又触发新回调，形成 "ResizeObserver loop" 警告（被全局 error 监听器升级成崩溃）。
    let rafId = 0
    const scheduleMeasure = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        measure()
      })
    }
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(textareaRef.current)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [draft, showLineNumbers])

  const handleEditorScroll = useCallback(() => {
    // 用 transform 平移行号内容层来跟随 textarea 滚动。
    // gutter 是 overflow:hidden + 固定高度，scrollTop 对它无效，必须用 translateY。
    if (lineGutterInnerRef.current && textareaRef.current) {
      lineGutterInnerRef.current.style.transform = `translateY(${-textareaRef.current.scrollTop}px)`
    }
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
      // 查找：Ctrl+F
      if (e.ctrlKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        setFindBarOpen(true)
        setTimeout(() => {
          const inp = document.getElementById('find-input') as HTMLInputElement | null
          if (inp) {
            inp.focus()
            inp.select()
          }
        }, 60)
        return
      }
      // Undo/Redo：通过纯函数判断（跨平台兼容 + 不在 textarea 内拦截）
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault()
        if (dirty && !saving) void saveAndClearDraft()
        return
      }
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
  }, [dirty, draft, rewriteHistory.length, redoStack.length, saveAndClearDraft, saving])

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

  const aiGenerate = async (tempContextVal?: string) => {
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
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
    const initialDraft = draft
    setFlowPanelOpen(false)
    setAutoAudit(null)
    setReviewText('')
    setFlowSyncTrigger(0)
    setAutoSyncSeed(null)
    setPostWriteSync(null)
    setSkipMemoryOnAutoSyncAll(false)
    // 续写会用全新正文替换整章，旧的"已应用改写"记录（含 oldSnippet/newText、
    // 用于流程面板 AI 审稿建议折叠区的 applied 标记）都对不上新正文了。
    // 必须一并清掉，否则新审稿结果的 index 会错误匹配到残留 rewriteHistory
    // 里的 applied 标记，导致"明明没点应用却显示已应用"。redoStack 是配套
    // 撤销/重做栈，一起清。
    setRewriteHistory([])
    setRedoStack([])
    const myGen = ++genRef.current
    let finalDraft = ''
    try {
      const result = await window.api.generateChapterStream(
        projectId,
        chapterNumber,
        requestedStyleProfileId,
        tempContextVal,
        initialDraft,
        (token, done) => {
          if (genRef.current !== myGen) return
          if (token) {
            finalDraft += token
            setDraft(initialDraft + finalDraft)
          }
          if (done) {
            setGenerating(false)
            refreshUsage() // P10-A：续写完成更新今日用量
            const { receipt, stripped } = parseForeshadowReceipt(finalDraft)
            if (receipt) {
              setDraft(initialDraft + stripped)
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
        // 流式过程中可能已写入错误旁白（如 agent 流程说明），失败时回滚到续写前
        setDraft(initialDraft)
        setAlertInfo({ message: friendlyLlmError(result.error) })
        return
      }
      setDirty(true)
      // 续写一完成就立刻打开流程面板，不再等质检/审稿跑完——否则会被一次完整 LLM 调用阻塞十几秒。
      // 默认 memory_only：只走 syncChapterAfterWrite，不再触发面板一键同步（避免二次 extract）。
      setFlowPanelOpen(true)
      // Phase 12 Task 2：续写完成后自动跑质检 + 自动审核。
      // 两者相互独立，并行启动（不再串行 await），各走各的失败兜底。
      void runPostGenerateAudit(myGen, finalDraft)
      // 后台自动同步记忆/设定（受 autoPostWritePipeline 控制）；失败不阻断续写成功
      {
        const { receipt, stripped } = parseForeshadowReceipt(finalDraft)
        const fullContent = initialDraft + (receipt ? stripped : finalDraft)
        void runPostGenerateMemorySync(myGen, fullContent)
      }
    } catch {
      if (genRef.current === myGen) {
        setGenerating(false)
        setDraft(initialDraft)
      }
    }
  }

  const adjustChapter = async () => {
    const instruction = adjustInstruction.trim()
    if (!draft.trim()) {
      setAlertInfo({ message: '正文为空，无法追问调整' })
      return
    }
    if (!instruction) {
      setAlertInfo({ message: '请先写下这次要怎么调整正文' })
      return
    }
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
      return
    }
    if (usage && shouldBlockAiGenerate(usage.month.cost, costAlertConfig)) {
      const proceed = window.confirm(
        `本月 AI 费用已达 ${formatCost(usage.month.cost)}，超过预警线 ${formatCost(costAlertConfig.exceeded)}。\n\n确认继续追问调整？\n\n（提示：可在 设置 → 用量与费用 关闭"exceeded 时弹确认"）`
      )
      if (!proceed) return
    }

    setShowAdjustDialog(false)
    setAdjusting(true)
    setFlowPanelOpen(false)
    setAutoAudit(null)
    setReviewText('')
    setFlowSyncTrigger(0)
    setAutoSyncSeed(null)
    setPostWriteSync(null)
    setSkipMemoryOnAutoSyncAll(false)
    setRewriteHistory([])
    setRedoStack([])

    const sourceDraft = draft
    const myGen = ++genRef.current
    let revised = ''
    try {
      const result = await window.api.adjustChapterStream(
        projectId,
        chapterNumber,
        sourceDraft,
        instruction,
        requestedStyleProfileId,
        (token, done) => {
          if (genRef.current !== myGen) return
          if (token) {
            revised += token
            setDraft(revised)
          }
          if (done) {
            setAdjusting(false)
            refreshUsage()
          }
        }
      )
      if (genRef.current !== myGen) return
      if (!result.ok) {
        setAdjusting(false)
        setAlertInfo({ message: friendlyLlmError(result.error) })
        setDraft(sourceDraft)
        return
      }
      setDirty(true)
      setFlowPanelOpen(true)
      void runPostGenerateAudit(myGen, revised)
      // 追问调整会改写正文：与续写一致做记忆/设定同步（受 pipeline 控制）
      void runPostGenerateMemorySync(myGen, revised)
    } catch {
      if (genRef.current === myGen) {
        setAdjusting(false)
        setDraft(sourceDraft)
      }
    }
  }

  /**
   * 正文追问：把用户问题连同历史一起发给后端（全书视野），流式追加到最新一条 assistant 消息。
   * 不修改正文。失败时回滚刚压入的用户消息并提示错误。
   */
  const submitAskQuestion = async () => {
    const question = askQuestion.trim()
    if (!question) return
    if (!draft.trim()) {
      setAlertInfo({ message: '正文为空，无法追问' })
      return
    }
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 -> 模型服务」中配置 provider' })
      return
    }
    if (usage && shouldBlockAiGenerate(usage.month.cost, costAlertConfig)) {
      const proceed = window.confirm(
        `本月 AI 费用已达 ${formatCost(usage.month.cost)}，超过预警线 ${formatCost(costAlertConfig.exceeded)}。\n\n确认继续追问？\n\n（提示：可在 设置 -> 用量与费用 关闭"exceeded 时弹确认"）`
      )
      if (!proceed) return
    }

    // 压入本轮用户消息 + 占位 assistant 消息；history 不含本轮
    const userMsg = { role: 'user' as const, text: question }
    const prevMessages = askMessages
    // history 裁剪：IPC 层 zod 限制单条 text ≤ 20000、数组 ≤ 40。
    // 多轮后 assistant 长回答会累积膨胀，超限会校验失败且回滚后仍含超长消息（死循环）。
    // 这里对超长单条做尾部截断（保留结论），并只取最近 20 条，保证不超限。
    const HISTORY_TEXT_LIMIT = 18_000
    const HISTORY_MAX_TURNS = 20
    const historyForApi = prevMessages
      .slice(-HISTORY_MAX_TURNS)
      .map((m) => ({
        role: m.role,
        text:
          m.text.length > HISTORY_TEXT_LIMIT
            ? m.text.slice(0, HISTORY_TEXT_LIMIT) + '\n…（前文已截断）'
            : m.text
      }))
    setAskMessages((m) => [...m, userMsg, { role: 'assistant', text: '' }])
    setAskQuestion('')
    setAsking(true)

    const myAsk = ++askRef.current
    let assistantText = ''
    try {
      const result = await window.api.answerChapterQuestionStream(
        projectId,
        chapterNumber,
        draft,
        question,
        historyForApi,
        (token, done) => {
          if (askRef.current !== myAsk) return
          if (token) {
            assistantText += token
            setAskMessages((m) => {
              // 替换最后一条 assistant 占位
              const next = m.slice()
              next[next.length - 1] = { role: 'assistant', text: assistantText }
              return next
            })
          }
          if (done) {
            setAsking(false)
            refreshUsage()
          }
        }
      )
      if (askRef.current !== myAsk) return
      if (!result.ok) {
        setAsking(false)
        setAlertInfo({ message: friendlyLlmError(result.error) })
        // 移除本轮占位（用户消息 + 空 assistant）
        setAskMessages((m) => m.slice(0, prevMessages.length))
      }
    } catch (err) {
      if (askRef.current === myAsk) {
        setAsking(false)
        setAlertInfo({ message: friendlyLlmError((err as Error).message) })
        setAskMessages((m) => m.slice(0, prevMessages.length))
      }
    }
  }

  /** 续写后的自动质检：失败静默，不阻断；中途切走则丢弃结果。 */
  const runPostGenerateAudit = async (myGen: number, finalDraft: string) => {
    try {
      const report = await window.api.auditChapter(projectId, finalDraft)
      if (genRef.current !== myGen) return
      setAutoAudit(report)
    } catch {
      // 质检失败不阻断
    }
  }

  /** 写后同步失败时自动重试次数（不含首次）；手动「重新同步」不计入 */
  const POST_WRITE_SYNC_AUTO_RETRIES = 2
  const POST_WRITE_SYNC_RETRY_DELAY_MS = 1500

  const persistHistoryStack = (stack: SyncHistoryEntry[]) => {
    try {
      saveSyncHistory(getLocalStorage(), projectId, chapterNumber, stack)
    } catch (err) {
      console.warn('[persistHistoryStack]', err)
    }
  }

  const persistFailedSync = (
    contentSnapshot: string,
    errors: string[],
    attempts: number
  ) => {
    try {
      const storage = getLocalStorage()
      const q = loadPendingSyncQueue(storage)
      const next = upsertPendingSync(q, {
        id: makeSyncId('pend'),
        projectId,
        chapterNumber,
        content: contentSnapshot,
        errors,
        at: Date.now(),
        attempts
      })
      savePendingSyncQueue(storage, next)
      // 异步补全书名，设置页列表更易读
      void window.api.listProjects().then((list) => {
        const name = list?.find((p) => p.id === projectId)?.name
        if (!name) return
        try {
          const cur = loadPendingSyncQueue(getLocalStorage())
          const hit = findPendingForChapter(cur, projectId, chapterNumber)
          if (!hit) return
          savePendingSyncQueue(
            getLocalStorage(),
            upsertPendingSync(cur, { ...hit, projectName: name })
          )
        } catch {
          /* ignore */
        }
      })
    } catch (err) {
      console.warn('[persistFailedSync]', err)
    }
  }

  const clearFailedSyncForChapter = () => {
    try {
      const storage = getLocalStorage()
      const next = removePendingSync(loadPendingSyncQueue(storage), {
        projectId,
        chapterNumber
      })
      savePendingSyncQueue(storage, next)
    } catch (err) {
      console.warn('[clearFailedSyncForChapter]', err)
    }
  }

  /**
   * 续写/调整成功后后台同步记忆/设定。
   * 失败：自动重试 → 写入 localStorage 失败队列（跨重启可补跑）。
   * 成功有写入：压入会话撤销栈（多级撤销）。
   */
  const runPostGenerateMemorySync = async (
    myGen: number,
    fullContent: string,
    opts?: {
      force?: boolean
      pipelineHint?: 'off' | 'memory_only' | 'full'
      attempt?: number
      autoRetry?: boolean
    }
  ) => {
    const contentSnapshot = fullContent
    const attempt = opts?.attempt ?? 0
    const allowAutoRetry = opts?.autoRetry !== false
    try {
      const api = window.api as {
        getAutoPostWritePipeline?: () => Promise<'off' | 'memory_only' | 'full'>
        getAutoMemorySync?: () => Promise<boolean>
        syncChapterAfterWrite?: (
          projectId: string,
          chapterNumber: number,
          content: string,
          syncOpts?: { force?: boolean }
        ) => Promise<{
          memory: import('../../shared/types').MemoryApplyResult
          settings: import('../../shared/types').SettingsApplyResult
          extraction: import('../../shared/types').MemoryExtraction
        } | null>
      }
      if (!api.syncChapterAfterWrite) return

      let pipeline: 'off' | 'memory_only' | 'full' =
        opts?.pipelineHint ?? 'memory_only'
      if (opts?.pipelineHint == null) {
        if (api.getAutoPostWritePipeline) {
          pipeline = await api.getAutoPostWritePipeline()
        } else if (api.getAutoMemorySync) {
          pipeline = (await api.getAutoMemorySync()) ? 'memory_only' : 'off'
        }
      }
      if (pipeline === 'off' && !opts?.force) {
        setPostWriteSync(null)
        return
      }
      if (genRef.current !== myGen) return

      const syncingMsg =
        attempt > 0
          ? `同步失败，正在自动重试（${attempt}/${POST_WRITE_SYNC_AUTO_RETRIES}）…`
          : '正在同步记忆与设定…'
      setPostWriteSync({
        phase: 'syncing',
        message: syncingMsg,
        errors: [],
        contentForRetry: contentSnapshot,
        at: Date.now(),
        canUndo: syncHistoryRef.current.length > 0,
        undoDepth: syncHistoryRef.current.length,
        receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
      })
      setUndoToast({
        message: attempt > 0 ? syncingMsg : '正在同步记忆…',
        type: 'info'
      })

      const sync = await api.syncChapterAfterWrite(
        projectId,
        chapterNumber,
        contentSnapshot,
        opts?.force ? { force: true } : undefined
      )
      if (genRef.current !== myGen) return
      if (sync === null) {
        setUndoToast(null)
        setPostWriteSync({
          phase: 'skipped',
          message: '已跳过自动同步（设置中已关闭）',
          errors: [],
          contentForRetry: contentSnapshot,
          at: Date.now(),
          canUndo: syncHistoryRef.current.length > 0,
          undoDepth: syncHistoryRef.current.length,
          receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
        })
        return
      }

      setAutoSyncSeed({
        extraction: sync.extraction,
        memory: sync.memory,
        settings: sync.settings
      })

      const summary = summarizePostWriteSync(sync)
      const phase: PostWriteSyncPhase = summary.phase

      if (
        phase === 'failed' &&
        allowAutoRetry &&
        attempt < POST_WRITE_SYNC_AUTO_RETRIES
      ) {
        setPostWriteSync({
          phase: 'syncing',
          message: `同步失败，${POST_WRITE_SYNC_RETRY_DELAY_MS / 1000}s 后重试（${attempt + 1}/${POST_WRITE_SYNC_AUTO_RETRIES}）…`,
          errors: summary.errors,
          contentForRetry: contentSnapshot,
          at: Date.now(),
          canUndo: syncHistoryRef.current.length > 0,
          undoDepth: syncHistoryRef.current.length,
          receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
        })
        await new Promise((r) => setTimeout(r, POST_WRITE_SYNC_RETRY_DELAY_MS))
        if (genRef.current !== myGen) return
        await runPostGenerateMemorySync(myGen, contentSnapshot, {
          force: opts?.force,
          pipelineHint: pipeline,
          attempt: attempt + 1,
          autoRetry: true
        })
        return
      }

      let message = summary.message
      if (pipeline === 'full' && phase === 'ok') {
        message = `${summary.message}；正在跑细纲/节奏/图解…`
      }
      if (phase === 'failed' && attempt > 0) {
        message = `${summary.message}（已自动重试 ${attempt} 次）`
      }

      const receipt: SyncUndoReceipt = {
        extraction: sync.extraction,
        memory: sync.memory,
        settings: sync.settings
      }
      const undoable =
        receiptHasUndoableWrites(receipt) &&
        (phase === 'ok' || phase === 'partial')

      if (phase === 'failed') {
        persistFailedSync(contentSnapshot, summary.errors, attempt + 1)
        message = `${message}；已加入待同步队列，关闭应用后仍可补跑`
      } else {
        clearFailedSyncForChapter()
        if (undoable) {
          syncHistoryRef.current = pushSyncHistory(syncHistoryRef.current, {
            id: makeSyncId('hist'),
            projectId,
            chapterNumber,
            at: Date.now(),
            message: summary.message,
            receipt
          })
          setSyncHistoryDepth(syncHistoryRef.current.length)
          persistHistoryStack(syncHistoryRef.current)
        }
      }

      const depth = syncHistoryRef.current.length
      setPostWriteSync({
        phase,
        message:
          undoable && depth > 1
            ? `${message}（可撤销 ${depth} 次）`
            : message,
        errors: summary.errors,
        contentForRetry: contentSnapshot,
        at: Date.now(),
        canUndo: depth > 0,
        undoDepth: depth,
        receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
      })

      if (pipeline === 'full' && !opts?.force && phase !== 'failed') {
        setSkipMemoryOnAutoSyncAll(true)
        setFlowSyncTrigger((t) => t + 1)
      }

      if (phase === 'failed') {
        setUndoToast({
          message: '记忆同步失败，已入队；可点「重新同步」补跑',
          type: 'warning'
        })
      } else if (phase === 'partial') {
        setUndoToast({
          message: `${summary.message}（不影响续写）`,
          type: 'warning'
        })
      } else {
        setUndoToast({
          message:
            pipeline === 'full' && !opts?.force
              ? '已同步记忆，正在跑细纲/节奏/图解…'
              : summary.message,
          type: 'info'
        })
      }
    } catch (err) {
      console.warn('[runPostGenerateMemorySync]', err)
      if (genRef.current !== myGen) return
      const msg = err instanceof Error ? err.message : String(err)
      if (allowAutoRetry && attempt < POST_WRITE_SYNC_AUTO_RETRIES) {
        setPostWriteSync({
          phase: 'syncing',
          message: `同步异常，${POST_WRITE_SYNC_RETRY_DELAY_MS / 1000}s 后重试（${attempt + 1}/${POST_WRITE_SYNC_AUTO_RETRIES}）…`,
          errors: [msg],
          contentForRetry: contentSnapshot,
          at: Date.now(),
          canUndo: syncHistoryRef.current.length > 0,
          undoDepth: syncHistoryRef.current.length,
          receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
        })
        await new Promise((r) => setTimeout(r, POST_WRITE_SYNC_RETRY_DELAY_MS))
        if (genRef.current !== myGen) return
        await runPostGenerateMemorySync(myGen, contentSnapshot, {
          force: opts?.force,
          pipelineHint: opts?.pipelineHint,
          attempt: attempt + 1,
          autoRetry: true
        })
        return
      }
      persistFailedSync(contentSnapshot, [msg], attempt + 1)
      setPostWriteSync({
        phase: 'failed',
        message: `同步失败：${msg.slice(0, 80)}${attempt > 0 ? `（已重试 ${attempt} 次）` : ''}；已加入待同步队列`,
        errors: [msg],
        contentForRetry: contentSnapshot,
        at: Date.now(),
        canUndo: syncHistoryRef.current.length > 0,
        undoDepth: syncHistoryRef.current.length,
        fromPendingQueue: true,
        receipt: peekSyncHistory(syncHistoryRef.current)?.receipt ?? null
      })
      setUndoToast({
        message: '记忆同步失败，已入队；可点「重新同步」补跑',
        type: 'warning'
      })
    }
  }

  /** 状态条 / 流程面板：对上次正文快照（或失败队列）重新跑同步 */
  const retryPostWriteSync = () => {
    const snapshot = postWriteSync?.contentForRetry?.trim()
      ? postWriteSync.contentForRetry
      : draft
    if (!snapshot.trim()) {
      setUndoToast({ message: '正文为空，无法同步', type: 'warning' })
      return
    }
    const myGen = genRef.current
    setFlowPanelOpen(true)
    void runPostGenerateMemorySync(myGen, snapshot, {
      force: true,
      attempt: 0,
      autoRetry: true
    })
  }

  /** 忽略失败队列中本章条目（不删除正文） */
  const dismissPendingSync = () => {
    clearFailedSyncForChapter()
    setPostWriteSync((prev) =>
      prev?.fromPendingQueue || prev?.phase === 'failed'
        ? null
        : prev
    )
    setUndoToast({ message: '已忽略待同步项', type: 'info' })
  }

  /** 撤销最近一次写后自动同步（支持多级，LIFO） */
  const undoLastPostWriteSync = async () => {
    const { next, popped } = popSyncHistory(syncHistoryRef.current)
    if (!popped) {
      setUndoToast({ message: '当前没有可撤销的同步', type: 'warning' })
      return
    }
    const api = window.api as {
      undoChapterSync?: (
        projectId: string,
        payload: SyncUndoReceipt
      ) => Promise<{ ok: boolean; message: string }>
    }
    if (!api.undoChapterSync) {
      setUndoToast({ message: '当前版本不支持撤销同步', type: 'warning' })
      return
    }
    setUndoSyncLoading(true)
    try {
      const res = await api.undoChapterSync(projectId, popped.receipt)
      syncHistoryRef.current = next
      setSyncHistoryDepth(next.length)
      persistHistoryStack(next)
      const peek = peekSyncHistory(next)
      const remain = next.length
      const msg =
        remain > 0
          ? `${res.message}；还可撤销 ${remain} 次`
          : res.message
      setPostWriteSync({
        phase: res.ok ? 'skipped' : 'partial',
        message: msg,
        errors: res.ok ? [] : [res.message],
        contentForRetry: postWriteSync?.contentForRetry ?? draft,
        at: Date.now(),
        canUndo: remain > 0,
        undoDepth: remain,
        receipt: peek?.receipt ?? null
      })
      if (peek) {
        setAutoSyncSeed({
          extraction: peek.receipt.extraction,
          memory: peek.receipt.memory,
          settings: peek.receipt.settings
        })
      } else {
        setAutoSyncSeed(null)
      }
      setUndoToast({
        message: msg,
        type: res.ok ? 'info' : 'warning'
      })
    } catch (err) {
      // 撤销失败：把弹出的记录压回栈
      syncHistoryRef.current = pushSyncHistory(next, popped)
      setSyncHistoryDepth(syncHistoryRef.current.length)
      persistHistoryStack(syncHistoryRef.current)
      const msg = err instanceof Error ? err.message : String(err)
      setUndoToast({ message: `撤销失败：${msg}`, type: 'error' })
    } finally {
      setUndoSyncLoading(false)
    }
  }

  /** 扫描报告按 Gate 分组（A-G），每组内取前 20 条 */
  const deslopFindingsByGate = useMemo(() => {
    if (!deslopScanReport) return null
    const groups: Record<string, typeof deslopScanReport.findings> = {}
    for (const f of deslopScanReport.findings) {
      const list = groups[f.gate] ?? []
      list.push(f)
      groups[f.gate] = list
    }
    const ordered: { gate: string; items: typeof deslopScanReport.findings }[] = []
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      if (groups[g]?.length) ordered.push({ gate: g, items: groups[g] })
    }
    return ordered
  }, [deslopScanReport])

  /** 去 AI 味结果：改动块 + 首差异窗口 + 明细（LLM 漏写时前端再 diff 一次） */
  const deslopDiffView = useMemo(() => {
    if (!deslopResult) return null
    const before = draft
    const after = deslopResult.rewritten
    const window = findFirstDiffWindow(before, after, 600)
    const hunks = listChangeHunks(before, after, 20)
    const summary =
      deslopResult.changeSummary.length > 0
        ? deslopResult.changeSummary
        : summarizeTextDiff(before, after)
    return {
      window,
      hunks,
      summary,
      identical: before === after
    }
  }, [deslopResult, draft])

  /** 去 AI 味：扫描（确定性，不调 LLM）→ 弹报告 */
  const startDeslopScan = async (): Promise<void> => {
    if (!draft.trim()) {
      setAlertInfo({ message: '正文为空，无法扫描' })
      return
    }
    setDeslopScanning(true)
    setDeslopResult(null)
    setDeslopLog('')
    try {
      const report = await window.api.deslopScan(projectId, draft)
      setDeslopScanReport(report)
    } finally {
      setDeslopScanning(false)
    }
  }

  /** 去 AI 味：润色（流式），完成后存结果供 diff 预览 */
  const runDeslop = async (levelOverride?: 'mild' | 'moderate' | 'severe'): Promise<void> => {
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
      return
    }
    setDeslopRunning(true)
    setDeslopLog('')
    setDeslopResult(null)
    try {
      const result = await window.api.deslopStream(projectId, draft, levelOverride, (token, done) => {
        if (token) setDeslopLog((l) => l + token)
        if (done) setDeslopRunning(false)
      })
      setDeslopResult(result)
    } catch (err) {
      setAlertInfo({ message: `去 AI 味失败：${friendlyLlmError((err as Error).message)}` })
    } finally {
      setDeslopRunning(false)
    }
  }

  /** 应用去 AI 味结果到正文 */
  const applyDeslopResult = (): void => {
    if (!deslopResult) return
    setDraft(deslopResult.rewritten)
    setDeslopResult(null)
    setDeslopScanReport(null)
    setDeslopLog('')
  }

  const startDetectCast = async () => {
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
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
        setAlertInfo({ message: friendlyLlmError(result.error) })
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

  // 请求系统通知权限
  useEffect(() => {
    if (pomoRunning && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [pomoRunning])

  // 合成清脆的声音通知（双音符 chime）
  const playPomoChime = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const playNote = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start)
        gain.gain.setValueAtTime(0.25, ctx.currentTime + start)
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + duration)
        osc.start(ctx.currentTime + start)
        osc.stop(ctx.currentTime + start + duration)
      }
      playNote(523.25, 0, 0.3)
      playNote(659.25, 0.15, 0.4)
    } catch (err) {
      console.warn('Failed to play synthesized tomato chime:', err)
    }
  }

  const triggerPomoNotification = (message: string) => {
    playPomoChime()
    if (Notification.permission === 'granted') {
      new Notification('🍅 番茄钟提示', {
        body: message,
        silent: true
      })
    }
  }

  // 番茄钟计时
  useEffect(() => {
    if (!pomoRunning) return
    const id = setInterval(() => {
      setPomoSecs((s) => {
        if (s > 1) return s - 1
        setPomoRunning(false)
        if (pomoMode === 'focus') {
          setPomoSessions((n) => n + 1)
          setPomoMode('break')
          triggerPomoNotification('恭喜！一个专注番茄钟已完成。开始休息一下吧！')
          return pomoBreak * 60
        } else {
          setPomoMode('focus')
          triggerPomoNotification('休息结束，是时候展开新一轮专注了！')
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
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
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

  const onPreviewClick = (kind: 'char' | 'foreshadow' | 'location', text: string, e: React.MouseEvent) => {
    e.stopPropagation()
    let details: { title: string; subtitle?: string; content?: string } | null = null
    if (kind === 'char') {
      const c = characters.find((x) => x.name === text)
      if (c) {
        details = {
          title: `人物 · ${c.name}`,
          subtitle: c.identity ? `身份: ${c.identity}` : undefined,
          content: c.personality ? `性格: ${c.personality}` : undefined
        }
      }
    } else if (kind === 'foreshadow') {
      const f = foreshadowings.find((x) => x.content === text)
      if (f) {
        details = {
          title: `伏笔 · ${f.content}`,
          subtitle: `状态: ${f.status === 'planted' ? '已埋设' : f.status === 'pending' ? '未埋设' : '已回收'}`
        }
      }
    } else if (kind === 'location') {
      const l = locations.find((x) => x.name === text)
      if (l) {
        details = {
          title: `地点 · ${l.name}`,
          subtitle: l.category ? `分类: ${l.category}` : undefined
        }
      }
    }
    if (details) {
      setPreviewCard({
        kind,
        text,
        x: e.clientX,
        y: e.clientY,
        details
      })
    }
  }

  /** 流程面板卡片点击后聚焦正文中对应 quote：传给 ChapterFlowPanel.onFocusQuote */
  const focusQuoteInEditor = (quote: string) => {
    if (!quote || !textareaRef.current) return
    const pos = draft.indexOf(quote)
    if (pos === -1) return
    const el = textareaRef.current
    el.focus()
    el.setSelectionRange(pos, pos + quote.length)
    const row = draft.slice(0, pos).split('\n').length
    const lineHeight = 32
    el.scrollTop = Math.max(0, (row - 5) * lineHeight)
  }

  const highlightMatch = (start: number, length: number) => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(start, start + length)
    const row = draft.slice(0, start).split('\n').length
    const lineHeight = 32
    el.scrollTop = Math.max(0, (row - 5) * lineHeight)
  }

  const jumpToOffset = (offset: number) => {
    const safeOffset = Math.max(0, Math.min(offset, draft.length))
    highlightMatch(safeOffset, 1)
  }

  const handleCopyDraft = async () => {
    if (!draft.trim()) {
      setUndoToast({ message: '正文为空，暂无可复制内容', type: 'warning' })
      return
    }
    try {
      await navigator.clipboard.writeText(draft)
      setUndoToast({ message: '已复制正文到剪贴板', type: 'info' })
    } catch {
      setUndoToast({ message: '复制失败，请稍后重试', type: 'error' })
    }
  }

  const handleFind = (searchText: string) => {
    setFindText(searchText)
    if (!searchText) {
      setFindResults([])
      setCurrentResultIndex(-1)
      return
    }
    const results: number[] = []
    let idx = 0
    const lowerDraft = draft.toLowerCase()
    const lowerSearch = searchText.toLowerCase()
    while ((idx = lowerDraft.indexOf(lowerSearch, idx)) >= 0) {
      results.push(idx)
      idx += searchText.length
    }
    setFindResults(results)
    const firstIndex = results.length > 0 ? 0 : -1
    setCurrentResultIndex(firstIndex)
    if (results.length > 0) {
      highlightMatch(results[0], searchText.length)
    }
  }

  const handleFindNext = () => {
    if (findResults.length === 0) return
    const nextIdx = (currentResultIndex + 1) % findResults.length
    setCurrentResultIndex(nextIdx)
    highlightMatch(findResults[nextIdx], findText.length)
  }

  const handleFindPrev = () => {
    if (findResults.length === 0) return
    const prevIdx = (currentResultIndex - 1 + findResults.length) % findResults.length
    setCurrentResultIndex(prevIdx)
    highlightMatch(findResults[prevIdx], findText.length)
  }

  const handleReplace = () => {
    if (currentResultIndex === -1 || findResults.length === 0) return
    const start = findResults[currentResultIndex]
    const nextDraft = draft.slice(0, start) + replaceText + draft.slice(start + findText.length)
    setDraft(nextDraft)
    setDirty(true)
    const results: number[] = []
    let idx = 0
    const lowerDraft = nextDraft.toLowerCase()
    const lowerSearch = findText.toLowerCase()
    while ((idx = lowerDraft.indexOf(lowerSearch, idx)) >= 0) {
      results.push(idx)
      idx += findText.length
    }
    setFindResults(results)
    if (results.length > 0) {
      const nextIdx = currentResultIndex % results.length
      setCurrentResultIndex(nextIdx)
      setTimeout(() => highlightMatch(results[nextIdx], findText.length), 0)
    } else {
      setCurrentResultIndex(-1)
    }
  }

  const handleReplaceAll = () => {
    if (!findText) return
    const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'gi')
    const matchesCount = (draft.match(regex) ?? []).length
    if (matchesCount === 0) return
    const nextDraft = draft.replace(regex, () => replaceText)
    setDraft(nextDraft)
    setDirty(true)
    setFindResults([])
    setCurrentResultIndex(-1)
    setUndoToast({ message: `已成功替换 ${matchesCount} 处匹配项`, type: 'info' })
  }
  const foreshadowingReminders = useMemo(
    () => buildForeshadowingReminders(chapterNumber, chapterOutline, foreshadowings),
    [chapterNumber, chapterOutline, foreshadowings]
  )

  const dismissedReminderKey = `ai-writer:dismissed-foreshadow:${projectId}:${chapterNumber}`
  // ref 始终指向当前章节的 localStorage key，供写入 effect 使用而不把它纳入依赖
  // （避免章节切换时把上一章的忽略集合误写入本章 key）。
  const dismissedKeyRef = useRef(dismissedReminderKey)
  dismissedKeyRef.current = dismissedReminderKey
  const [dismissedReminders, setDismissedReminders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(dismissedReminderKey)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  // 章节切换（chapterNumber 变化但组件未重挂载）时，重新加载本章的忽略集合，
  // 避免上一章的忽略状态串入本章。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(dismissedReminderKey)
      setDismissedReminders(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch {
      setDismissedReminders(new Set())
    }
  }, [dismissedReminderKey])
  // 持久化：仅当忽略集合变化时写入当前章节 key（不依赖 key，防止跨章串写）
  useEffect(() => {
    try {
      localStorage.setItem(dismissedKeyRef.current, JSON.stringify([...dismissedReminders]))
    } catch {
      /* ignore quota errors */
    }
  }, [dismissedReminders])

  const dismissReminder = useCallback(
    (kind: 'plant' | 'reinforce' | 'collect', content: string) => {
      setDismissedReminders((prev) => {
        const next = new Set(prev)
        next.add(`${kind}:${content.trim()}`)
        return next
      })
    },
    []
  )

  const isDismissed = useCallback(
    (kind: 'plant' | 'reinforce' | 'collect', content: string) =>
      dismissedReminders.has(`${kind}:${content.trim()}`),
    [dismissedReminders]
  )

  const visiblePlant = useMemo(
    () => foreshadowingReminders.plant.filter((it) => !isDismissed('plant', it.content)),
    [foreshadowingReminders.plant, isDismissed]
  )
  const visibleReinforce = useMemo(
    () => foreshadowingReminders.reinforce.filter((it) => !isDismissed('reinforce', it.content)),
    [foreshadowingReminders.reinforce, isDismissed]
  )
  const visibleCollect = useMemo(
    () => foreshadowingReminders.collect.filter((it) => !isDismissed('collect', it.content)),
    [foreshadowingReminders.collect, isDismissed]
  )
  const foreshadowingReminderCount =
    visiblePlant.length + visibleReinforce.length + visibleCollect.length

  /**
   * 章名手动改名 / AI 起名（ChapterEditor 正文区）
   * - 手动：进入编辑态后，Enter 提交（标题空白时拒绝），Esc 取消。
   *   提交走 window.api.updateChapterMeta({ title }) → 持久化（rhythm + 大纲 + 细纲）。
   * - AI：基于当前未保存的 draft（编辑器里的内容）调 chapters:suggestName，
   *   候选标题展示在输入框下方，由用户确认（替换 input 内容）→ 再走手动改名流程。
   *   取消候选 / 切换候选 / 重新编辑都会清掉候选状态。
   * - 保存成功后：刷新 data.meta.title、allChapters 中对应章的 title（章节导航同步）。
   */
  const startTitleEdit = () => {
    if (!data) return
    setTitleDraftInput(data.meta.title)
    setNameCandidate(null)
    setTitleEditing(true)
  }
  const cancelTitleEdit = () => {
    setTitleEditing(false)
    setTitleDraftInput('')
    setNameCandidate(null)
  }
  const submitTitleEdit = async () => {
    if (!data) return
    const trimmed = titleDraftInput.trim()
    if (!trimmed) {
      setAlertInfo({ message: '章名不能为空' })
      return
    }
    if (trimmed === data.meta.title) {
      // 无变更：仅退出编辑态
      setTitleEditing(false)
      setTitleDraftInput('')
      setNameCandidate(null)
      return
    }
    setSavingTitle(true)
    try {
      const meta = await window.api.updateChapterMeta(projectId, data.meta.chapterNumber, {
        title: trimmed
      })
      // 1) 更新当前章节 meta（标题 + 其他字段）
      setData({ ...data, meta })
      // 2) 同步章节导航列表中该章的标题
      setAllChapters((prev) =>
        prev.map((c) =>
          c.chapterNumber === meta.chapterNumber ? { ...c, title: meta.title } : c
        )
      )
      // 3) 退出编辑态
      setTitleEditing(false)
      setTitleDraftInput('')
      setNameCandidate(null)
    } catch (err) {
      setAlertInfo({ message: `保存章名失败：${(err as Error)?.message || err}` })
    } finally {
      setSavingTitle(false)
    }
  }
  const onTitleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submitTitleEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelTitleEdit()
    }
  }
  const requestAiName = async () => {
    if (!data) return
    if (!(await window.api.hasLlmKey())) {
      setAlertInfo({ message: '请先在「⚙ 设置 → 模型服务」中配置 provider' })
      return
    }
    setNamingLoading(true)
    try {
      const res = await window.api.suggestChapterName(
        projectId,
        data.meta.chapterNumber,
        data.meta.title,
        draft,
        projectData?.genre
      )
      if (!res.ok) {
        setAlertInfo({
          message: `AI 起名失败：${friendlyLlmError(res.error || '未知错误')}`
        })
        return
      }
      // 不直接覆盖 input：让用户在 input 里看到候选，按 Enter 才会持久化
      setNameCandidate({ title: res.title, reason: res.reason })
      setTitleDraftInput(res.title)
      if (!titleEditing) setTitleEditing(true)
    } finally {
      setNamingLoading(false)
    }
  }
  const acceptCandidate = () => {
    // 候选标题已填到 input 框，按 Enter 触发保存（不直接写盘）
    if (titleDraftInput.trim()) {
      void submitTitleEdit()
    }
  }
  const rejectCandidate = () => {
    setNameCandidate(null)
  }

  if (!data) return <p className="empty">展卷中…</p>

  const STATUS_FULL: Record<ChapterStatus, string> = {
    outline: '待写',
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
    <div className="chapter-editor-shell">
      <div className="page-head">
        <div className="page-head-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={onBack} title="返回章节列表" style={{ marginRight: 6 }}>
              ← 返回
            </button>
            {(() => {
              const idx = allChapters.findIndex((c) => c.chapterNumber === chapterNumber)
              return (
                allChapters.length > 0 && onNavigateChapter && (
                  <div className="btn-group" style={{ marginRight: 12 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        if (idx > 0) onNavigateChapter(allChapters[idx - 1].chapterNumber)
                      }}
                      disabled={idx <= 0}
                    >
                      上一章
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        if (idx !== -1 && idx < allChapters.length - 1) {
                          onNavigateChapter(allChapters[idx + 1].chapterNumber)
                        }
                      }}
                      disabled={idx === -1 || idx >= allChapters.length - 1}
                    >
                      下一章
                    </button>
                  </div>
                )
              )
            })()}
            <div className="editor-title-wrap">
              {titleEditing ? (
                <div className="editor-title-edit">
                  <span className="editor-title-prefix">第 {data.meta.chapterNumber} 章 ·</span>
                  <input
                    autoFocus
                    className="editor-title-input"
                    type="text"
                    value={titleDraftInput}
                    onChange={(e) => setTitleDraftInput(e.target.value)}
                    onKeyDown={onTitleInputKey}
                    disabled={savingTitle}
                    placeholder="给本章起个名字…"
                    maxLength={50}
                    spellCheck={false}
                  />
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void submitTitleEdit()}
                    disabled={savingTitle || !titleDraftInput.trim()}
                    title="保存章名（Enter）"
                  >
                    {savingTitle ? '保存中…' : '保存'}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={cancelTitleEdit}
                    disabled={savingTitle}
                    title="取消（Esc）"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <h1
                  className="editor-title-display"
                  style={{ display: 'inline', fontSize: 17, fontWeight: 700, margin: 0 }}
                >
                  第 {data.meta.chapterNumber} 章 · {data.meta.title}
                  <button
                    className="editor-title-action"
                    onClick={startTitleEdit}
                    title="手动修改章名"
                  >
                    ✏️
                  </button>
                  <button
                    className="editor-title-action"
                    onClick={() => void requestAiName()}
                    disabled={namingLoading}
                    title="基于当前正文让 AI 起个章名（候选需确认才会保存）"
                  >
                    {namingLoading ? '生成中…' : '✨'}
                  </button>
                </h1>
              )}
              {nameCandidate && titleEditing ? (
                <div className="editor-title-candidate" role="status">
                  <span className="editor-title-candidate-label">AI 候选</span>
                  <span className="editor-title-candidate-title">{nameCandidate.title}</span>
                  {nameCandidate.reason ? (
                    <span className="editor-title-candidate-reason">— {nameCandidate.reason}</span>
                  ) : null}
                  <span className="editor-title-candidate-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={acceptCandidate}
                      title="用此候选作为新章名"
                    >
                      采用
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={rejectCandidate}
                      title="不用此候选（继续手动编辑）"
                    >
                      不用
                    </button>
                  </span>
                </div>
              ) : null}
              <p className="desc" style={{ marginTop: 2 }}>
                <span className="num">{data.meta.wordCount.toLocaleString()}</span> 字
              </p>
            </div>
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
        <button
          className={`btn btn-sm ${findBarOpen ? 'btn-primary' : ''}`}
          onClick={() => {
            setFindBarOpen(!findBarOpen)
            if (!findBarOpen) {
              setTimeout(() => {
                const inp = document.getElementById('find-input') as HTMLInputElement | null
                if (inp) {
                  inp.focus()
                  inp.select()
                }
              }, 60)
            }
          }}
          title="查找与替换 (Ctrl+F)"
        >
          🔍 查找
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setShowPreview((s) => !s)}
          title="按人物/伏笔/地点高亮正文"
        >
          {showPreview ? '收起预览' : '👁 预览'}
        </button>
        <button
          className={`btn btn-sm${showLineNumbers ? ' btn-primary' : ''}`}
          onClick={() => setShowLineNumbers((s) => !s)}
          title="显示/隐藏行号"
        >
          {showLineNumbers ? '隐藏行号' : '# 行号'}
        </button>
        <button className="btn btn-sm" onClick={() => void handleCopyDraft()} title="复制当前正文到剪贴板">
          复制正文
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setShowAdjustDialog(true)}
          disabled={adjusting || generating}
          title="按新的追问要求调整当前已生成正文"
        >
          {adjusting ? '调整中…' : '按要求重写'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setShowAskDialog(true)}
          disabled={asking || generating}
          title="就当前正文向 AI 提问，如「为什么这样写」「人物动机合理吗」，只回答不改正文"
        >
          {asking ? '追问中…' : '💬 追问'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => void startDeslopScan()}
          disabled={deslopScanning || deslopRunning || !draft.trim()}
          title="扫描并清除 AI 写作痕迹（禁用词/句式/心理描写/破折号/升华句）"
        >
          {deslopScanning ? '扫描中…' : '🧹 去 AI 味'}
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            const skip = localStorage.getItem('ai-writer:skip-continue-dialog') === 'true'
            if (skip) {
              void aiGenerate()
            } else {
              setTempContextInput('')
              setShowContinueDialog(true)
            }
          }}
          disabled={generating || adjusting}
        >
          {generating ? '落墨中…' : '✦ 续写'}
        </button>
        <button
          className={`btn btn-sm${flowPanelOpen ? ' btn-primary' : ''}`}
          onClick={() => setFlowPanelOpen((open) => !open)}
          title="展开或收起可拖动的续写流程面板"
        >
          流程面板
        </button>
        <span className="spacer" />
        {/* P11-A：保存指示器 */}
        {lastSavedAt !== null ? (
          <span
            className="save-indicator"
            title={isSaving ? '正在保存…' : `上次保存：${new Date(lastSavedAt).toLocaleTimeString()}`}
          >
            {isSaving ? '⟳ 保存中…' : `✓ 已保存 ${formatRelativeTime(lastSavedAt, Date.now())}`}
          </span>
        ) : null}
        {/* 更多操作下拉 */}
        <div className="toolbar-more" style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setToolbarMoreOpen((v) => !v)}
            onBlur={() => setTimeout(() => setToolbarMoreOpen(false), 150)}
          >
            ⋯
          </button>
          {toolbarMoreOpen ? (
            <div className="toolbar-more-menu">
              {/* 章节版本功能暂未开放（IPC stub），UI 隐藏避免误触 */}
              <button
                className="toolbar-more-item"
                onClick={() => { reAudit(); setToolbarMoreOpen(false) }}
                disabled={reAuditLoading}
              >
                {reAuditLoading ? '检查中…' : '重新质检'}
              </button>
              {/* P10-A：用量统计 */}
              <div className="toolbar-more-sep" />
              <div className="toolbar-more-item" style={{ cursor: 'default', opacity: 0.8 }}>
                📊 今日{usage ? ` ${formatCost(usage.today.cost)}` : '…'}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* 番茄钟 + 写作进度 */}
      <div
        className="chapter-workbench"
        style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      >
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
          <div className="goal-row" style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>本章字数</span>
            <span>
              <span className="num">{(draft.match(/\S/g) ?? []).length}</span> /{' '}
              {isEditingGoal ? (
                <input
                  type="number"
                  className="input input-sm"
                  value={editingGoalVal}
                  onChange={(e) => setEditingGoalVal(e.target.value)}
                  onBlur={() => {
                    const val = Number(editingGoalVal) || 0
                    handleSaveChapterGoal(val)
                    setIsEditingGoal(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = Number(editingGoalVal) || 0
                      handleSaveChapterGoal(val)
                      setIsEditingGoal(false)
                    }
                  }}
                  autoFocus
                  style={{ width: 60, padding: '2px 4px', fontSize: 11, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
                />
              ) : (
                <span
                  className="num"
                  onClick={() => {
                    setEditingGoalVal(String(chapterGoal))
                    setIsEditingGoal(true)
                  }}
                  style={{ cursor: 'pointer', borderBottom: '1px dashed var(--ink-3)' }}
                  title="点击修改本章字数目标"
                >
                  {chapterGoal}
                </span>
              )} 字
            </span>
          </div>
          <div className="goal-bar" style={{ marginTop: 4 }}>
            <div
              className={`fill ${(draft.match(/\S/g) ?? []).length >= chapterGoal ? 'done' : ''}`}
              style={{ width: `${Math.min(100, ((draft.match(/\S/g) ?? []).length / Math.max(1, chapterGoal)) * 100)}%` }}
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

      <div className="chapter-outline-panel" style={{ marginBottom: 10 }}>
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
            {visiblePlant.length > 0 ? (
              <ReminderGroup
                title="细纲提示"
                items={visiblePlant}
                tone="hook"
                onDismiss={(it) => dismissReminder('plant', it.content)}
              />
            ) : null}
            {visibleReinforce.length > 0 ? (
              <ReminderGroup
                title="待埋 / 待强化"
                items={visibleReinforce}
                tone="cool"
                onDismiss={(it) => dismissReminder('reinforce', it.content)}
              />
            ) : null}
            {visibleCollect.length > 0 ? (
              <ReminderGroup
                title="本章待回收"
                items={visibleCollect}
                tone="emotion"
                onDismiss={(it) => dismissReminder('collect', it.content)}
              />
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
          onClose={() => {
            setFlowPanelOpen(false)
            setFlowSyncTrigger(0)
            setAutoSyncSeed(null)
            setSkipMemoryOnAutoSyncAll(false)
          }}
          postWriteSyncBanner={
            postWriteSync && postWriteSync.phase !== 'idle'
              ? {
                  phase: postWriteSync.phase,
                  message: postWriteSync.message,
                  errors: postWriteSync.errors,
                  canUndo: postWriteSync.canUndo || syncHistoryDepth > 0,
                  undoDepth: Math.max(postWriteSync.undoDepth, syncHistoryDepth),
                  fromPendingQueue: postWriteSync.fromPendingQueue
                }
              : null
          }
          onRetryAutoSync={retryPostWriteSync}
          onUndoAutoSync={
            postWriteSync?.canUndo || syncHistoryDepth > 0
              ? () => void undoLastPostWriteSync()
              : undefined
          }
          onDismissPendingSync={
            postWriteSync?.fromPendingQueue || postWriteSync?.phase === 'failed'
              ? dismissPendingSync
              : undefined
          }
          undoAutoSyncLoading={undoSyncLoading}
          onOutlineUpdated={(item) => setChapterOutline(item)}
          onRunAudit={reAudit}
          onJumpToOffset={jumpToOffset}
          onApplyRewrite={(snippet, rewritten, violationKey) => {
            // 用改写后的文本替换 draft 中的命中段（保留前后原文）
            if (!snippet) return false
            const target = findRewriteTarget(draft, snippet, rewritten)
            if (!target) {
              setAlertInfo({ message: '未在正文中找到原片段（可能已被改写），请手动应用' })
              return false
            }
            const next = draft.slice(0, target.start) + target.replacement + draft.slice(target.end)
            setDraft(next)
            setDirty(true)
            // 压栈：记录这次 apply 用于"↶ 撤销"。P6-B 传 violationKey 用于 per-violation 撤销。
            pushRewrite(target.oldSnippet, target.replacement, violationKey)
            // 应用后自动重跑一次，让违例清单反映新正文
            void reAudit()
            return true
          }}
          // 批量应用：edits 已按位置倒序排列；ChapterEditor 本地构造 nextDraft，
          // 每条独立 pushRewrite，最后只 setDraft + reAudit 一次，避免 setDraft/stale closure
          // 丢改动且避免连发 N 次审计。
          onApplyRewriteBatch={(edits) => {
            if (edits.length === 0) return 0
            let nextDraft = draft
            let applied = 0
            let firstFailedPos = -1
            for (const edit of edits) {
              if (!edit.snippet) continue
              // 因为 edits 已按位置倒序、且每条 snippet 都基于初始 draft 算出，
              // 在已变更的 nextDraft 上 indexOf 仍然能命中（除非 snippet 长度有边界 trim 差异）。
              const target = findRewriteTarget(nextDraft, edit.snippet, edit.rewritten)
              if (!target) {
                if (firstFailedPos === -1) firstFailedPos = nextDraft.length
                continue
              }
              nextDraft =
                nextDraft.slice(0, target.start) +
                target.replacement +
                nextDraft.slice(target.end)
              // P6-B：每条独立 violationKey → 独立 undo 入口，与"应用全部"过去的契约一致
              pushRewrite(target.oldSnippet, target.replacement, edit.violationKey)
              applied++
            }
            if (applied > 0) {
              setDraft(nextDraft)
              setDirty(true)
              const note = applied < edits.length ? `（跳过 ${edits.length - applied} 条）` : ''
              setUndoToast({ message: `已应用 ${applied} 条改写${note}`, type: 'info' })
            }
            if (applied === 0 && firstFailedPos !== -1) {
              setAlertInfo({ message: '未在正文中找到任何原片段（可能已被改写），请手动应用' })
            }
            // 不论多少，都跑一次审计反映新正文
            void reAudit()
            return applied
          }}
          rewriteHistory={rewriteHistory}
          redoStackCount={redoStack.length}
          onUndoRewrite={undoLastRewrite}
          onUndoRewriteAt={undoRewriteAt}
          onUndoRewriteByKey={undoRewriteByKey}
          onRedoRewrite={redoLastRewrite}
          syncAllTrigger={flowSyncTrigger}
          autoSyncSeed={autoSyncSeed}
          skipMemoryOnAutoSyncAll={skipMemoryOnAutoSyncAll}
          onFocusQuote={focusQuoteInEditor}
        />
      ) : null}

      {/* P6-C：撤销失败 toast（fixed 定位，不被面板遮挡） */}
        </div>

        <div className="chapter-main-pane">
          {/* 写后同步状态条：结果可见 + 失败/部分失败可补跑（比 toast 更持久） */}
          {postWriteSync && postWriteSync.phase !== 'idle' ? (
            <div
              className={`post-write-sync-banner post-write-sync-${postWriteSync.phase}`}
              role="status"
            >
              <div className="post-write-sync-main">
                <span className="post-write-sync-label">
                  {postWriteSync.phase === 'syncing'
                    ? '⟳'
                    : postWriteSync.phase === 'ok'
                      ? '✓'
                      : postWriteSync.phase === 'partial'
                        ? '⚠'
                        : postWriteSync.phase === 'failed'
                          ? '✕'
                          : '–'}
                </span>
                <span className="post-write-sync-msg">{postWriteSync.message}</span>
              </div>
              {postWriteSync.errors.length > 0 && postWriteSync.phase !== 'syncing' ? (
                <div
                  className="post-write-sync-errors"
                  title={postWriteSync.errors.join('\n')}
                >
                  {formatSyncErrorHint(postWriteSync.errors)}
                </div>
              ) : null}
              <div className="post-write-sync-actions">
                {(postWriteSync.canUndo || syncHistoryDepth > 0) &&
                postWriteSync.phase !== 'syncing' ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void undoLastPostWriteSync()}
                    disabled={undoSyncLoading}
                    title="撤销最近一次自动写入的记忆/设定（可多级；不删手动确认的新增实体）"
                  >
                    {undoSyncLoading
                      ? '撤销中…'
                      : Math.max(postWriteSync.undoDepth, syncHistoryDepth) > 1
                        ? `撤销同步 (${Math.max(postWriteSync.undoDepth, syncHistoryDepth)})`
                        : '撤销同步'}
                  </button>
                ) : null}
                {postWriteSync.phase !== 'syncing' &&
                (postWriteSync.phase === 'failed' ||
                  postWriteSync.phase === 'partial' ||
                  postWriteSync.phase === 'ok' ||
                  postWriteSync.phase === 'skipped' ||
                  postWriteSync.fromPendingQueue) ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={retryPostWriteSync}
                    disabled={undoSyncLoading}
                    title="用正文快照重新提取并同步记忆/设定（失败队列项也会补跑）"
                  >
                    {postWriteSync.fromPendingQueue || postWriteSync.phase === 'failed'
                      ? '补跑同步'
                      : '重新同步'}
                  </button>
                ) : null}
                {(postWriteSync.fromPendingQueue || postWriteSync.phase === 'failed') &&
                postWriteSync.phase !== 'syncing' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={dismissPendingSync}
                    disabled={undoSyncLoading}
                    title="从待同步队列移除本章（不改正文）"
                  >
                    忽略
                  </button>
                ) : null}
                {postWriteSync.phase !== 'syncing' && !flowPanelOpen ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setFlowPanelOpen(true)}
                  >
                    查看详情
                  </button>
                ) : null}
                {postWriteSync.phase !== 'syncing' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPostWriteSync(null)}
                    aria-label="关闭同步状态"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* 本章细纲（正文上方，可收起/展开） */}
          <div className="chapter-outline-panel-above" style={{ marginBottom: 16, padding: 12, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--line)' }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setOutlinePanelOpen(!outlinePanelOpen)}
                style={{ padding: '2px 6px', marginRight: 6 }}
                title={outlinePanelOpen ? '收起细纲' : '展开细纲'}
              >
                {outlinePanelOpen ? '▼' : '▶'}
              </button>
              <strong style={{ fontSize: 13.5 }}>本章细纲</strong>
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                {chapterOutline ? `第 ${chapterNumber} 章` : '暂无细纲'}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {onOpenOutline ? (
                  <button className="btn btn-sm btn-ghost" onClick={onOpenOutline}>
                    大纲页 →
                  </button>
                ) : null}
                <button
                  className="btn btn-sm"
                  onClick={generateThisChapterOutline}
                  disabled={generatingOutline}
                >
                  {generatingOutline
                    ? '运笔中…'
                    : chapterOutline
                      ? '重新生成'
                      : '✦ 生成细纲'}
                </button>
              </div>
            </div>
            {outlinePanelOpen && (
              chapterOutline ? (
                <>
                  <div className="outline-detail-fields" style={{ marginTop: 8 }}>
                    {getOutlineDetailRows(chapterOutline).map((row) => (
                      <OutlineDetailField key={row.label} row={row} />
                    ))}
                  </div>
                </>
              ) : (
                <p className="missing" style={{ marginTop: 8 }}>
                  本章暂无细纲，点「✦ 生成细纲」让 AI 据总纲铺陈。
                </p>
              )
            )}
          </div>

          {findBarOpen ? (
            <div className="find-replace-bar" onClick={(e) => e.stopPropagation()}>
              <div className="bar-row">
                <input
                  id="find-input"
                  type="text"
                  className="input input-sm find-input"
                  placeholder="输入要查找的词..."
                  value={findText}
                  onChange={(e) => handleFind(e.target.value)}
                />
                <span className="results-count">
                  {findResults.length > 0 ? `${currentResultIndex + 1} / ${findResults.length}` : '无匹配'}
                </span>
                <button className="btn btn-sm" onClick={handleFindPrev} disabled={findResults.length === 0}>▲</button>
                <button className="btn btn-sm" onClick={handleFindNext} disabled={findResults.length === 0}>▼</button>
              </div>
              <div className="bar-row" style={{ marginTop: 6 }}>
                <input
                  type="text"
                  className="input input-sm replace-input"
                  placeholder="替换为..."
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                />
                <button className="btn btn-sm" onClick={handleReplace} disabled={currentResultIndex === -1}>替换</button>
                <button className="btn btn-sm" onClick={handleReplaceAll} disabled={findResults.length === 0}>全部替换</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setFindBarOpen(false); setFindResults([]); setCurrentResultIndex(-1); }} style={{ marginLeft: 'auto' }}>✕</button>
              </div>
            </div>
          ) : null}

      {undoToast ? (
        <div className={`undo-toast undo-toast-${undoToast.type}`} role="status">
          {undoToast.message}
        </div>
      ) : null}

      <div className={`editor-text-wrapper${showLineNumbers ? ' with-line-numbers' : ''}`}>
        {showLineNumbers && (() => {
          // 行号数量始终以当前 draft 的逻辑行数为准（lineHeights 仅用于精确对齐高度），
          // 避免 AI 续写流式更新时 lineHeights 滞后一帧导致"行号数量对不上正文"。
          const lines = draft.split('\n')
          return (
            <div className="editor-line-gutter" ref={lineGutterRef} aria-hidden="true">
              <div className="editor-line-gutter-inner" ref={lineGutterInnerRef}>
                {lines.map((_, i) => (
                  <div key={i} className="line-num" style={{ height: lineHeights[i] ?? baseLineHeight }}>
                    {i + 1}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
        <textarea
          ref={textareaRef}
          className="editor-text"
          value={draft}
          onScroll={handleEditorScroll}
          onChange={(e) => {
            setDraft(e.target.value)
            setDirty(true)
            if (findResults.length > 0) {
              setFindResults([])
              setCurrentResultIndex(-1)
            }
          }}
          placeholder="此处落笔，或点「续写」让 AI 接续成文……"
        />
        <div ref={mirrorRef} className="editor-text-mirror" aria-hidden="true" />
      </div>

      {showPreview ? (
        <div className="chapter-main-preview">
          <div className="row" style={{ marginTop: 16, marginBottom: 4, justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="btn-group">
              <button
                className={`btn btn-sm ${previewTab === 'highlight' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPreviewTab('highlight')}
              >
                👁 联动高亮
              </button>
              <button
                className={`btn btn-sm ${previewTab === 'markdown' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPreviewTab('markdown')}
              >
                📝 Markdown 排版
              </button>
            </div>
            {previewTab === 'highlight' && (
              <div className="row" style={{ gap: 12, fontSize: 12, color: 'var(--ink-3)' }}>
                <span><span className="hl char" style={{ padding: '1px 4px' }}>人物</span></span>
                <span><span className="hl foreshadow" style={{ padding: '1px 4px' }}>伏笔</span></span>
                <span><span className="hl location" style={{ padding: '1px 4px' }}>地点</span></span>
              </div>
            )}
          </div>
          <div className="editor-preview">
            {previewTab === 'highlight' ? (
              previewSegments && previewSegments.length > 0 ? (
                previewSegments.map((seg, i) =>
                  seg.hl ? (
                    <span
                      key={i}
                      className={`hl ${seg.hl.kind}`}
                      title={`${seg.hl.label} · ${seg.text}`}
                      onClick={(e) => onPreviewClick(seg.hl!.kind as any, seg.text, e)}
                    >
                      {seg.text}
                    </span>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  )
                )
              ) : (
                <span className="muted">暂无可联动高亮的内容。</span>
              )
            ) : (
              renderMarkdownPreview(draft)
            )}
          </div>
        </div>
      ) : null}

        </div>

        <div
          className={`chapter-splitter ${isDraggingSidebar ? 'dragging' : ''}`}
          onMouseDown={handleSidebarMouseDown}
        />

        <div className="chapter-side-block">
      <div className="editor-panel">
        <div className="ep-head">
          <div className="ep-title">🎯 长期写作要求</div>
          <div className="btn-group">
            {isEditingReqs ? (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSaveReqs}
                  disabled={savingReqs}
                >
                  {savingReqs ? '保存中...' : '保存'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingReqsTemplateId(chapterOutline?.writingRequirementTemplateId ?? '')
                    setEditingReqsCustomText(
                      chapterOutline?.writingRequirementCustomText ??
                        chapterOutline?.writingRequirements ??
                        ''
                    )
                    setIsEditingReqs(false)
                  }}
                  disabled={savingReqs}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                className="btn btn-sm"
                onClick={() => setIsEditingReqs(true)}
                disabled={!chapterOutline}
              >
                编辑
              </button>
            )}
          </div>
        </div>
        <div className="ep-body" style={{ marginTop: 6 }}>
          {!chapterOutline ? (
            <p className="muted" style={{ fontSize: '12px', margin: 0 }}>
              暂无本章细纲。请先在左侧「📜 本章细纲」中生成或导入细纲，之后即可配置长期写作要求。
            </p>
          ) : isEditingReqs ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <div className="muted" style={{ fontSize: '11.5px', marginBottom: 6 }}>
                  先选一个长期写作模板，或者保留“仅自己填写”。
                </div>
                <select
                  className="select"
                  value={editingReqsTemplateId}
                  onChange={(e) => setEditingReqsTemplateId(e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">仅自己填写</option>
                  {writingRequirementTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} - {template.description}
                    </option>
                  ))}
                </select>
              </div>

              {editingReqsTemplateId ? (
                <div
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--line-soft)',
                    fontSize: '12px',
                    lineHeight: '1.6',
                    color: 'var(--fg-main)'
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {getWritingRequirementTemplate(
                      editingReqsTemplateId,
                      writingRequirementTemplates
                    )?.name}
                  </div>
                  <div className="muted" style={{ fontSize: '11.5px', marginBottom: 6 }}>
                    {getWritingRequirementTemplate(
                      editingReqsTemplateId,
                      writingRequirementTemplates
                    )?.description}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(
                      getWritingRequirementTemplate(
                        editingReqsTemplateId,
                        writingRequirementTemplates
                      )?.requirements ?? []
                    ).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <div className="muted" style={{ fontSize: '11.5px', marginBottom: 6 }}>
                  自定义补充要求
                </div>
                <textarea
                  className="textarea"
                  style={{
                    width: '100%',
                    minHeight: '96px',
                    fontSize: '12px',
                    lineHeight: '1.5',
                    padding: '6px 8px',
                    borderRadius: '4px',
                    border: '1px solid var(--line-soft)',
                    backgroundColor: 'var(--bg-card)',
                    color: 'var(--fg-main)',
                    resize: 'vertical',
                    fontFamily: 'inherit'
                  }}
                  value={editingReqsCustomText}
                  onChange={(e) => setEditingReqsCustomText(e.target.value)}
                  placeholder="可继续自己写要求，例如：开头强情绪、人物对话贴合角色、结尾用对话或事件收束。这里会和所选模板一起长期生效。"
                />
              </div>
            </div>
          ) : chapterOutline.writingRequirements ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {activeRequirementTemplate ? (
                <div
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--line-soft)'
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-main)' }}>
                    已选模板：{activeRequirementTemplate.name}
                  </div>
                  <div className="muted" style={{ fontSize: '11.5px', marginTop: 4 }}>
                    {activeRequirementTemplate.description}
                  </div>
                </div>
              ) : null}
              <div
                style={{
                  fontSize: '12px',
                  lineHeight: '1.5',
                  color: 'var(--fg-main)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}
              >
                {chapterOutline.writingRequirements}
              </div>
            </div>
          ) : (
            <p
              className="muted"
              style={{ fontSize: '12px', margin: 0, cursor: 'pointer' }}
              onClick={() => setIsEditingReqs(true)}
            >
              暂无本章长期写作要求，点击编辑后可直接自己写，也可以先选模板再补充。之后继续写这一章时，AI 会持续遵循这些要求。
            </p>
          )}
        </div>
      </div>

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

        </div>
      </div>

      {deslopScanReport || deslopRunning || deslopResult ? (
        <div
          className="dialog-overlay"
          onClick={() => {
            if (!deslopRunning) {
              setDeslopScanReport(null)
              setDeslopResult(null)
              setDeslopLog('')
            }
          }}
        >
          <div
            className="dialog"
            style={{
              width: 'min(1100px, 94vw)',
              maxWidth: 1100,
              maxHeight: '92vh',
              overflow: 'auto',
              padding: '20px 24px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>🧹 去 AI 味</h3>

            {/* 扫描报告 */}
            {deslopScanReport && !deslopResult ? (
              <div>
                <div className="row" style={{ gap: 12, marginBottom: 12 }}>
                  <span className="filter-chip">blocking {deslopScanReport.counts.blocking}</span>
                  <span className="filter-chip">advisory {deslopScanReport.counts.advisory}</span>
                  <span className="filter-chip">{deslopScanReport.wordCount} 字</span>
                  <span className="filter-chip">禁用词密度 {deslopScanReport.metrics.bannedWordDensity.toFixed(1)}/千字</span>
                </div>
                {deslopScanReport.findings.length === 0 ? (
                  <p className="empty">未检测到 AI 写作痕迹，正文很自然。</p>
                ) : (
                  <div style={{ maxHeight: 420, overflow: 'auto', fontSize: 12, marginBottom: 12 }}>
                    {deslopFindingsByGate?.map(({ gate, items }) => {
                      const collapsed = deslopCollapsedGates.has(gate)
                      const blockingN = items.filter((f) => f.severity === 'blocking').length
                      return (
                        <div key={gate} style={{ marginBottom: 6 }}>
                          <div
                            style={{ cursor: 'pointer', padding: '4px 0', fontWeight: 600, userSelect: 'none' }}
                            onClick={() => {
                              setDeslopCollapsedGates((prev) => {
                                const next = new Set(prev)
                                if (next.has(gate)) next.delete(gate)
                                else next.add(gate)
                                return next
                              })
                            }}
                          >
                            {collapsed ? '▶' : '▼'} Gate {gate}
                            <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--ink-2, #666)' }}>
                              {items.length} 处{blockingN > 0 ? `（含 ${blockingN} 处 blocking）` : ''}
                            </span>
                          </div>
                          {collapsed ? null : (
                            <div style={{ marginLeft: 12 }}>
                              {items.slice(0, 20).map((f, i) => (
                                <div key={i} className="diag-item" style={{ padding: '4px 0' }}>
                                  <span style={{ color: f.severity === 'blocking' ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                                    {f.severity}
                                  </span>
                                  <span className="diag-msg" style={{ marginLeft: 8 }}>第{f.line}行 {f.excerpt}</span>
                                  <div className="diag-hint">{f.message}</div>
                                </div>
                              ))}
                              {items.length > 20 ? (
                                <p className="meta">…还有 {items.length - 20} 处</p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setDeslopScanReport(null); setDeslopLog('') }}
                    disabled={deslopRunning}
                  >
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void runDeslop(undefined)}
                    disabled={deslopRunning || deslopScanReport.findings.length === 0}
                  >
                    {deslopRunning ? '润色中…' : '开始润色'}
                  </button>
                </div>
              </div>
            ) : null}

            {/* 润色进度 */}
            {deslopRunning && deslopLog ? (
              <pre
                style={{
                  background: 'var(--bg-code, #1e1e2e)',
                  color: 'var(--fg-code, #cdd6f4)',
                  padding: 12,
                  borderRadius: 8,
                  maxHeight: 480,
                  overflow: 'auto',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  margin: '8px 0'
                }}
              >
                {deslopLog.split('\n').map((line, i) => {
                  const isPass = /Pass \d+\/\d+/.test(line)
                  const isPhase = /Phase [0-9]/.test(line)
                  if (isPass) {
                    return (
                      <span key={i} style={{ color: '#a6e3a1', fontWeight: 700 }}>
                        {line}{'\n'}
                      </span>
                    )
                  }
                  if (isPhase) {
                    return (
                      <span key={i} style={{ color: '#89b4fa', fontWeight: 600 }}>
                        {line}{'\n'}
                      </span>
                    )
                  }
                  return <span key={i}>{line}{'\n'}</span>
                })}
              </pre>
            ) : null}

            {/* 润色结果 diff 预览 */}
            {deslopResult ? (
              <div>
                <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="filter-chip">{deslopResult.beforeWords} {'->'} {deslopResult.afterWords} 字</span>
                  <span className="filter-chip">
                    {deslopResult.deleteRatio >= 0
                      ? `删除 ${(deslopResult.deleteRatio * 100).toFixed(1)}%`
                      : `增加 ${(-deslopResult.deleteRatio * 100).toFixed(1)}%`}
                  </span>
                  <span className="filter-chip">剩余问题 {deslopResult.remainingFindings.length}</span>
                  <span className="filter-chip">Gate {deslopResult.processedGates.join('')}</span>
                  {deslopDiffView ? (
                    <span className="filter-chip">
                      {deslopDiffView.identical
                        ? '无实质改动'
                        : `改动 ${deslopDiffView.hunks.length || deslopDiffView.summary.length} 处`}
                    </span>
                  ) : null}
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ marginLeft: 'auto', fontSize: 11 }}
                    onClick={() => setDeslopDiffFull((v) => !v)}
                  >
                    {deslopDiffFull ? '只看差异' : '看全文'}
                  </button>
                </div>

                {deslopDiffView?.identical ? (
                  <p className="diag-msg" style={{ marginBottom: 8, color: 'var(--ink-2)' }}>
                    正文与改写前一致（可能仅做了扫描收尾、未改写到可见内容）。
                  </p>
                ) : null}

                {/* 默认：逐段改动对照；全文模式：从首个差异处起的上下文 / 全文 */}
                {!deslopDiffFull && deslopDiffView && deslopDiffView.hunks.length > 0 ? (
                  <div style={{ maxHeight: 520, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {deslopDiffView.hunks.map((h, i) => (
                      <div
                        key={i}
                        style={{
                          border: '1px solid var(--line)',
                          borderRadius: 8,
                          padding: 10,
                          background: 'var(--surface)'
                        }}
                      >
                        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 6 }}>
                          改动 #{i + 1} · 约第 {h.line} 段
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <div>
                            <strong style={{ fontSize: 12, color: 'var(--vermilion)' }}>改写前</strong>
                            <pre
                              style={{
                                background: 'rgba(220, 38, 38, 0.06)',
                                padding: 10,
                                borderRadius: 6,
                                maxHeight: 200,
                                overflow: 'auto',
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                margin: '4px 0 0',
                                color: 'var(--ink)'
                              }}
                            >
                              {h.before || '（删除）'}
                            </pre>
                          </div>
                          <div>
                            <strong style={{ fontSize: 12, color: 'var(--success, #16a34a)' }}>改写后</strong>
                            <pre
                              style={{
                                background: 'rgba(22, 163, 74, 0.06)',
                                padding: 10,
                                borderRadius: 6,
                                maxHeight: 200,
                                overflow: 'auto',
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                margin: '4px 0 0',
                                color: 'var(--ink)'
                              }}
                            >
                              {h.after || '（删除）'}
                            </pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <strong style={{ fontSize: 12 }}>
                        改写前
                        {deslopDiffFull
                          ? ''
                          : deslopDiffView && !deslopDiffView.window.identical && deslopDiffView.window.offset > 0
                            ? `（自第 ${deslopDiffView.window.offset + 1} 字起 600 字）`
                            : '（前 600 字）'}
                      </strong>
                      <pre
                        style={{
                          background: 'var(--bg-code, #f6f8fa)',
                          padding: 8,
                          borderRadius: 6,
                          maxHeight: deslopDiffFull ? 560 : 360,
                          overflow: 'auto',
                          fontSize: 12,
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {deslopDiffFull
                          ? draft
                          : deslopDiffView
                            ? deslopDiffView.window.beforeSlice
                            : draft.slice(0, 600)}
                      </pre>
                    </div>
                    <div>
                      <strong style={{ fontSize: 12 }}>
                        改写后
                        {deslopDiffFull
                          ? ''
                          : deslopDiffView && !deslopDiffView.window.identical && deslopDiffView.window.offset > 0
                            ? `（自第 ${deslopDiffView.window.offset + 1} 字起 600 字）`
                            : '（前 600 字）'}
                      </strong>
                      <pre
                        style={{
                          background: 'var(--bg-code, #f6f8fa)',
                          padding: 8,
                          borderRadius: 6,
                          maxHeight: deslopDiffFull ? 560 : 360,
                          overflow: 'auto',
                          fontSize: 12,
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {deslopDiffFull
                          ? deslopResult.rewritten
                          : deslopDiffView
                            ? deslopDiffView.window.afterSlice
                            : deslopResult.rewritten.slice(0, 600)}
                      </pre>
                    </div>
                  </div>
                )}

                {/* 改动明细：始终展示（LLM 说明或自动 diff） */}
                <div style={{ marginTop: 10 }}>
                  <strong style={{ fontSize: 12 }}>
                    改动明细
                    {deslopDiffView && deslopDiffView.summary.length > 0
                      ? `（${deslopDiffView.summary.length} 处）`
                      : '（无）'}
                    {deslopResult.changeSummary.length === 0 &&
                    deslopDiffView &&
                    deslopDiffView.summary.length > 0
                      ? ' · 自动对比'
                      : ''}
                  </strong>
                  {deslopDiffView && deslopDiffView.summary.length > 0 ? (
                    <div style={{ maxHeight: 280, overflow: 'auto', fontSize: 13, marginTop: 4 }}>
                      {deslopDiffView.summary.map((c, i) => (
                        <div key={i} className="diag-item" style={{ padding: '6px 10px' }}>
                          <span className="diag-msg">{c.replace(/^- /, '')}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="diag-msg" style={{ marginTop: 4, color: 'var(--ink-2)' }}>
                      {deslopDiffView?.identical
                        ? '未检出文本差异。'
                        : '未生成改动说明，可点「看全文」对照，或放弃后重试。'}
                    </p>
                  )}
                </div>

                {deslopResult.remainingFindings.filter((f) => f.severity === 'blocking').length > 0 ? (
                  <p className="diag-msg" style={{ color: '#dc2626', marginTop: 8 }}>
                    ⚠ 复扫仍剩 {deslopResult.remainingFindings.filter((f) => f.severity === 'blocking').length} 处 blocking，建议人工复核
                  </p>
                ) : null}
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => { setDeslopResult(null); setDeslopLog('') }}
                  >
                    放弃
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={applyDeslopResult}
                    disabled={deslopDiffView?.identical}
                    title={deslopDiffView?.identical ? '无改动可应用' : undefined}
                  >
                    应用到正文
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {previewCard ? (
        <div
          className="preview-inline-card"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(previewCard.x, window.innerWidth - 300),
            top: Math.min(previewCard.y + 12, window.innerHeight - 180),
            zIndex: 9999
          }}
        >
          <header className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>{previewCard.details.title}</strong>
            <button className="btn btn-ghost btn-sm close-btn" onClick={() => setPreviewCard(null)}>✕</button>
          </header>
          <div className="card-body">
            {previewCard.details.subtitle && <p className="subtitle">{previewCard.details.subtitle}</p>}
            {previewCard.details.content && <p className="desc">{previewCard.details.content}</p>}
          </div>
          {previewCard.kind === 'char' && onOpenCharacters && (
            <footer className="card-footer">
              <button className="btn btn-ghost btn-sm link-btn" onClick={() => {
                setPreviewCard(null)
                onOpenCharacters()
              }}>
                查看人物卡 ↗
              </button>
            </footer>
          )}
        </div>
      ) : null}

      {showAdjustDialog ? (
        <div className="dialog-overlay" onClick={() => setShowAdjustDialog(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()} style={{ width: 780, maxWidth: '95vw', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 28, boxShadow: 'var(--shadow-lg)' }}>
            <header>
              <strong style={{ fontSize: 16.5 }}>追问调整正文</strong>
            </header>
            <div className="dialog-body" style={{ marginTop: 12 }}>
              <p style={{ fontSize: 14, color: 'var(--ink-2)', margin: 0, lineHeight: 1.5 }}>
                写下这次想怎么改，AI 会基于当前编辑器里的正文生成一版完整修订稿，先替换草稿，不会自动保存。
              </p>
              <textarea
                className="textarea"
                placeholder="例如：把高潮前的铺垫压短一点；加强女主的反击，不要只靠旁白解释；结尾改成一句对话钩子。"
                value={adjustInstruction}
                onChange={(e) => setAdjustInstruction(e.target.value)}
                style={{ width: '100%', minHeight: 240, marginTop: 14, fontSize: 14, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)', resize: 'vertical' }}
              />
            </div>
            <footer style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowAdjustDialog(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void adjustChapter()}
                disabled={adjusting || !adjustInstruction.trim()}
              >
                {adjusting ? '调整中…' : '开始调整'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {showAskDialog ? (
        <AskChatDialog
          messages={askMessages}
          asking={asking}
          question={askQuestion}
          onQuestionChange={setAskQuestion}
          onSubmit={() => void submitAskQuestion()}
          onClose={() => setShowAskDialog(false)}
          onClear={() => {
            ++askRef.current
            setAsking(false)
            setAskMessages([])
          }}
        />
      ) : null}

      {showContinueDialog ? (
        <div className="dialog-overlay" onClick={() => setShowContinueDialog(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()} style={{ width: 440, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 16, boxShadow: 'var(--shadow-lg)' }}>
            <header>
              <strong>✦ AI 续写</strong>
            </header>
            <div className="dialog-body" style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: 0 }}>
                可在下方输入本次临时写作要求，只影响这一次续写（选填）：
              </p>
              <textarea
                className="textarea"
                placeholder="例如：这次先多写对话推进，开头直接冲突，顺手埋下林远身世线索。仅本次续写生效，不会覆盖上面的长期要求。"
                value={tempContextInput}
                onChange={(e) => setTempContextInput(e.target.value)}
                style={{ width: '100%', minHeight: 80, marginTop: 8, fontSize: 12.5, padding: 8, borderRadius: 'var(--r-sm)', background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)', resize: 'vertical' }}
              />
              <label className="checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  id="skip-prompt-check"
                  defaultChecked={localStorage.getItem('ai-writer:skip-continue-dialog') === 'true'}
                  onChange={(e) => {
                    localStorage.setItem('ai-writer:skip-continue-dialog', e.target.checked ? 'true' : 'false')
                  }}
                />
                下次直接续写，不再弹出此确认框
              </label>
            </div>
            <footer style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowContinueDialog(false)}
              >
                取消
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setShowContinueDialog(false)
                  void aiGenerate()
                }}
              >
                按长期要求续写
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setShowContinueDialog(false)
                  void aiGenerate(tempContextInput)
                }}
              >
                带临时要求续写
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {alertInfo ? (
        <AlertDialog
          open={true}
          message={alertInfo.message}
          onConfirm={() => setAlertInfo(null)}
        />
      ) : null}
    </div>
  )
}

function renderMarkdownPreview(text: string) {
  if (!text.trim()) return <span className="muted">暂无内容排版预览。</span>
  const paragraphs = text.split(/\n+/)
  return paragraphs.map((p, index) => {
    const trimmed = p.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('### ')) return <h3 key={index} style={{ margin: '14px 0 6px 0', fontSize: '14.5px', fontWeight: 700 }}>{trimmed.slice(4)}</h3>
    if (trimmed.startsWith('## ')) return <h2 key={index} style={{ margin: '18px 0 8px 0', fontSize: '16px', fontWeight: 700 }}>{trimmed.slice(3)}</h2>
    if (trimmed.startsWith('# ')) return <h1 key={index} style={{ margin: '22px 0 10px 0', fontSize: '18px', fontWeight: 700 }}>{trimmed.slice(2)}</h1>
    if (trimmed === '***' || trimmed === '---' || trimmed === '___') return <hr key={index} style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '16px 0' }} />
    
    const parts: React.ReactNode[] = []
    const boldRegex = /\*\*(.*?)\*\*/g
    let lastIdx = 0
    let m: RegExpExecArray | null
    while ((m = boldRegex.exec(trimmed)) !== null) {
      if (m.index > lastIdx) parts.push(trimmed.slice(lastIdx, m.index))
      parts.push(<strong key={m.index}>{m[1]}</strong>)
      lastIdx = boldRegex.lastIndex
    }
    if (lastIdx < trimmed.length) parts.push(trimmed.slice(lastIdx))

    return (
      <p key={index} className="preview-paragraph" style={{ textIndent: '2em', margin: '0 0 16px 0', textAlign: 'justify' }}>
        {parts.length > 0 ? parts : trimmed}
      </p>
    )
  })
}

function OutlineDetailField({ row }: { row: { label: string; value?: string; items?: string[] } }) {
  // 角色出场用横排标签展示，其余列表字段保持竖排
  const isInline = row.label === '角色出场'
  return (
    <section className="outline-detail-field">
      <div className="outline-detail-label">{row.label}</div>
      {row.value ? <div className="outline-detail-value">{row.value}</div> : null}
      {row.items && row.items.length > 0 ? (
        isInline ? (
          <div className="outline-detail-inline">
            {row.items.map((item) => (
              <span key={item} className="outline-chip">
                {item}
              </span>
            ))}
          </div>
        ) : (
          <ul className="outline-detail-list">
            {row.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}

function ReminderGroup({
  title,
  items,
  tone,
  onDismiss
}: {
  title: string
  items: ForeshadowingReminderItem[]
  tone: 'hook' | 'cool' | 'emotion'
  onDismiss?: (item: ForeshadowingReminderItem) => void
}) {
  return (
    <div className="outline-tags">
      <span className={`outline-tag ${tone}`}>{title}</span>
      {items.map((item) => (
        <span key={item.id ?? item.content} className="outline-tag reminder-tag">
          <span className="reminder-tag-text">{item.content}</span>
          {onDismiss ? (
            <button
              type="button"
              className="reminder-dismiss"
              title="忽略这条提示"
              onClick={(e) => {
                e.stopPropagation()
                onDismiss(item)
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </div>
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
        <div className="stat-cell" title="按普通小说平均速度 400字/分钟 估算">
          <div className="label">阅读时间</div>
          <div className="val">{Math.ceil(stats.wordCount / 400)}</div>
          <div className="sub">分钟 (估算)</div>
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
          <div className="sub">按引号内台词字数</div>
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

/* =========================================================
   正文追问 聊天对话框
   ========================================================= */

interface AskMessage {
  role: 'user' | 'assistant'
  text: string
}

interface AskChatDialogProps {
  messages: AskMessage[]
  asking: boolean
  question: string
  onQuestionChange: (v: string) => void
  onSubmit: () => void
  onClose: () => void
  onClear: () => void
}

/**
 * 把 AI 作答文本渲染为简易 markdown（标题/列表/加粗/段落）。
 * 与 renderMarkdownPreview 不同：面向分析文本，不做正文首行缩进。
 */
function renderAnswerText(text: string): React.ReactNode {
  if (!text.trim()) return null
  const lines = text.split(/\r?\n/)
  const out: React.ReactNode[] = []
  let listBuffer: string[] = []
  const flushList = (key: string) => {
    if (listBuffer.length === 0) return
    out.push(
      <ul key={key} style={{ margin: '4px 0 8px 0', paddingLeft: 20 }}>
        {listBuffer.map((li, i) => (
          <li key={i} style={{ margin: '2px 0' }}>{renderInline(li)}</li>
        ))}
      </ul>
    )
    listBuffer = []
  }
  // 内联加粗 + 行内代码
  function renderInline(s: string): React.ReactNode {
    const parts: React.ReactNode[] = []
    const regex = /\*\*(.+?)\*\*|`([^`]+)`/g
    let lastIdx = 0
    let m: RegExpExecArray | null
    let k = 0
    while ((m = regex.exec(s)) !== null) {
      if (m.index > lastIdx) parts.push(s.slice(lastIdx, m.index))
      if (m[1] !== undefined) parts.push(<strong key={k++}>{m[1]}</strong>)
      else if (m[2] !== undefined) parts.push(<code key={k++} style={{ background: 'var(--surface)', padding: '0 3px', borderRadius: 3, fontSize: 12 }}>{m[2]}</code>)
      lastIdx = regex.lastIndex
    }
    if (lastIdx < s.length) parts.push(s.slice(lastIdx))
    return parts.length > 0 ? parts : s
  }
  lines.forEach((raw, i) => {
    const line = raw
    const trimmed = line.trim()
    if (trimmed.startsWith('### ')) {
      flushList(`l-${i}`)
      out.push(<h4 key={i} style={{ margin: '14px 0 8px 0', fontSize: 14.5, fontWeight: 700 }}>{renderInline(trimmed.slice(4))}</h4>)
    } else if (trimmed.startsWith('## ')) {
      flushList(`l-${i}`)
      out.push(<h3 key={i} style={{ margin: '16px 0 8px 0', fontSize: 15.5, fontWeight: 700 }}>{renderInline(trimmed.slice(3))}</h3>)
    } else if (trimmed.startsWith('# ')) {
      flushList(`l-${i}`)
      out.push(<h2 key={i} style={{ margin: '18px 0 10px 0', fontSize: 16.5, fontWeight: 700 }}>{renderInline(trimmed.slice(2))}</h2>)
    } else if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      flushList(`l-${i}`)
      out.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '10px 0' }} />)
    } else if (/^[-•*]\s+/.test(trimmed)) {
      listBuffer.push(trimmed.replace(/^[-•*]\s+/, ''))
    } else if (/^\d+[.、)]\s+/.test(trimmed)) {
      // 数字列表按段落处理（简单合并为有序感）
      flushList(`l-${i}`)
      out.push(<p key={i} style={{ margin: '0 0 8px 0', lineHeight: 1.7 }}>{renderInline(trimmed)}</p>)
    } else if (trimmed === '') {
      flushList(`l-${i}`)
      // 空行：跳过（段落间距由 margin 提供）
    } else {
      flushList(`l-${i}`)
      out.push(<p key={i} style={{ margin: '0 0 8px 0', lineHeight: 1.7 }}>{renderInline(trimmed)}</p>)
    }
  })
  flushList('l-end')
  return out
}

function AskChatDialog({
  messages,
  asking,
  question,
  onQuestionChange,
  onSubmit,
  onClose,
  onClear
}: AskChatDialogProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 新消息 / 流式追加时滚动到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // 对话框挂载时自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Ctrl/Cmd/Shift+Enter 换行
    if (e.key === 'Enter') {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        // 如果是 Ctrl/Cmd+Enter，手动插入换行符以确保在所有平台都换行
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const textarea = e.currentTarget
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const value = textarea.value
          const newValue = value.substring(0, start) + '\n' + value.substring(end)
          onQuestionChange(newValue)
          requestAnimationFrame(() => {
            if (textarea) {
              textarea.selectionStart = textarea.selectionEnd = start + 1
            }
          })
        }
      } else {
        e.preventDefault()
        if (!asking && question.trim()) onSubmit()
      }
    }
  }

  const canSubmit = !asking && question.trim().length > 0

  return (
    <div
      className="dialog-overlay"
      onClick={() => {
        if (!asking) onClose()
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
    >
      <div
        className="dialog-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 1000,
          maxWidth: '96vw',
          height: 760,
          maxHeight: '94vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-md)',
          boxShadow: 'var(--shadow-lg)'
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
          <strong style={{ fontSize: 16.5 }}>💬 正文追问</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            {messages.length > 0 && !asking ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={onClear}
                title="清空对话历史，重新开始追问"
              >
                清空对话
              </button>
            ) : null}
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={asking}>
              关闭
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 20
          }}
        >
          {messages.length === 0 ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14, maxWidth: 560 }}>
              <p style={{ margin: '0 0 12px 0' }}>
                就当前正文向 AI 提问。它具备全书视野：总纲与章目录摘要、相邻章正文、设定/追踪，以及本章正文与细纲、人物、伏笔。
              </p>
              <p style={{ margin: 0, opacity: 0.85 }}>
                例如：「和前后章衔接自然吗」「这段人物动机合理吗」「伏笔前面埋过吗」「节奏是不是太拖」。
              </p>
              <p style={{ margin: '12px 0 0 0', opacity: 0.7 }}>只回答，不改正文。支持多轮追问。</p>
            </div>
          ) : null}

          {messages.map((m, idx) => {
            const isUser = m.role === 'user'
            const isStreaming = asking && !isUser && idx === messages.length - 1
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  justifyContent: isUser ? 'flex-end' : 'flex-start'
                }}
              >
                <div
                  style={{
                    maxWidth: '80%',
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: isUser ? 'var(--accent)' : 'var(--surface)',
                    color: isUser ? '#fff' : 'var(--ink)',
                    border: isUser ? 'none' : '1px solid var(--line)',
                    fontSize: 14,
                    lineHeight: 1.6,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {isUser ? (
                    m.text
                  ) : (
                    <>
                      {m.text ? renderAnswerText(m.text) : null}
                      {isStreaming ? (
                        <span style={{ opacity: 0.6 }}>
                          {m.text ? '' : '思考中…'}
                          <span className="ask-cursor">▋</span>
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <footer
          style={{
            borderTop: '1px solid var(--line)',
            padding: '16px 24px',
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end'
          }}
        >
          <textarea
            ref={inputRef}
            className="textarea"
            placeholder="写下你的问题，Enter 发送，Ctrl+Enter 换行…"
            value={question}
            onChange={(e) => onQuestionChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={asking}
            style={{
              flex: 1,
              minHeight: 80,
              maxHeight: 240,
              resize: 'none',
              fontSize: 14,
              padding: '12px 14px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              color: 'var(--ink)'
            }}
          />
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={!canSubmit}
            title="Enter 发送，Ctrl+Enter 换行"
          >
            {asking ? '回答中…' : '提问'}
          </button>
        </footer>
      </div>
    </div>
  )
}
