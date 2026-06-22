/**
 * 自动保存草稿（P19-A）。
 *
 * 策略：
 * - 每 800ms debounce 后，写入 `正文/.draft-NNN.md`（隐藏文件约定）
 * - 手动保存（chapters:updateContent）→ 清掉 draft（已生效，无需保留）
 * - 打开章节 → 检查是否有 draft；若有且与正文不同 → 提示"恢复 / 丢弃"
 *
 * 设计目标：崩溃恢复 + 误操作保护，不干扰正常写作。
 */

import { join } from 'path'

export const AUTO_SAVE_DEBOUNCE_MS = 800

/** 草稿路径：`正文/.draft-NNN.md`（隐藏文件约定，LS 不展示） */
export function draftPath(projectDir: string, chapterNumber: number): string {
  return join(projectDir, '正文', `.draft-${String(chapterNumber).padStart(3, '0')}.md`)
}

/** 检查 draft 是否与正文不同（draft 有效 → 提示恢复） */
export function isDraftDifferent(draft: string, saved: string): boolean {
  return draft !== saved
}

/** 格式化 draft 年龄（与 formatRelativeTime 同款语义，独立函数便于 IPC 返回） */
export function formatDraftAge(at: number, now: number): string {
  const diff = Math.max(0, now - at)
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

/** 草稿元数据（IPC 返回值，含时间戳 + 内容） */
export interface DraftMeta {
  /** 草稿内容 */
  content: string
  /** 草稿最后写入时间（毫秒 epoch） */
  at: number
  /** 是否与正文不同（true → 提示用户恢复） */
  different: boolean
}

