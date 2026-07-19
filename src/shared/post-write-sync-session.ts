/**
 * 写后同步：会话内撤销栈 + 失败队列（localStorage 持久化）。
 * 纯函数 / 无 React，便于单测。
 */

import type {
  MemoryApplyResult,
  MemoryExtraction,
  SettingsApplyResult
} from './types'

/** 一次可撤销的同步回执 */
export interface SyncUndoReceipt {
  extraction: MemoryExtraction
  memory: MemoryApplyResult
  settings: SettingsApplyResult
}

/** 同步历史（多级撤销，LIFO；可按章持久化） */
export interface SyncHistoryEntry {
  id: string
  projectId: string
  chapterNumber: number
  at: number
  message: string
  receipt: SyncUndoReceipt
}

/** 失败后待补跑的队列项（可跨重启） */
export interface PendingSyncItem {
  id: string
  projectId: string
  chapterNumber: number
  /** 续写完成时的正文快照 */
  content: string
  errors: string[]
  at: number
  /** 已自动/手动尝试次数（仅展示） */
  attempts: number
  /** 展示用书名（可选，入队时尽力写入） */
  projectName?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const PENDING_SYNC_QUEUE_KEY = 'ai-writer:pending-sync-queue'
/** 按章持久化的撤销栈总表 */
export const SYNC_HISTORY_STORAGE_KEY = 'ai-writer:sync-history-v1'
/** 启动提醒冷却：同一浏览器会话只 toast 一次的标记前缀 */
export const PENDING_SYNC_BOOT_HINT_KEY = 'ai-writer:pending-sync-boot-hint'

/** 单条正文快照上限（与章节 content 校验量级一致） */
export const PENDING_SYNC_MAX_CONTENT = 200_000
/** 队列最大条数 */
export const PENDING_SYNC_MAX_ITEMS = 30
/** 会话撤销栈最大深度 */
export const SYNC_HISTORY_MAX = 12
/** 跨重启持久化时每章最多保留层数（控制 localStorage 体积） */
export const SYNC_HISTORY_PERSIST_MAX = 8

export function makeSyncId(prefix = 'sync'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function pushSyncHistory(
  stack: SyncHistoryEntry[],
  entry: SyncHistoryEntry,
  max = SYNC_HISTORY_MAX
): SyncHistoryEntry[] {
  const next = [...stack, entry]
  if (next.length <= max) return next
  return next.slice(next.length - max)
}

export function popSyncHistory(stack: SyncHistoryEntry[]): {
  next: SyncHistoryEntry[]
  popped: SyncHistoryEntry | null
} {
  if (stack.length === 0) return { next: stack, popped: null }
  const next = stack.slice(0, -1)
  const popped = stack[stack.length - 1] ?? null
  return { next, popped }
}

export function peekSyncHistory(stack: SyncHistoryEntry[]): SyncHistoryEntry | null {
  if (stack.length === 0) return null
  return stack[stack.length - 1] ?? null
}

export function clearSyncHistoryForChapter(
  stack: SyncHistoryEntry[],
  chapterNumber: number
): SyncHistoryEntry[] {
  return stack.filter((e) => e.chapterNumber !== chapterNumber)
}

export function syncHistoryChapterKey(projectId: string, chapterNumber: number): string {
  return `${projectId}::${chapterNumber}`
}

type HistoryStore = Record<string, SyncHistoryEntry[]>

function loadHistoryStore(storage: StorageLike | null | undefined): HistoryStore {
  const s = safeStorage(storage ?? null)
  if (!s) return {}
  try {
    const raw = s.getItem(SYNC_HISTORY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: HistoryStore = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue
      const entries = v
        .map(normalizeHistoryEntry)
        .filter((e): e is SyncHistoryEntry => e != null)
        .slice(-SYNC_HISTORY_PERSIST_MAX)
      if (entries.length > 0) out[k] = entries
    }
    return out
  } catch {
    return {}
  }
}

function saveHistoryStore(storage: StorageLike | null | undefined, store: HistoryStore): boolean {
  const s = safeStorage(storage ?? null)
  if (!s) return false
  try {
    // 最多保留 40 个章节键，避免无限膨胀
    const keys = Object.keys(store)
    let trimmed = store
    if (keys.length > 40) {
      const keep = keys.slice(-40)
      trimmed = {}
      for (const k of keep) trimmed[k] = store[k]
    }
    s.setItem(SYNC_HISTORY_STORAGE_KEY, JSON.stringify(trimmed))
    return true
  } catch {
    return false
  }
}

function normalizeHistoryEntry(raw: unknown): SyncHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const projectId = typeof o.projectId === 'string' ? o.projectId : ''
  const chapterNumber = Number(o.chapterNumber)
  const receipt = o.receipt as SyncUndoReceipt | undefined
  if (
    !projectId ||
    !Number.isFinite(chapterNumber) ||
    chapterNumber < 1 ||
    !receipt ||
    typeof receipt !== 'object' ||
    !receipt.extraction ||
    !receipt.memory ||
    !receipt.settings
  ) {
    return null
  }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : makeSyncId('hist'),
    projectId,
    chapterNumber: Math.floor(chapterNumber),
    at: typeof o.at === 'number' && o.at > 0 ? o.at : Date.now(),
    message: typeof o.message === 'string' ? o.message.slice(0, 200) : '',
    receipt
  }
}

