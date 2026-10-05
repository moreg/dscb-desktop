import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { StreamHandle } from '../../shared/types'
import { adoptShortStoryCandidate, shortStoryCandidateSource, type ShortStoryCandidate as Candidate } from './short-story-candidate'
import ShortStoryCandidateStatus, { friendlyShortStoryGenerationError } from './ShortStoryCandidateStatus'
import ShortStoryBrainstorm from './ShortStoryBrainstorm'
import { transferShortStoryBrainstormRecovery } from './short-story-brainstorm-library'
import {
  adoptShortStoryCreateIdea,
  clearShortStoryCreateDraft,
  completeShortStoryCreateDraft,
  editShortStoryCreateDraft,
  newShortStoryCreateDraft,
  readLatestShortStoryCreateDraft,
  readShortStoryCreateDraft,
  sameShortStoryCreateDraftVersion,
  shortStoryCreateDraftText,
  writeShortStoryCreateDraft,
  type ShortStoryCreateDraft
} from './short-story-create-draft'
import {
  SHORT_STORY_PRESETS,
  shortStoryConfigError,
  shortStorySectionBudgets,
  shortStorySummary,
  shortStoryWordCount,
  shortStoryIdeaBrief
} from '../../shared/short-story'
import type {
  ShortStoryCreateInput,
  ShortStoryDocument,
  ShortStoryKind,
  ShortStoryIdea,
  ShortStorySummary,
  ShortStoryTask
} from '../../shared/short-story'
import './short-story.css'

type WorkspaceTab = 'setup' | 'outline' | 'sections' | 'review'
interface Recovery {
  story: ShortStoryDocument
  targetWords: string
  sectionCount: string
  candidate: Candidate | null
}
interface ConflictRecovery extends Recovery { savedAt: string }

const TASK_LABELS: Record<ShortStoryTask, string> = { outline: '大纲', section: '正文', review: '完结检查', revise: '修订正文' }
const TAB_LABELS: Record<WorkspaceTab, string> = { setup: '作品设定', outline: '全文大纲', sections: '分节正文', review: '完结检查' }
const RECOVERY_PREFIX = 'ai-writer:short-story:recovery:'
const CONFLICT_PREFIX = 'ai-writer:short-story:conflicts:'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validRecovery(value: Recovery, id: string): boolean {
    const story = value?.story
    if (!story || story.id !== id || !Number.isInteger(story.revision) ||
      typeof story.sourceFingerprint !== 'string' || !['short', 'medium'].includes(story.kind) ||
      !Number.isInteger(story.targetWords) || story.targetWords < 1000 || story.targetWords > 120000 ||
      !Number.isInteger(story.sectionCount) || story.sectionCount < 1 || story.sectionCount > 60 ||
      !Array.isArray(story.sections) || typeof story.outline !== 'string' || typeof story.review !== 'string' ||
      typeof story.title !== 'string' || typeof story.brief !== 'string' || typeof story.requirements !== 'string' ||
      typeof story.genre !== 'string' || typeof value.targetWords !== 'string' || typeof value.sectionCount !== 'string' ||
      story.sections.length !== story.sectionCount ||
      story.sections.some((section, index) => !section || section.number !== index + 1 || typeof section.title !== 'string' || typeof section.content !== 'string')) return false
    if (value.candidate && (!['outline', 'section', 'review', 'revise'].includes(value.candidate.task) ||
      typeof value.candidate.text !== 'string' || typeof value.candidate.source !== 'string')) value.candidate = null
    if (value.candidate?.task === 'revise' && (!Number.isInteger(value.candidate.sectionNumber) ||
      !story.sections.some(section => section.number === value.candidate?.sectionNumber) || value.candidate.append !== false ||
      !['generating', 'completed', 'stopped', 'failed'].includes(value.candidate.status))) {
      value.candidate.status = 'failed'
      value.candidate.append = false
      value.candidate.error = '恢复的修订候选信息不完整，请重新修订；原稿仍保留。'
    }
    if (value.candidate && typeof value.candidate.error !== 'string') delete value.candidate.error
    if (value.candidate && (typeof value.candidate.instruction !== 'string' || value.candidate.instruction.length > 10000)) delete value.candidate.instruction
    if (value.candidate?.status === 'generating') {
      value.candidate.status = 'stopped'
      value.candidate.error = '上次生成因离开页面而中断，当前没有后台生成任务，请重新发起。'
    }
    return true
}

function readRecovery(id: string): Recovery | null {
  try {
    const raw = window.localStorage.getItem(RECOVERY_PREFIX + id)
    if (!raw) return null
    const value = JSON.parse(raw) as Recovery
    return validRecovery(value, id) ? value : null
  } catch { return null }
}

function readConflicts(id: string): ConflictRecovery[] {
  try {
    const raw = window.localStorage.getItem(CONFLICT_PREFIX + id)
    if (!raw) return []
    const values = JSON.parse(raw) as ConflictRecovery[]
    return Array.isArray(values) ? values.filter(value => validRecovery(value, id) && typeof value.savedAt === 'string') : []
  } catch { return [] }
}

function recoveryText(value: Recovery): string {
  const document = value.story
  return `# ${document.title}\n\n篇幅：${SHORT_STORY_PRESETS[document.kind].label}\n题材：${document.genre}\n全文目标：${value.targetWords} 字\n分节数：${value.sectionCount}\n\n## 梗概\n\n${document.brief}\n\n## 写作要求\n\n${document.requirements}\n\n## 全文大纲\n\n${document.outline}\n\n` +
    document.sections.map(item => `## 第 ${item.number} 节${item.title ? `：${item.title}` : ''}\n\n${item.content}`).join('\n\n') +
    `\n\n## 完结检查\n\n${document.review}` + (value.candidate ? `\n\n## 未采用的${TASK_LABELS[value.candidate.task]}候选\n\n${value.candidate.text}` : '')
}

function writeRecovery(value: Recovery | null, id: string): boolean {
  try {
    if (value) window.localStorage.setItem(RECOVERY_PREFIX + id, JSON.stringify(value))
    else window.localStorage.removeItem(RECOVERY_PREFIX + id)
    return true
  } catch { return false }
}

