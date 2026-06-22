/**
 * 改写历史栈 localStorage 持久化（P9-A）。
 *
 * 目标：用户按 F5 刷新页面后，undo/redo 历史不丢。
 *
 * 设计：
 * - key 按 `projectId:chapterNumber` 隔离；schema version 用于未来兼容
 * - 纯函数（serialize/deserialize）+ 副作用封装（safeStorage 读写）
 * - 解析失败 / 版本不匹配 → 返回 null（不崩，最佳努力）
 * - localStorage 不可用（隐私模式 / 满）→ 静默降级（仍可用 undo/redo，只是不持久化）
 */

import type { RewriteEntry } from './rewrite-history'

/** Schema 版本。改动存储格式时必须 +1，老数据会被丢弃。 */
export const REWRITE_PERSISTENCE_VERSION = 1

/** 单个 chapter 的持久化数据 */
export interface PersistedRewriteState {
  version: number
  history: RewriteEntry[]
  redoStack: RewriteEntry[]
}

export function buildStorageKey(projectId: string, chapterNumber: number): string {
  return `ai-writer:rewrite:v${REWRITE_PERSISTENCE_VERSION}:${projectId}:${chapterNumber}`
}

/**
 * 序列化为 JSON 字符串（纯函数）。
 * 便于单测 + 隔离环境差异（无 localStorage 时也能用）。
 */
export function serializeState(state: PersistedRewriteState): string {
  return JSON.stringify({
    version: state.version,
    history: state.history,
    redoStack: state.redoStack
  })
}

/**
 * 反序列化为对象（纯函数）。
 * 失败兜底：解析错误、版本不匹配、字段缺失、类型不对 → 返回 null。
 */
export function deserializeState(raw: string | null | undefined): PersistedRewriteState | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.version !== REWRITE_PERSISTENCE_VERSION) return null
  if (!Array.isArray(obj.history) || !Array.isArray(obj.redoStack)) return null
  // 校验每条 entry 的基本形状（弱校验：仅检查必要字段类型）
  const isValidEntry = (e: unknown): e is RewriteEntry => {
    if (!e || typeof e !== 'object') return false
    const entry = e as Record<string, unknown>
    return (
      typeof entry.oldSnippet === 'string' &&
      typeof entry.newText === 'string' &&
      typeof entry.at === 'number' &&
      (entry.violationKey === undefined || typeof entry.violationKey === 'string')
    )
  }
  if (!obj.history.every(isValidEntry)) return null
  if (!obj.redoStack.every(isValidEntry)) return null
  return {
    version: REWRITE_PERSISTENCE_VERSION,
    history: obj.history as RewriteEntry[],
    redoStack: obj.redoStack as RewriteEntry[]
  }
}

// ============================================================
// 副作用封装：localStorage 读写（含降级）
// ============================================================

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 拿到 localStorage；隐私模式 / SSR 等场景下可能为 null。 */
export function getLocalStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    // 试访问一次确认可用（隐私模式下某些浏览器 setItem 抛）
    const probeKey = '__ai-writer-probe__'
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
    return window.localStorage
  } catch {
    return null
  }
}

/** 读取并反序列化。返回 null 表示无数据 / 损坏 / 不兼容。 */
export function loadState(
  storage: StorageLike | null,
  projectId: string,
  chapterNumber: number
): PersistedRewriteState | null {
  if (!storage) return null
  const key = buildStorageKey(projectId, chapterNumber)
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  return deserializeState(raw)
}

/** 序列化并写入。失败（容量满 / 隐私模式）静默降级。 */
export function saveState(
  storage: StorageLike | null,
  projectId: string,
  chapterNumber: number,
  state: PersistedRewriteState
): boolean {
  if (!storage) return false
  const key = buildStorageKey(projectId, chapterNumber)
  try {
    storage.setItem(key, serializeState(state))
    return true
  } catch {
    return false
  }
}

/** 删除持久化数据。失败静默。 */
export function clearState(
  storage: StorageLike | null,
  projectId: string,
  chapterNumber: number
): boolean {
  if (!storage) return false
  const key = buildStorageKey(projectId, chapterNumber)
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