/** 读取某章持久化撤销栈 */
export function loadSyncHistory(
  storage: StorageLike | null | undefined,
  projectId: string,
  chapterNumber: number
): SyncHistoryEntry[] {
  const store = loadHistoryStore(storage)
  const key = syncHistoryChapterKey(projectId, chapterNumber)
  return store[key] ?? []
}

/** 写入某章撤销栈（空数组则删除该键） */
export function saveSyncHistory(
  storage: StorageLike | null | undefined,
  projectId: string,
  chapterNumber: number,
  stack: SyncHistoryEntry[]
): boolean {
  const store = loadHistoryStore(storage)
  const key = syncHistoryChapterKey(projectId, chapterNumber)
  const capped = stack
    .filter((e) => e.projectId === projectId && e.chapterNumber === chapterNumber)
    .slice(-SYNC_HISTORY_PERSIST_MAX)
  if (capped.length === 0) {
    delete store[key]
  } else {
    store[key] = capped
  }
  return saveHistoryStore(storage, store)
}

/** 启动提醒文案；count=0 返回 null */
export function formatPendingSyncBootHint(count: number): string | null {
  if (count <= 0) return null
  return `有 ${count} 条记忆同步失败待补跑，可在「设置 → 待同步」查看或打开对应章节补跑`
}

/**
 * 是否应弹出启动提醒。
 * 同一 sessionStorage 会话内只提醒一次（刷新页面仍算同会话则不再弹）。
 */
export function shouldShowPendingBootHint(
  storage: StorageLike | null | undefined,
  sessionStorageLike: StorageLike | null | undefined,
  count: number
): boolean {
  if (count <= 0) return false
  const sess = safeStorage(sessionStorageLike ?? null)
  if (sess?.getItem(PENDING_SYNC_BOOT_HINT_KEY) === '1') return false
  // localStorage 仅用于确认队列可读；真正去重用 session
  void storage
  return true
}

export function markPendingBootHintShown(sessionStorageLike: StorageLike | null | undefined): void {
  const sess = safeStorage(sessionStorageLike ?? null)
  try {
    sess?.setItem(PENDING_SYNC_BOOT_HINT_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** 队列摘要（设置页列表，不含全文 content 时可再裁） */
export function summarizePendingQueue(queue: PendingSyncItem[]): {
  total: number
  byProject: { projectId: string; projectName?: string; count: number }[]
} {
  const map = new Map<string, { projectId: string; projectName?: string; count: number }>()
  for (const q of queue) {
    const cur = map.get(q.projectId) ?? {
      projectId: q.projectId,
      projectName: q.projectName,
      count: 0
    }
    cur.count++
    if (!cur.projectName && q.projectName) cur.projectName = q.projectName
    map.set(q.projectId, cur)
  }
  return { total: queue.length, byProject: [...map.values()] }
}

function safeStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (!storage) return null
  try {
    const k = '__aw_sync_probe__'
    storage.setItem(k, '1')
    storage.removeItem(k)
    return storage
  } catch {
    return null
  }
}

export function loadPendingSyncQueue(storage: StorageLike | null | undefined): PendingSyncItem[] {
  const s = safeStorage(storage ?? null)
  if (!s) return []
  try {
    const raw = s.getItem(PENDING_SYNC_QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizePendingItem)
      .filter((x): x is PendingSyncItem => x != null)
      .slice(0, PENDING_SYNC_MAX_ITEMS)
  } catch {
    return []
  }
}

/** 渲染进程内广播队列变更（侧栏角标等监听） */
export const PENDING_SYNC_CHANGED_EVENT = 'ai-writer:pending-sync-changed'

export function notifyPendingSyncQueueChanged(count: number): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    window.dispatchEvent(
      new CustomEvent(PENDING_SYNC_CHANGED_EVENT, { detail: { count } })
    )
  } catch {
    /* ignore */
  }
}

