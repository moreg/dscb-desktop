/**
 * 流程面板等处的「忽略」持久化：localStorage 存 string key 集合。
 * 用于细纲差异 / 质检违例等，避免重检或重开面板后再次弹出。
 */

import type { OutlineDiffItem } from './types'

export function loadDismissedKeys(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

export function saveDismissedKeys(storageKey: string, keys: Set<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...keys]))
  } catch {
    // quota / private mode
  }
}

/** 不可变更新：加入一 key 并落盘 */
export function addDismissedKey(storageKey: string, key: string): Set<string> {
  const next = loadDismissedKeys(storageKey)
  next.add(key)
  saveDismissedKeys(storageKey, next)
  return next
}

/** 不可变更新：批量加入并落盘 */
export function addDismissedKeys(storageKey: string, keys: Iterable<string>): Set<string> {
  const next = loadDismissedKeys(storageKey)
  for (const k of keys) next.add(k)
  saveDismissedKeys(storageKey, next)
  return next
}

/** 删除一 key 并落盘 */
export function removeDismissedKey(storageKey: string, key: string): Set<string> {
  const next = loadDismissedKeys(storageKey)
  next.delete(key)
  saveDismissedKeys(storageKey, next)
  return next
}

/** 清空并落盘 */
export function clearDismissedKeys(storageKey: string): Set<string> {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // ignore
  }
  return new Set()
}

/**
 * 细纲差异稳定键：不依赖列表下标，重检后同类差异仍可匹配。
 * 截断过长字段，避免 key 膨胀。
 */
export function outlineDiffStableKey(d: Pick<OutlineDiffItem, 'type' | 'priority' | 'outline' | 'actual' | 'suggestion'>): string {
  const clip = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  return [d.type, d.priority, clip(d.outline, 120), clip(d.actual, 120), clip(d.suggestion, 80)].join('|')
}

export function outlineIgnoredStorageKey(projectId: string, chapterNumber: number): string {
  return `ai-writer:outline-ignored:${projectId}:${chapterNumber}`
}

export function outlineAppliedStorageKey(projectId: string, chapterNumber: number): string {
  return `ai-writer:outline-applied:${projectId}:${chapterNumber}`
}

export function auditIgnoredStorageKey(projectId: string, chapterNumber: number): string {
  return `ai-writer:audit-ignored:${projectId}:${chapterNumber}`
}
