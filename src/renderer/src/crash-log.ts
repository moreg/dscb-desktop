/**
 * 崩溃日志（P19-F）：记录用户可见的渲染错误到 localStorage。
 *
 * 目的：
 * - 用户报告问题时附"导出错误日志"按钮 → 拿到 stack 信息
 * - 上限 50 条（防磁盘占用）
 *
 * 注意：仅 renderer 侧 localStorage（不引入 IPC 复杂度）；
 * 主进程错误由 ipc/safe-handle.ts 兜底 console.error。
 */

export interface CrashEntry {
  at: number // epoch ms
  message: string
  stack?: string
  componentStack?: string
}

const STORAGE_KEY = 'ai-writer:crash-log'
const MAX_ENTRIES = 50

/** 读所有 crash 记录 */
export function loadCrashLog(storage: StorageLike | null): CrashEntry[] {
  if (!storage) return []
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e) =>
        e && typeof e.at === 'number' && typeof e.message === 'string'
    )
  } catch {
    return []
  }
}

/** 追加一条记录（删最早的 + 写新的一条） */
export function recordCrash(
  storage: StorageLike | null,
  entry: CrashEntry
): CrashEntry[] {
  if (!storage) return []
  const current = loadCrashLog(storage)
  const next = [...current, entry].slice(-MAX_ENTRIES)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 容量满 → 静默
  }
  return next
}

/** 清空 */
export function clearCrashLog(storage: StorageLike | null): void {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** 导出为可读文本（用户复制给开发） */
export function formatCrashLog(entries: readonly CrashEntry[]): string {
  if (entries.length === 0) return '（无崩溃记录）'
  return entries
    .map((e, i) => {
      const ts = new Date(e.at).toISOString()
      return `#${i + 1} [${ts}]\n${e.message}${e.stack ? '\n' + e.stack : ''}${e.componentStack ? '\n' + e.componentStack : ''}`
    })
    .join('\n\n---\n\n')
}

/** StorageLike 抽象（同 writing-stats，便于测试） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