export function savePendingSyncQueue(
  storage: StorageLike | null | undefined,
  items: PendingSyncItem[]
): boolean {
  const s = safeStorage(storage ?? null)
  if (!s) return false
  try {
    const trimmed = items.slice(0, PENDING_SYNC_MAX_ITEMS).map((it) => ({
      ...it,
      content: it.content.slice(0, PENDING_SYNC_MAX_CONTENT),
      errors: (it.errors ?? []).slice(0, 10).map((e) => String(e).slice(0, 200)),
      projectName: it.projectName?.slice(0, 80)
    }))
    s.setItem(PENDING_SYNC_QUEUE_KEY, JSON.stringify(trimmed))
    notifyPendingSyncQueueChanged(trimmed.length)
    return true
  } catch {
    return false
  }
}

/** 读取队列长度（角标用，失败返回 0） */
export function countPendingSyncQueue(storage: StorageLike | null | undefined): number {
  return loadPendingSyncQueue(storage).length
}

function normalizePendingItem(raw: unknown): PendingSyncItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const projectId = typeof o.projectId === 'string' ? o.projectId : ''
  const content = typeof o.content === 'string' ? o.content : ''
  const chapterNumber = Number(o.chapterNumber)
  if (!projectId || !content.trim() || !Number.isFinite(chapterNumber) || chapterNumber < 1) {
    return null
  }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : makeSyncId('pend'),
    projectId,
    chapterNumber: Math.floor(chapterNumber),
    content: content.slice(0, PENDING_SYNC_MAX_CONTENT),
    errors: Array.isArray(o.errors)
      ? o.errors.map((e) => String(e)).filter(Boolean).slice(0, 10)
      : [],
    at: typeof o.at === 'number' && o.at > 0 ? o.at : Date.now(),
    attempts: typeof o.attempts === 'number' && o.attempts >= 0 ? o.attempts : 0,
    projectName:
      typeof o.projectName === 'string' && o.projectName.trim()
        ? o.projectName.trim().slice(0, 80)
        : undefined
  }
}

/**
 * 同 project + chapter 只保留一条最新失败项（覆盖旧正文快照）。
 */
export function upsertPendingSync(
  queue: PendingSyncItem[],
  item: PendingSyncItem
): PendingSyncItem[] {
  const rest = queue.filter(
    (q) => !(q.projectId === item.projectId && q.chapterNumber === item.chapterNumber)
  )
  const next: PendingSyncItem = {
    ...item,
    id: item.id || makeSyncId('pend'),
    content: item.content.slice(0, PENDING_SYNC_MAX_CONTENT),
    at: item.at || Date.now()
  }
  return [...rest, next].slice(-PENDING_SYNC_MAX_ITEMS)
}

export function removePendingSync(
  queue: PendingSyncItem[],
  match: { id?: string; projectId?: string; chapterNumber?: number }
): PendingSyncItem[] {
  return queue.filter((q) => {
    if (match.id && q.id === match.id) return false
    if (
      match.projectId &&
      match.chapterNumber != null &&
      q.projectId === match.projectId &&
      q.chapterNumber === match.chapterNumber
    ) {
      return false
    }
    return true
  })
}

export function findPendingForChapter(
  queue: PendingSyncItem[],
  projectId: string,
  chapterNumber: number
): PendingSyncItem | null {
  for (let i = queue.length - 1; i >= 0; i--) {
    const q = queue[i]
    if (q.projectId === projectId && q.chapterNumber === chapterNumber) return q
  }
  return null
}

/** 是否有可撤销的自动写入（用于决定是否入栈） */
export function receiptHasUndoableWrites(receipt: SyncUndoReceipt): boolean {
  const m = receipt.memory
  const s = receipt.settings
  const applied =
    (m.applied?.stateChanges ?? 0) +
    (m.applied?.plotPoints ?? 0) +
    (m.applied?.collected ?? 0) +
    (s.applied ?? 0)
  const diffs = (m.appliedDiffs?.length ?? 0) + (s.appliedDiffs?.length ?? 0)
  return applied > 0 || diffs > 0
}