export default function ShortStoryPage(): React.ReactElement {
  const [stories, setStories] = useState<ShortStorySummary[]>([])
  const [story, setStory] = useState<ShortStoryDocument | null>(null)
  const [saved, setSaved] = useState('')
  const [targetWords, setTargetWords] = useState('')
  const [sectionCount, setSectionCount] = useState('')
  const [tab, setTab] = useState<WorkspaceTab>('setup')
  const [sectionNumber, setSectionNumber] = useState(1)
  const [instruction, setInstruction] = useState('')
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [creating, setCreating] = useState<ShortStoryCreateInput | null>(null)
  const [loading, setLoading] = useState(false)
  const [storiesLoading, setStoriesLoading] = useState(true)
  const [storageLocation, setStorageLocation] = useState<string | null>(null)
  const [storageLocationLoading, setStorageLocationLoading] = useState(true)
  const [storageChanging, setStorageChanging] = useState(false)
  const [storageLocationError, setStorageLocationError] = useState('')
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [preparingGeneration, setPreparingGeneration] = useState(false)
  const [generationStartError, setGenerationStartError] = useState('')
  const [brainstorming, setBrainstorming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [leaveDialog, setLeaveDialog] = useState(false)
  const [revisionConflict, setRevisionConflict] = useState(false)
  const [conflicts, setConflicts] = useState<ConflictRecovery[]>([])
  const [conflictIndex, setConflictIndex] = useState(0)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [recoveryError, setRecoveryError] = useState(false)
  const [createDraftWarning, setCreateDraftWarning] = useState('')
  const [createStorageError, setCreateStorageError] = useState('')
  const mounted = useRef(false)
  const requestRef = useRef<StreamHandle | null>(null)
  const runRef = useRef(0)
  const generationPendingRef = useRef(false)
  const stoppingRunRef = useRef<number | null>(null)
  const createDraftRef = useRef<ShortStoryCreateDraft | null>(null)
  const createDraftsRef = useRef<Partial<Record<ShortStoryKind, ShortStoryCreateDraft>>>({})
  const createUnsavedKindsRef = useRef(new Set<ShortStoryKind>())
  const createStorageProblemsRef = useRef(new Map<ShortStoryKind, string>())
  const createDraftTimerRef = useRef<number | null>(null)
  const recoveryRef = useRef<{ id: string; value: Recovery | null } | null>(null)
  const recoveryTimerRef = useRef<number | null>(null)
  const storageLocationRef = useRef<string | null>(null)
  const storageChangingRef = useRef(false)
  const locationRequestRef = useRef(0)
  const storiesRequestRef = useRef(0)
  const locationAppliedRef = useRef(0)
  const storageSelectionRequestRef = useRef(0)
  const lifecycleRef = useRef(0)

  const generationBlocked = loading || storiesLoading || storageLocationLoading || storageChanging || saving || preparingGeneration || generating || exporting
  const busy = generationBlocked || brainstorming
  const dirty = !!story && (JSON.stringify(story) !== saved || targetWords !== String(story.targetWords) || sectionCount !== String(story.sectionCount))
  const section = story?.sections.find(item => item.number === sectionNumber)
  const writtenWords = story?.sections.reduce((sum, item) => sum + shortStoryWordCount(item.content), 0) ?? 0
  const completedSections = story?.sections.filter(item => item.content.trim()).length ?? 0
  const budgets = story ? shortStorySectionBudgets(story.targetWords, story.sectionCount) : []
  const candidateStale = !!story && !!candidate && shortStoryCandidateSource(story, candidate.task) !== candidate.source
  const incompleteRevision = candidate?.task === 'revise' && candidate.status !== 'completed'
  const pendingBudget = !!story && (targetWords !== String(story.targetWords) || sectionCount !== String(story.sectionCount))
  const retryBlockedReason = busy ? (preparingGeneration ? '正在保存作品，请稍候。' : generating ? '当前生成任务尚未结束。' : '正在处理其他操作，请稍候。')
    : pendingBudget ? '篇幅设置尚未应用，请先应用并保存篇幅设置。'
    : candidate?.task === 'revise' && !story?.review.trim() ? '请重新检查全文并采用报告，再修订正文。'
    : candidate?.task === 'revise' && completedSections < (story?.sectionCount ?? 0) ? '请先完成所有分节的正文。' : ''
  recoveryRef.current = story ? { id: story.id, value: dirty || candidate ? { story, targetWords, sectionCount, candidate } : null } : null

  const refresh = useCallback(async (background = false): Promise<void> => {
    const request = ++storiesRequestRef.current
    if (!background) { setStoriesLoading(true); setError('') }
    try {
      const result = await window.api.listShortStories()
      if (mounted.current && storiesRequestRef.current === request) setStories(result)
    } catch (err) { if (mounted.current && storiesRequestRef.current === request) setError(`读取作品列表失败：${errorText(err)}`) }
    finally { if (mounted.current && storiesRequestRef.current === request) setStoriesLoading(false) }
  }, [])

  const applyStorageLocation = useCallback((path: string): boolean => {
    locationRequestRef.current += 1
    if (typeof path !== 'string' || !path.trim()) {
      setStorageLocationError('未能读取有效的保存位置，请重试或选择文件夹。')
      setStorageLocationLoading(false)
      return false
    }
    locationAppliedRef.current += 1
    storageLocationRef.current = path
    setStorageLocation(path); setStorageLocationError(''); setStorageLocationLoading(false)
    return true
  }, [])

  const readStorageLocation = useCallback(async (background = false): Promise<void> => {
    const request = ++locationRequestRef.current
    if (!background) { setStorageLocationLoading(true); setStorageLocationError('') }
    try {
      const path = await window.api.getShortStoryStorageLocation()
      if (!mounted.current || locationRequestRef.current !== request) return
      const changed = !!storageLocationRef.current && storageLocationRef.current !== path
      if (applyStorageLocation(path) && changed) void refresh(true)
    } catch (err) {
      if (mounted.current && locationRequestRef.current === request) setStorageLocationError(`读取保存位置失败：${errorText(err)}`)
    } finally {
      if (mounted.current && locationRequestRef.current === request) setStorageLocationLoading(false)
    }
  }, [applyStorageLocation, refresh])

  useEffect(() => {
    mounted.current = true
    lifecycleRef.current += 1
    storageChangingRef.current = false
    setStorageChanging(false)
    const restored = readLatestShortStoryCreateDraft()
    setCreateDraftWarning(restored.warning)
    if (restored.draft) {
      installCreateDraft(restored.draft)
      setMessage(`已恢复上次未完成的${SHORT_STORY_PRESETS[restored.draft.input.kind].label}新建表单。`)
    }
    const unsubscribeLocation = window.api.onShortStoryStorageLocationChanged(path => {
      if (mounted.current && applyStorageLocation(path)) void refresh(true)
    })
    void readStorageLocation()
    void refresh()
    const onFocus = () => { if (!storageChangingRef.current) void readStorageLocation(true) }
    window.addEventListener('focus', onFocus)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!flushCreateDrafts(false)) {
        event.preventDefault()
        event.returnValue = ''
      }
      const recovery = recoveryRef.current
      if (recovery?.value && !writeRecovery(recovery.value, recovery.id)) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      mounted.current = false
      lifecycleRef.current += 1
      storageSelectionRequestRef.current += 1
      storageChangingRef.current = false
      runRef.current += 1
      locationRequestRef.current += 1
      storiesRequestRef.current += 1
      unsubscribeLocation()
      window.removeEventListener('focus', onFocus)
      flushCreateDrafts(false)
      if (createDraftTimerRef.current !== null) window.clearTimeout(createDraftTimerRef.current)
      createDraftTimerRef.current = null
      const recovery = recoveryRef.current
      if (recovery) writeRecovery(recovery.value, recovery.id)
      if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
      void requestRef.current?.abort().catch(() => undefined)
      requestRef.current = null
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [applyStorageLocation, readStorageLocation, refresh])

  useEffect(() => {
    if (recoveryTimerRef.current !== null) return
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null
      const recovery = recoveryRef.current
      if (recovery && mounted.current) setRecoveryError(!writeRecovery(recovery.value, recovery.id))
    }, 500)
  }, [story, candidate, saved, targetWords, sectionCount])

  useEffect(() => {
    if (!createUnsavedKindsRef.current.size || createDraftTimerRef.current !== null) return
    createDraftTimerRef.current = window.setTimeout(() => {
      createDraftTimerRef.current = null
      flushCreateDrafts()
    }, 500)
  }, [creating])

  function installCreateDraft(draft: ShortStoryCreateDraft | null): void {
    // 与输入事件同步更新，卸载/切换时不依赖尚未提交的 React 状态。
    createDraftRef.current = draft
    if (draft) {
      createDraftsRef.current[draft.input.kind] = draft
      createUnsavedKindsRef.current.add(draft.input.kind)
    }
    setCreating(draft?.input ?? null)
  }

  function flushCreateDrafts(notify = true): boolean {
    let success = true
    for (const kind of createUnsavedKindsRef.current) {
      const draft = createDraftsRef.current[kind]
      if (!draft) { createUnsavedKindsRef.current.delete(kind); continue }
      const result = writeShortStoryCreateDraft(draft)
      if (result.ok) {
        createUnsavedKindsRef.current.delete(kind)
        createStorageProblemsRef.current.delete(kind)
      } else {
        success = false
        createStorageProblemsRef.current.set(kind, result.warning)
      }
    }
    if (notify && mounted.current) setCreateStorageError([...createStorageProblemsRef.current.values()].join(' '))
    return success
  }

  function updateCreating(changes: Partial<ShortStoryCreateInput>): void {
    const current = createDraftRef.current
    if (!current) return
    installCreateDraft(editShortStoryCreateDraft(current, changes))
    setError(''); setMessage('')
  }

  function startCreating(kind: ShortStoryKind): void {
    if (busy) return
    flushCreateDrafts()
    const cached = createDraftsRef.current[kind]
    const loaded = cached ? { draft: cached, warning: '' } : readShortStoryCreateDraft(kind)
    installCreateDraft({ ...(loaded.draft ?? newShortStoryCreateDraft(kind)), savedAt: Math.max(Date.now(), (loaded.draft?.savedAt ?? 0) + 1) })
    setCreateDraftWarning(loaded.warning); setError('')
    setMessage(loaded.draft ? `已恢复未完成的${SHORT_STORY_PRESETS[kind].label}新建表单。` : '')
  }

  function closeCreating(): void {
    if (busy) return
    const stored = flushCreateDrafts()
    installCreateDraft(null)
    setError('')
    setMessage(stored ? '新建草稿已保留，下次新建或重新进入栏目可继续填写。'
      : '表单已关闭，草稿仍保留在当前窗口。缓存无法写入，请先复制新建草稿。')
  }

  function discardCreating(): void {
    const current = createDraftRef.current
    if (!current || busy || !window.confirm('确定丢弃当前新建表单草稿？表单输入将清空，脑洞记录仍保留。')) return
    const result = clearShortStoryCreateDraft(current.input.kind)
    if (!result.ok) { setError(result.warning); return }
    delete createDraftsRef.current[current.input.kind]
    createUnsavedKindsRef.current.delete(current.input.kind)
    createStorageProblemsRef.current.delete(current.input.kind)
    installCreateDraft(null)
    setCreateStorageError([...createStorageProblemsRef.current.values()].join(' '))
    setCreateDraftWarning(''); setError(''); setMessage('该新建表单草稿已丢弃。')
  }

  async function copyCreateDraft(): Promise<void> {
    const current = createDraftRef.current ?? Object.values(createDraftsRef.current).sort((a, b) => b.savedAt - a.savedAt)[0]
    if (!current) return
    try {
      await navigator.clipboard.writeText(shortStoryCreateDraftText(current))
      if (mounted.current) setMessage('新建草稿已复制，包含作品名、篇幅设置、梗概与写作要求。')
    } catch (err) {
      if (mounted.current) setError(`无法自动复制，请重新打开新建表单后逐项选择文本复制：${errorText(err)}`)
    }
  }

  async function chooseStorageLocation(): Promise<void> {
    // 仅从列表切换；已打开作品的未保存稿由现有返回列表流程保留。
    if (story || busy || storageChangingRef.current) return
    const request = ++storageSelectionRequestRef.current
    const lifecycle = lifecycleRef.current
    const previousPath = storageLocationRef.current
    const appliedBeforeSelection = locationAppliedRef.current
    const isCurrent = () => mounted.current && lifecycleRef.current === lifecycle && storageSelectionRequestRef.current === request
    storageChangingRef.current = true
    locationRequestRef.current += 1
    setStorageChanging(true); setStorageLocationError('')
    try {
      const result = await window.api.chooseShortStoryStorageLocation()
      if (!isCurrent() || result.canceled) return
      // 广播代表已经生效的位置；较晚的其他窗口广播不能被旧选择回包覆盖。
      if (locationAppliedRef.current !== appliedBeforeSelection && storageLocationRef.current !== result.path) {
        await refresh(true)
        if (isCurrent()) setMessage('本次文件夹复制已完成。当前保存位置已由其他窗口更新，已同步最新路径。')
        return
      }
      if (!applyStorageLocation(result.path)) return
      await refresh()
      if (isCurrent()) setMessage(storageLocationRef.current !== result.path
        ? '本次文件夹复制已完成。当前保存位置已由其他窗口更新，已同步最新路径。'
        : previousPath === result.path && result.copiedCount === 0
          ? '保存位置已确认，现有文件保留。'
          : `保存位置已切换，已复制 ${result.copiedCount} 部作品及其历史版本。原文件保留。`)
    } catch (err) {
      if (isCurrent()) setStorageLocationError(`选择保存文件夹失败：${errorText(err)}`)
    } finally {
      if (isCurrent()) { storageChangingRef.current = false; setStorageChanging(false) }
    }
  }

  async function copyStorageLocation(): Promise<void> {
    if (!storageLocation) return
    try {
      await navigator.clipboard.writeText(storageLocation)
      if (mounted.current) setMessage('保存位置已复制。')
    } catch (err) {
      if (mounted.current) setStorageLocationError(`无法自动复制路径，可直接选择下方路径文字手动复制：${errorText(err)}`)
    }
  }

  function installStory(document: ShortStoryDocument): void {
    const recovery = readRecovery(document.id)
    setSaved(JSON.stringify(document))
    setStory(recovery?.story ?? document)
    setTargetWords(recovery?.targetWords ?? String(document.targetWords))
    setSectionCount(recovery?.sectionCount ?? String(document.sectionCount))
    setCandidate(recovery?.candidate ?? null)
    setSectionNumber(1); setTab('setup'); setInstruction(''); installCreateDraft(null)
    setRecoveryError(false)
    const conflict = !!recovery && (recovery.story.revision !== document.revision || recovery.story.sourceFingerprint !== document.sourceFingerprint)
    setRevisionConflict(conflict)
    setConflicts(readConflicts(document.id)); setConflictIndex(0)
    if (recovery) {
      setMessage(!conflict
        ? '已恢复上次未保存的稿件与生成候选，请检查后保存。'
        : '本地恢复稿已保留。已保存版本有更新，直接保存会提示冲突；可以复制当前草稿，或重新读取已保存版本。')
    } else setMessage('')
  }

  async function openStory(id: string): Promise<void> {
    if (busy) return
    // 新建缓存不可用时仍可打开已有作品，未写入的表单继续留在当前窗口缓存中。
    flushCreateDrafts()
    setLoading(true); setError(''); setMessage('')
    try {
      const document = await window.api.getShortStory(id)
      if (mounted.current) installStory(document)
    } catch (err) { if (mounted.current) setError(`打开作品失败：${errorText(err)}`) }
    finally { if (mounted.current) setLoading(false) }
  }

  function updateStory(changes: Partial<ShortStoryDocument>, preserveReview = false): void {
    setStory(current => current ? { ...current, ...changes, ...(preserveReview ? {} : { review: '' }) } : null)
    setMessage(''); setError('')
  }

  function adoptIdea(idea: ShortStoryIdea, forCreation: boolean): boolean {
    const brief = shortStoryIdeaBrief(idea)
    const draft = createDraftRef.current
    if ((forCreation && !draft) || (!forCreation && !story)) return false
    const currentBrief = forCreation ? draft?.input.brief : story?.brief
    if (currentBrief?.trim() && !window.confirm('采用这个脑洞将替换当前故事梗概，是否继续？')) return false
    if (forCreation) {
      if (!draft) return false
      installCreateDraft(adoptShortStoryCreateIdea(draft, idea, brief))
      setError(''); setMessage('脑洞已填入故事梗概，可以继续修改并创建作品。')
    } else if (story) {
      updateStory({ brief })
      setMessage(story.outline.trim() || story.sections.some(item => item.content.trim())
        ? '脑洞已填入故事梗概。请核对现有大纲和正文，再保存作品。'
        : '脑洞已填入故事梗概。保存作品后，可继续生成全文大纲。')
    }
    return true
  }

  /** 数字暂存为字符串，允许用户清空重填；应用时再验证并调整分节。 */
  function configuredStory(): ShortStoryDocument | null {
    if (!story) return null
    const next = { ...story, targetWords: Number(targetWords), sectionCount: Number(sectionCount) }
    const validation = shortStoryConfigError(next)
    if (validation) { setError(validation); return null }
    if (next.sectionCount < story.sections.length && story.sections.slice(next.sectionCount).some(item => item.content.trim())) {
      setError('要减少的末尾分节已有正文，请保留这些分节，或先另存正文后手动清空。当前稿件未改动。')
      return null
    }
    next.sections = Array.from({ length: next.sectionCount }, (_, index) => story.sections[index] ?? { number: index + 1, title: '', content: '' })
    if (pendingBudget) next.review = ''
    return next
  }

  function applyBudget(): void {
    const next = configuredStory()
    if (!next) return
    updateStory(next)
    setTargetWords(String(next.targetWords)); setSectionCount(String(next.sectionCount))
    setSectionNumber(current => Math.min(current, next.sectionCount))
    setMessage('篇幅设置已应用，点击“保存作品”写入文件。')
  }

  async function saveCurrent(onFailure?: (message: string) => void): Promise<ShortStoryDocument | null> {
    const next = configuredStory()
    if (!next) { onFailure?.('无法保存作品，请核对作品设定和篇幅设置后重试。'); return null }
    setSaving(true); setError(''); setMessage('')
    try {
      const document = await window.api.saveShortStory(next)
      if (!mounted.current) return null
      setStory(document); setSaved(JSON.stringify(document))
      setTargetWords(String(document.targetWords)); setSectionCount(String(document.sectionCount))
      setSectionNumber(current => Math.min(current, document.sectionCount))
      setStories(current => [shortStorySummary(document), ...current.filter(item => item.id !== document.id)])
      const recovery = candidate ? { story: document, targetWords: String(document.targetWords), sectionCount: String(document.sectionCount), candidate } : null
      writeRecovery(recovery, document.id)
      recoveryRef.current = { id: document.id, value: recovery }
      setRevisionConflict(false)
      setMessage('作品已保存。')
      return document
    } catch (err) {
      if (mounted.current) {
        const failure = `保存失败，当前稿件仍保留：${errorText(err)}`
        setError(failure); onFailure?.(failure)
        if (/冲突|更新|revision|版本|conflict|外部修改|重新载入/i.test(errorText(err))) setRevisionConflict(true)
      }
      return null
    } finally { if (mounted.current) setSaving(false) }
  }

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault()
    const submitted = createDraftRef.current
    if (!submitted || busy) return
    if (!storageLocation) { setError('请先读取或选择中短篇保存位置，再创建作品。'); return }
    const validation = shortStoryConfigError(submitted.input)
    if (validation) { setError(validation); return }
    flushCreateDrafts()
    setSaving(true); setError('')
    try {
      const document = await window.api.createShortStory(submitted.input)
      // 完成创建后先处理缓存与同步 ref，再判断页面是否已卸载；不能让卸载重新写回旧表单。
      const cleaned = completeShortStoryCreateDraft(submitted.input.kind, document.id, undefined, submitted)
      const cached = createDraftsRef.current[submitted.input.kind]
      if (cached && sameShortStoryCreateDraftVersion(cached, submitted)) {
        delete createDraftsRef.current[submitted.input.kind]
        createUnsavedKindsRef.current.delete(submitted.input.kind)
        createStorageProblemsRef.current.delete(submitted.input.kind)
      }
      if (createDraftRef.current && sameShortStoryCreateDraftVersion(createDraftRef.current, submitted)) createDraftRef.current = null
      const movedBrainstorm = submitted.input.kind !== 'short' ||
        (!cleaned.preservedNewerDraft && transferShortStoryBrainstormRecovery('new-short-story', document.id))
      if (!mounted.current) return
      installStory(document)
      setStories(current => [shortStorySummary(document), ...current])
      setCreateStorageError([...createStorageProblemsRef.current.values()].join(' '))
      setCreateDraftWarning('')
      const brainstormNotice = movedBrainstorm ? '' : cleaned.preservedNewerDraft
        ? '较新的新建草稿已保留，脑洞记录仍留在新建短篇的脑洞库。'
        : '作品已创建，但脑洞记录迁移失败；旧记录仍保留在新建短篇的脑洞库，请勿重复创建。'
      setError([cleaned.warning, brainstormNotice].filter(Boolean).join(' '))
      setMessage('作品已创建。先完善设定，再生成全文大纲。')
    } catch (err) { if (mounted.current) setError(`创建作品失败，新建草稿仍保留：${errorText(err)}`) }
    finally { if (mounted.current) setSaving(false) }
  }

  async function generate(task: ShortStoryTask, requestedSectionNumber = sectionNumber, requestedInstruction = instruction): Promise<void> {
    if (!story || busy || generationPendingRef.current) return
    const rejectStart = (message: string) => { setError(message); setGenerationStartError(message) }
    if ((task === 'section' || task === 'revise') && !story.sections.some(item => item.number === requestedSectionNumber)) {
      rejectStart('生成目标分节无效，请重新选择分节。'); return
    }
    if (task === 'section' && !story.outline.trim()) { rejectStart('请先填写或生成全文大纲，再写分节正文。'); return }
    if ((task === 'review' || task === 'revise') && story.sections.some(item => !item.content.trim())) {
      rejectStart('尚有空白分节，请完成所有节的正文后再检查全文。'); return
    }
    if (task === 'revise' && !story.review.trim()) { rejectStart('请先检查全文并采用检查报告，再按检查结果修订。'); return }
    if (candidate?.text.trim() && !window.confirm('当前生成候选尚未采用。确定用新的生成结果替换此候选？')) return
    const currentRun = ++runRef.current
    generationPendingRef.current = true
    setPreparingGeneration(true); setGenerationStartError(''); setError(''); setMessage('')
    let generationStarted = false
    try {
      const document = await saveCurrent(setGenerationStartError)
      if (!document || !mounted.current || runRef.current !== currentRun) return
      if ((task === 'review' || task === 'revise') && document.sections.some(item => !item.content.trim())) { rejectStart('尚有空白分节，请完成所有节的正文后再检查全文。'); return }
      if (task === 'revise' && !document.review.trim()) { rejectStart('原稿或篇幅设置已变化，请重新检查全文并采用报告后再修订。'); return }
      const next: Candidate = {
        task, sectionNumber: task === 'section' || task === 'revise' ? requestedSectionNumber : undefined,
        append: task === 'section' && !!document.sections.find(item => item.number === requestedSectionNumber)?.content.trim(),
        text: '', status: 'generating', source: shortStoryCandidateSource(document, task), instruction: requestedInstruction
      }
      if (task === 'revise' || task === 'section') { setTab('sections'); setSectionNumber(requestedSectionNumber) }
      else setTab(task)
      generationStarted = true
      setCandidate(next); setPreparingGeneration(false); setGenerating(true); setMessage('')
      const handle = window.api.generateShortStory({ story: document, task, sectionNumber: next.sectionNumber, instruction: requestedInstruction }, (token, done) => {
        if (!mounted.current || runRef.current !== currentRun) return
        if (!done && token) setCandidate(current => current ? { ...current, text: current.text + token } : current)
      })
      requestRef.current = handle
      const response = await handle
      if (!mounted.current || runRef.current !== currentRun) return
      const aborted = !response.ok && /\bLLM_ABORTED\b/.test(response.error ?? '')
      const failure = response.error || '未收到成功结果，请检查模型设置后重试。'
      setCandidate(current => current ? { ...current, status: response.ok ? 'completed' : aborted ? 'stopped' : 'failed', error: response.ok || aborted ? undefined : failure } : current)
      if (response.ok) setMessage(`${TASK_LABELS[task]}候选已生成。检查并采用后，点击“保存作品”。`)
      else if (aborted) setMessage('生成已停止，原稿与已收到的候选仍保留。')
      else setError(`生成失败，原稿与已收到的候选仍保留：${friendlyShortStoryGenerationError(failure)}`)
    } catch (err) {
      if (!mounted.current || runRef.current !== currentRun) return
      const failure = errorText(err)
      const aborted = /\bLLM_ABORTED\b/.test(failure)
      if (generationStarted) setCandidate(current => current ? { ...current, status: aborted ? 'stopped' : 'failed', error: aborted ? undefined : failure } : current)
      else setGenerationStartError(friendlyShortStoryGenerationError(failure))
      if (aborted) setMessage('生成已停止，原稿与已收到的候选仍保留。')
      else setError(`生成失败，原稿与已收到的候选仍保留：${friendlyShortStoryGenerationError(failure)}`)
    } finally {
      if (mounted.current && runRef.current === currentRun) { generationPendingRef.current = false; requestRef.current = null; setPreparingGeneration(false); setGenerating(false) }
    }
  }

  async function stop(): Promise<void> {
    const handle = requestRef.current
    if (!handle || stopping) return
    const requestRun = runRef.current
    stoppingRunRef.current = requestRun
    setStopping(true)
    try {
      const result = await handle.abort()
      if (!mounted.current || runRef.current !== requestRun || requestRef.current !== handle) return
      if (!result.ok) { setError('暂时无法停止生成，请稍后重试。'); return }
      runRef.current += 1; generationPendingRef.current = false; requestRef.current = null; setGenerating(false)
      setCandidate(current => current ? { ...current, status: 'stopped', error: undefined } : current)
      const recovery = recoveryRef.current
      if (recovery) setRecoveryError(!writeRecovery(recovery.value, recovery.id))
      setMessage('生成已停止，原稿未改动，已收到的文本保留在候选区。')
    } catch (err) { if (mounted.current && runRef.current === requestRun && requestRef.current === handle) setError(`停止失败：${errorText(err)}`) }
    finally { if (mounted.current && stoppingRunRef.current === requestRun) { stoppingRunRef.current = null; setStopping(false) } }
  }

  function adoptCandidate(): void {
    if (!story || !candidate || busy || !candidate.text.trim()) return
    if (candidateStale || pendingBudget) { setError('作品内容或篇幅设置已变化，请重新生成，或复制候选自行编辑。'); return }
    try { updateStory(adoptShortStoryCandidate(story, candidate), true) }
    catch (err) { setError(errorText(err)); return }
    setTab(candidate.task === 'section' || candidate.task === 'revise' ? 'sections' : candidate.task)
    if (candidate.sectionNumber) setSectionNumber(candidate.sectionNumber)
    setCandidate(null); setMessage(candidate.task === 'revise'
      ? `第 ${candidate.sectionNumber} 节已替换为修订稿。点击“保存作品”，再到“完结检查”重新检查全文。`
      : '候选已采用为可编辑稿件，点击“保存作品”写入文件。')
  }

  async function exportStory(): Promise<void> {
    if (!story || busy) return
    const document = await saveCurrent()
    if (!document || !mounted.current) return
    setExporting(true); setError('')
    try {
      const result = await window.api.exportShortStory(document.id)
      if (mounted.current) setMessage(result.canceled ? '已取消导出，作品已保存。' : `全文已导出${result.path ? `：${result.path}` : '。'}`)
    } catch (err) { if (mounted.current) setError(`导出失败：${errorText(err)}`) }
    finally { if (mounted.current) setExporting(false) }
  }

  async function openDirectory(id = story?.id): Promise<void> {
    if (!id || busy) return
    setError('')
    try {
      const result = await window.api.openShortStoryDirectory(id)
      if (!result.ok && mounted.current) setError('无法打开作品文件夹。')
    } catch (err) { if (mounted.current) setError(`打开文件夹失败：${errorText(err)}`) }
  }

  async function copyRecovery(value: Recovery): Promise<void> {
    try {
      await navigator.clipboard.writeText(recoveryText(value))
      if (mounted.current) setMessage('草稿全文与未采用候选已复制。')
    } catch (err) { if (mounted.current) setError(`无法自动复制，请在编辑区选择文本手动复制：${errorText(err)}`) }
  }

  async function reloadSaved(): Promise<void> {
    if (!story || busy) return
    setLoading(true); setError('')
    try {
      const document = await window.api.getShortStory(story.id)
      if (!mounted.current) return
      const backup: ConflictRecovery = { story, targetWords, sectionCount, candidate, savedAt: new Date().toISOString() }
      const backups = [backup, ...readConflicts(story.id)]
      try { window.localStorage.setItem(CONFLICT_PREFIX + story.id, JSON.stringify(backups)) }
      catch { setError('无法保留冲突恢复稿，当前草稿仍在编辑区。请先复制草稿后再重试。'); return }
      if (!writeRecovery(null, story.id)) { setError('无法清理当前恢复记录，原草稿仍保留，请稍后重试。'); return }
      installStory(document)
      recoveryRef.current = null
      setMessage('已读取最新保存版本。原草稿与候选保留在下方“冲突恢复稿”，可查看并复制。')
    } catch (err) { if (mounted.current) setError(`读取已保存版本失败，当前草稿仍保留：${errorText(err)}`) }
    finally { if (mounted.current) setLoading(false) }
  }

  function returnToList(): void {
    if (busy) return
    if (dirty) { setLeaveDialog(true); return }
    leaveWorkspace()
  }

  function leaveWorkspace(): void {
    const recovery = recoveryRef.current
    if (recovery && !writeRecovery(recovery.value, recovery.id)) {
      setError('无法保留恢复稿，请先保存作品或复制未保存的内容。'); return
    }
    setStory(null); setCandidate(null); setLeaveDialog(false); setError('')
    setMessage(recovery?.value ? '未保存稿件和候选已保留，再次打开作品即可恢复。' : '')
    recoveryRef.current = null
  }

  async function saveAndLeave(): Promise<void> {
    const document = await saveCurrent()
    if (!document) { setLeaveDialog(false); return }
    setStory(null); setCandidate(null); setLeaveDialog(false); recoveryRef.current = null
  }

  const notices = <>
    {error && <p className="ss-notice ss-error" role="alert">{error}</p>}
    {message && <p className="ss-notice ss-success" role="status">{message}</p>}
    {recoveryError && <p className="ss-notice ss-error" role="alert">无法写入本地恢复稿，请及时保存作品；离开栏目之前请复制未保存的候选文本。</p>}
    {createDraftWarning && <p className="ss-notice ss-error" role="alert">{createDraftWarning}</p>}
    {createStorageError && <p className="ss-notice ss-error" role="alert">{createStorageError}</p>}
  </>

  const storagePanel = <section className="ss-storage-location" aria-label="中短篇保存位置" aria-busy={storageLocationLoading || storageChanging}>
    <div className="ss-storage-location-main"><strong>保存位置</strong>{storageLocationLoading ? <p className="muted" role="status">正在读取保存位置…</p>
      : storageLocation ? <code className="ss-storage-location-path">{storageLocation}</code> : <p className="muted">尚未读取保存位置</p>}
      <p className="ss-storage-location-help">所有中短篇作品共用此文件夹。切换时复制已有作品及历史版本，原文件保留。{story ? ' 返回作品列表后可选择文件夹。' : ''}</p>
    </div>
    <div className="ss-actions ss-storage-location-actions"><button className="btn btn-sm" type="button" disabled={!storageLocation || storageLocationLoading || storageChanging} onClick={() => void copyStorageLocation()}>复制路径</button>{!story && <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void chooseStorageLocation()}>{storageChanging ? '正在切换…' : '选择文件夹'}</button>}{storageLocationError && <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void readStorageLocation()}>重新读取</button>}</div>
    {storageLocationError && <p className="ss-storage-location-error" role="alert">{storageLocationError}</p>}
    {storageChanging && <p className="ss-storage-location-help" role="status">正在选择或复制保存文件夹，请稍候…</p>}
  </section>

  if (!story) return <div className="short-story-page">
    <div className="page-head page-head-row">
      <div><h1>中短篇</h1><p className="desc">围绕完整故事写作：设定、大纲、分节正文与完结检查。</p></div>
      <div className="ss-actions">
        {(creating || createStorageError) && <button className="btn" disabled={saving} onClick={() => void copyCreateDraft()}>复制新建草稿</button>}
        <button className="btn" disabled={busy} onClick={() => startCreating('short')}>新建短篇</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => startCreating('medium')}>新建中篇</button>
      </div>
    </div>
    {storagePanel}
    {notices}
    {creating && <form className="card ss-create" onSubmit={event => void create(event)}>
      <h2>新建{SHORT_STORY_PRESETS[creating.kind].label}</h2>
      <p className="ss-create-location">本作品保存到中短篇共用文件夹：{storageLocation ? <code>{storageLocation}</code> : <span>读取或选择保存位置后可创建作品。</span>}</p>
      <fieldset disabled={busy}>
        <div className="ss-field-grid">
          <div className="field"><label htmlFor="ss-new-title">作品名</label><input id="ss-new-title" className="input" required maxLength={120} autoFocus value={creating.title} onChange={event => updateCreating({ title: event.target.value })} /></div>
          <div className="field"><label htmlFor="ss-new-genre">题材</label><input id="ss-new-genre" className="input" placeholder="例如悬疑、现实、言情" maxLength={200} value={creating.genre} onChange={event => updateCreating({ genre: event.target.value })} /></div>
          <div className="field"><label htmlFor="ss-new-words">全文目标字数</label><input id="ss-new-words" className="input" type="number" min={1000} max={120000} step={1} required value={creating.targetWords || ''} onChange={event => updateCreating({ targetWords: Number(event.target.value) })} /></div>
          <div className="field"><label htmlFor="ss-new-count">分节数</label><input id="ss-new-count" className="input" type="number" min={1} max={60} step={1} required value={creating.sectionCount || ''} onChange={event => updateCreating({ sectionCount: Number(event.target.value) })} /></div>
        </div>
        <div className="field"><label htmlFor="ss-new-brief">故事梗概</label><textarea id="ss-new-brief" maxLength={10000} className="textarea" rows={4} placeholder="主角想要什么，遇到什么冲突，故事如何结束？" value={creating.brief} onChange={event => updateCreating({ brief: event.target.value })} /></div>
        <div className="field"><label htmlFor="ss-new-requirements">写作要求</label><textarea id="ss-new-requirements" maxLength={10000} className="textarea" rows={2} placeholder="叙述视角、风格、反转与需要避开的内容" value={creating.requirements} onChange={event => updateCreating({ requirements: event.target.value })} /></div>
        <p className="muted">按全文字数分配各节预算，每节最多 6000 字；短篇和中篇的目标与分节均可调整。</p>
        <p className="muted">表单自动保存为本地草稿；关闭表单或离开栏目后可继续填写。缓存不可用时请先复制新建草稿。</p>
        <div className="ss-actions"><button className="btn btn-primary" type="submit" disabled={!storageLocation}>{saving ? '创建中…' : '创建作品'}</button><button className="btn" type="button" onClick={closeCreating}>取消并保留草稿</button><button className="btn btn-danger" type="button" onClick={discardCreating}>丢弃新建草稿</button></div>
      </fieldset>
      {creating.kind === 'short' && <ShortStoryBrainstorm
        genre={creating.genre} requirements={creating.requirements} targetWords={creating.targetWords}
        sourceBrief={creating.brief} recoveryKey="new-short-story" disabled={generationBlocked}
        onBusyChange={setBrainstorming} onAdopt={idea => adoptIdea(idea, true)}
      />}
    </form>}
    {storiesLoading ? <p className="empty">正在读取中短篇作品…</p> : stories.length ? <div className="ss-story-list">
      {stories.map(item => <article key={item.id} className="card ss-story-card">
        <span className="ss-story-kind">{SHORT_STORY_PRESETS[item.kind].label}{item.genre ? ` · ${item.genre}` : ''}</span>
        <button className="ss-story-title" disabled={busy || !!item.loadError} onClick={() => void openStory(item.id)}>{item.title}</button>
        <span className="ss-story-count">{item.writtenWords.toLocaleString()} / {item.targetWords.toLocaleString()} 字 · {item.completedSections} / {item.sectionCount} 节有正文</span>
        <progress aria-label={`${item.title}的字数进度`} max={item.targetWords} value={Math.min(item.writtenWords, item.targetWords)} />
        <span className="ss-story-date">更新于 {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
        {item.loadError && <><p className="ss-error ss-notice" role="alert">无法读取：{item.loadError}</p><button className="btn btn-sm" disabled={busy} onClick={() => void openDirectory(item.id)}>打开作品文件夹</button></>}
      </article>)}
    </div> : <div className="empty-state ss-empty"><h2>从一个能讲完的故事开始</h2><p>短篇默认 8000 字 / 4 节，中篇默认 30000 字 / 12 节。</p><p>新建作品后，先确定冲突与结局，再按全文预算完成正文。</p></div>}
    {!storiesLoading && <div className="ss-list-footer"><button className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>刷新作品列表</button></div>}
  </div>

  return <div className="short-story-page">
    <div className="page-head page-head-row">
      <div><button className="btn btn-ghost btn-sm ss-back" disabled={busy} onClick={returnToList}>← 中短篇作品</button><h1>{story.title}</h1><p className="desc">{SHORT_STORY_PRESETS[story.kind].label} · {story.genre || '题材待定'} · {dirty ? '有未保存的修改' : '已保存'}</p></div>
      <div className="ss-actions">
        <button className="btn" disabled={busy} onClick={() => void copyRecovery({ story, targetWords, sectionCount, candidate })}>复制当前草稿</button>
        <button className="btn" disabled={busy} onClick={() => void openDirectory()}>作品文件夹</button>
        <button className="btn" disabled={busy} onClick={() => void exportStory()}>导出全文</button>
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void saveCurrent()}>{saving ? '保存中…' : '保存作品'}</button>
      </div>
    </div>
    {storagePanel}
    {notices}
    {revisionConflict && <div className="ss-notice ss-conflict-notice"><span>当前草稿与已保存版本不同。重新读取时，会将当前草稿移入独立恢复区。</span><button className="btn" disabled={busy} onClick={() => void reloadSaved()}>重新读取已保存版本</button></div>}
    <div className="card ss-progress">
      <div><strong>{writtenWords.toLocaleString()}</strong><span> / {story.targetWords.toLocaleString()} 字</span></div>
      <progress aria-label="全文字数进度" max={story.targetWords} value={Math.min(writtenWords, story.targetWords)} />
      <span>{completedSections} / {story.sectionCount} 节有正文</span>
      <span>{writtenWords > story.targetWords ? `超出目标 ${(writtenWords - story.targetWords).toLocaleString()} 字` : `剩余预算 ${(story.targetWords - writtenWords).toLocaleString()} 字`}</span>
    </div>
    <nav className="ss-tabs" aria-label="中短篇工作台">
      {(Object.keys(TAB_LABELS) as WorkspaceTab[]).map(value => <button key={value} className={`btn ${tab === value ? 'ss-tab-active' : 'btn-ghost'}`} aria-current={tab === value ? 'page' : undefined} disabled={busy} onClick={() => setTab(value)}>{TAB_LABELS[value]}</button>)}
    </nav>
    <div className={`ss-workspace ${candidate ? 'ss-workspace-with-candidate' : ''}`}>
      <section className="card ss-editor" aria-label={TAB_LABELS[tab]}>
        {!candidate && preparingGeneration && <p className="ss-notice" role="status">正在保存作品，准备生成…</p>}
        {!candidate && generationStartError && <p className="ss-error ss-notice" role="alert">{generationStartError}</p>}
        {tab === 'setup' && <><fieldset disabled={busy}>
          <h2>作品设定</h2>
          <div className="ss-field-grid">
            <div className="field"><label htmlFor="ss-title">作品名</label><input id="ss-title" className="input" maxLength={120} value={story.title} onChange={event => updateStory({ title: event.target.value })} /></div>
            <div className="field"><label htmlFor="ss-kind">篇幅类型</label><select id="ss-kind" className="select" value={story.kind} onChange={event => updateStory({ kind: event.target.value as ShortStoryKind })}><option value="short">短篇</option><option value="medium">中篇</option></select></div>
          </div>
          <div className="field"><label htmlFor="ss-genre">题材</label><input id="ss-genre" className="input" maxLength={200} value={story.genre} onChange={event => updateStory({ genre: event.target.value })} /></div>
          <div className="field"><label htmlFor="ss-brief">故事梗概</label><textarea id="ss-brief" maxLength={10000} className="textarea" rows={6} placeholder="交代主角、核心冲突、关键转折与结局。" value={story.brief} onChange={event => updateStory({ brief: event.target.value })} /></div>
          <div className="field"><label htmlFor="ss-requirements">写作要求</label><textarea id="ss-requirements" maxLength={10000} className="textarea" rows={4} value={story.requirements} onChange={event => updateStory({ requirements: event.target.value })} /></div>
          <div className="ss-field-grid">
            <div className="field"><label htmlFor="ss-words">全文目标字数</label><input id="ss-words" className="input" type="number" min={1000} max={120000} step={1} value={targetWords} onChange={event => { setTargetWords(event.target.value); updateStory({ review: '' }) }} /></div>
            <div className="field"><label htmlFor="ss-count">分节数</label><input id="ss-count" className="input" type="number" min={1} max={60} step={1} value={sectionCount} onChange={event => { setSectionCount(event.target.value); updateStory({ review: '' }) }} /></div>
          </div>
          <div className="ss-actions"><button className="btn" disabled={!pendingBudget} onClick={applyBudget}>应用篇幅设置</button><span className="muted">当前每节预算 {Math.min(...budgets).toLocaleString()}—{Math.max(...budgets).toLocaleString()} 字</span></div>
          <p className="muted ss-help">修改设定、大纲或正文后，原完结检查会失效，需要重新检查。</p>
        </fieldset>
        {story.kind === 'short' && <ShortStoryBrainstorm
          genre={story.genre} requirements={story.requirements} targetWords={Number(targetWords)}
          sourceBrief={story.brief} recoveryKey={story.id} disabled={generationBlocked}
          onBusyChange={setBrainstorming} onAdopt={idea => adoptIdea(idea, false)}
        />}</>}
        {tab === 'outline' && <>
          <div className="ss-editor-head"><h2>全文大纲</h2><button className="btn btn-primary" disabled={busy} onClick={() => void generate('outline')}>{story.outline.trim() ? '重新生成大纲' : '生成大纲'}</button></div>
          <p className="muted">围绕全文目标安排开场、冲突、转折、高潮和结局，为每节分配事件与字数。</p>
          <label className="ss-sr-only" htmlFor="ss-outline">全文大纲原稿</label><textarea id="ss-outline" maxLength={100000} className="textarea ss-manuscript" rows={22} disabled={busy} value={story.outline} placeholder="可手动填写全文大纲，也可生成候选后采用。" onChange={event => updateStory({ outline: event.target.value })} />
        </>}
        {tab === 'sections' && <>
          <div className="ss-editor-head"><h2>分节正文</h2><div className="ss-actions">{story.review.trim() && <button className="btn" disabled={busy || pendingBudget || completedSections < story.sectionCount} onClick={() => void generate('revise')}>按检查结果修订这一节</button>}<button className="btn btn-primary" disabled={busy} onClick={() => void generate('section')}>{section?.content.trim() ? '继续写这一节' : '写这一节'}</button></div></div>
          <div className="ss-section-layout">
            <nav className="ss-section-list" aria-label="选择分节">{story.sections.map(item => <button key={item.number} className={`ss-section-button ${sectionNumber === item.number ? 'is-active' : ''}`} aria-current={sectionNumber === item.number ? 'page' : undefined} disabled={busy} onClick={() => { setSectionNumber(item.number); setInstruction('') }}><strong>第 {item.number} 节{item.title ? ` · ${item.title}` : ''}</strong><span>{shortStoryWordCount(item.content).toLocaleString()} / {budgets[item.number - 1]?.toLocaleString()} 字</span></button>)}</nav>
            {section && <div className="ss-section-editor">
              <div className="field"><label htmlFor="ss-section-title">第 {section.number} 节标题</label><input id="ss-section-title" maxLength={120} className="input" disabled={busy} value={section.title} onChange={event => updateStory({ sections: story.sections.map(item => item.number === section.number ? { ...item, title: event.target.value } : item) })} /></div>
              <p className="muted">本节预算 {budgets[section.number - 1]?.toLocaleString()} 字 · 已写 {shortStoryWordCount(section.content).toLocaleString()} 字。继续写生成的候选会在采用后追加到原稿末尾。</p>
              <label className="ss-sr-only" htmlFor="ss-section-content">第 {section.number} 节正文原稿</label><textarea id="ss-section-content" maxLength={40000} className="textarea ss-manuscript" rows={24} disabled={busy} value={section.content} placeholder="在这里写正文，或根据大纲生成候选。" onChange={event => updateStory({ sections: story.sections.map(item => item.number === section.number ? { ...item, content: event.target.value } : item) })} />
            </div>}
          </div>
        </>}
        {tab === 'review' && <>
          <div className="ss-editor-head"><h2>完结检查</h2><button className="btn btn-primary" disabled={busy} onClick={() => void generate('review')}>检查全文</button></div>
          <p className="muted">检查全文结构、人物动机、伏笔回收、结局闭合与字数预算。全部分节有正文后可运行。</p>
          {completedSections < story.sectionCount && <p className="ss-notice">还有 {story.sectionCount - completedSections} 节没有正文，完成后再检查。</p>}
          <div className="ss-review-repair">
            <label htmlFor="ss-revise-section">要修订的分节</label>
            <div className="ss-actions"><select id="ss-revise-section" className="select" disabled={busy} value={sectionNumber} onChange={event => setSectionNumber(Number(event.target.value))}>{story.sections.map(item => <option key={item.number} value={item.number}>第 {item.number} 节{item.title ? ` · ${item.title}` : ''}</option>)}</select><button className="btn btn-primary" disabled={busy || pendingBudget || !story.review.trim() || completedSections < story.sectionCount} onClick={() => void generate('revise')}>按检查结果修订</button></div>
            <p className="muted">{story.review.trim() ? '结合全文与检查建议，生成所选节的完整修订稿。核对候选后可替换该节；采用后需保存并重新检查全文。' : '先检查全文并采用检查报告，再选择有问题的分节进行修订。'}</p>
          </div>
          <label className="ss-sr-only" htmlFor="ss-review">完结检查结果</label><textarea id="ss-review" maxLength={100000} className="textarea ss-manuscript" rows={20} disabled={busy} value={story.review} placeholder="检查结果会先进入候选区，采用后可在这里编辑与保存。" onChange={event => updateStory({ review: event.target.value }, true)} />
        </>}
        {tab !== 'setup' && <div className="field ss-generation-instruction"><label htmlFor="ss-instruction">本次生成要求（可选）</label><textarea id="ss-instruction" maxLength={10000} className="textarea" rows={2} disabled={busy} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={tab === 'review' ? '例如：优先修正时序与人物信息来源，保留原结局。' : tab === 'sections' ? '补充这一节的续写或修订要求。' : '补充本次希望重点处理的内容。'} /><p className="muted">生成前会保存当前作品。生成文本先进入候选区，由你检查并采用。</p></div>}
      </section>
      {candidate && <aside className="card ss-candidate" aria-label="生成候选">
        <div className="ss-editor-head"><h2>{TASK_LABELS[candidate.task]}候选{candidate.sectionNumber ? ` · 第 ${candidate.sectionNumber} 节` : ''}</h2>{generating && <button className="btn btn-danger btn-sm" disabled={stopping} onClick={() => void stop()}>{stopping ? '停止中…' : '停止生成'}</button>}</div>
        <ShortStoryCandidateStatus candidate={candidate} preparing={preparingGeneration} preparationError={generationStartError} retryDisabled={!!retryBlockedReason} retryBlockedReason={retryBlockedReason} onRetry={() => void generate(candidate.task, candidate.sectionNumber ?? sectionNumber, candidate.instruction ?? instruction)} />
        {candidate.task === 'revise' && <><p className="muted">{candidate.status === 'completed' ? `这是第 ${candidate.sectionNumber} 节的完整修订稿。` : `这里显示第 ${candidate.sectionNumber} 节的修订候选，完整生成后才可采用。`}采用后会替换该节正文，检查报告将失效；可对照原节核对修改。</p>{candidate.sectionNumber && (tab !== 'sections' || sectionNumber !== candidate.sectionNumber) && <button className="btn btn-sm" disabled={busy} onClick={() => { setSectionNumber(candidate.sectionNumber!); setTab('sections') }}>对照第 {candidate.sectionNumber} 节原稿</button>}</>}
        {incompleteRevision && candidate.status !== 'generating' && <p className="ss-notice">修订未完成，不能替换整节。可复制恢复文本手动编辑，或重新生成修订稿。</p>}
        {(candidateStale || pendingBudget) && <p className="ss-notice">原稿、篇幅设置或修订所依据的检查报告已变化，此候选需重新生成；也可复制文本自行编辑。</p>}
        <label className="ss-sr-only" htmlFor="ss-candidate-content">可编辑的生成候选</label><textarea id="ss-candidate-content" maxLength={candidate.task === 'revise' ? 40000 : undefined} className="textarea ss-candidate-text" rows={26} readOnly={busy} value={candidate.text} placeholder={candidate.status === 'generating' ? '正在等待模型返回内容…' : candidate.status === 'failed' ? '本次生成失败，未收到内容。点击上方重试。' : candidate.status === 'stopped' ? '生成已停止，未收到内容。可重新发起生成。' : '生成的文本会显示在这里。'} onChange={event => setCandidate({ ...candidate, text: event.target.value })} />
        <div className="ss-candidate-footer"><span className="muted">{shortStoryWordCount(candidate.text).toLocaleString()} 字</span><div className="ss-actions"><button className="btn btn-primary" disabled={busy || !candidate.text.trim() || candidateStale || pendingBudget || incompleteRevision} onClick={adoptCandidate}>{candidate.task === 'revise' ? `采用修订并替换第 ${candidate.sectionNumber} 节` : candidate.append ? '追加到原稿' : '采用候选'}</button><button className="btn" disabled={busy} onClick={() => { if (!candidate.text.trim() || window.confirm('确定丢弃当前候选文本？')) setCandidate(null) }}>丢弃候选</button></div></div>
      </aside>}
    </div>
    {conflicts.length > 0 && <details className="card ss-conflict-backups"><summary>冲突恢复稿 · {conflicts.length} 份（仅供查看和复制）</summary>
      <div className="ss-conflict-tools"><label htmlFor="ss-conflict-version">恢复记录</label><select id="ss-conflict-version" className="select" value={conflictIndex} onChange={event => setConflictIndex(Number(event.target.value))}>{conflicts.map((backup, index) => <option key={`${backup.savedAt}-${index}`} value={index}>{new Date(backup.savedAt).toLocaleString('zh-CN')} · 版本 {backup.story.revision}</option>)}</select><button className="btn" onClick={() => void copyRecovery(conflicts[conflictIndex])}>复制这份恢复稿</button></div>
      <label className="ss-sr-only" htmlFor="ss-conflict-content">冲突恢复稿全文</label><textarea id="ss-conflict-content" className="textarea" rows={15} readOnly value={recoveryText(conflicts[conflictIndex])} />
    </details>}
    {leaveDialog && <div className="dialog-overlay"><div className="dialog ss-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="ss-leave-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) setLeaveDialog(false) }}>
      <h3 id="ss-leave-title">当前作品有未保存的修改</h3><p>可以保存作品再返回，也可以保留本地恢复稿，下次打开时继续编辑。</p>
      <div className="ss-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void saveAndLeave()}>{saving ? '保存中…' : '保存并返回'}</button><button className="btn" disabled={busy} onClick={leaveWorkspace}>保留草稿并返回</button><button className="btn btn-ghost" disabled={busy} onClick={() => setLeaveDialog(false)} autoFocus>继续编辑</button></div>
    </div></div>}
  </div>
}
