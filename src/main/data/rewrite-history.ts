/**
 * 改写历史栈：纯函数工具（便于单测）。
 *
 * 状态：Array<{ oldSnippet: string; newText: string; at: number, violationKey?: string }>
 *   - oldSnippet：apply 之前正文里的命中段
 *   - newText：apply 时使用的改写文本
 *   - at：apply 时间戳（毫秒）
 *   - violationKey（P6-B）：对应违例的稳定键（来自 chapter-audit.violationKey）。
 *     用于"撤销这条"——按 violationKey 找到这条应用对应的栈条目。
 *
 * 容量上限 10 条（FIFO 截断），避免内存爆。
 */

export interface RewriteEntry {
  oldSnippet: string
  newText: string
  at: number
  /** 对应违例的稳定键（P6-B）；可选，旧调用方不传也兼容 */
  violationKey?: string
}

export const REWRITE_HISTORY_CAP = 10

/** 压栈：超出容量时丢弃最早的条目（FIFO） */
export function pushEntry(
  stack: readonly RewriteEntry[],
  oldSnippet: string,
  newText: string,
  now: number = Date.now(),
  violationKey?: string
): RewriteEntry[] {
  const entry: RewriteEntry = { oldSnippet, newText, at: now }
  if (violationKey !== undefined) entry.violationKey = violationKey
  const next = [...stack, entry]
  return next.length > REWRITE_HISTORY_CAP
    ? next.slice(next.length - REWRITE_HISTORY_CAP)
    : next
}

/** 弹栈：返回新栈 + 弹出的条目（栈空时返回原栈 + null） */
export function popEntry(stack: readonly RewriteEntry[]): {
  next: RewriteEntry[]
  popped: RewriteEntry | null
} {
  if (stack.length === 0) return { next: [...stack], popped: null }
  const popped = stack[stack.length - 1]
  return { next: stack.slice(0, -1), popped }
}

/**
 * 按 fromTop 弹栈：fromTop=0 是栈顶，fromTop=1 是次新，以此类推。
 * 越界（fromTop >= length）返回 null。
 * 用于"撤销任意 N 条"的 UI 交互。
 */
export function popEntryAt(
  stack: readonly RewriteEntry[],
  fromTop: number
): { next: RewriteEntry[]; popped: RewriteEntry | null } {
  if (fromTop < 0 || fromTop >= stack.length) {
    return { next: [...stack], popped: null }
  }
  const idx = stack.length - 1 - fromTop
  const popped = stack[idx]
  // 删除 idx 位置，其他保持原序
  return {
    next: [...stack.slice(0, idx), ...stack.slice(idx + 1)],
    popped
  }
}

/**
 * P6-B：按 violationKey 找到对应的栈索引（从最新到最旧）。
 * 返回 -1 表示没找到（通常因为该违例的应用已被撤销，或 violationKey 未传）。
 * 用于"撤销这条"——找到这条应用对应的栈条目。
 */
export function findEntryByViolationKey(
  stack: readonly RewriteEntry[],
  violationKey: string
): number {
  // 倒序找：从最新（栈尾）开始，匹配第一个
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].violationKey === violationKey) return i
  }
  return -1
}

// ============================================================
// 重做栈（P7-A：完整 undo/redo 状态机）
// ============================================================

/**
 * 撤销时调用：把被弹出的 entry 推入 redoStack。
 * 容量上限同 rewriteHistory（10 条），避免内存爆。
 */
export function pushRedo(
  redoStack: readonly RewriteEntry[],
  entry: RewriteEntry
): RewriteEntry[] {
  const next = [...redoStack, entry]
  return next.length > REWRITE_HISTORY_CAP
    ? next.slice(next.length - REWRITE_HISTORY_CAP)
    : next
}

/**
 * 重做时调用：弹 redoStack 顶部。
 * 栈空返回 null。
 */
export function popRedo(redoStack: readonly RewriteEntry[]): {
  next: RewriteEntry[]
  popped: RewriteEntry | null
} {
  if (redoStack.length === 0) return { next: [...redoStack], popped: null }
  return {
    next: redoStack.slice(0, -1),
    popped: redoStack[redoStack.length - 1]
  }
}

/**
 * 任何"非 redo"的应用都应清空 redoStack（连续应用打破线性 history）。
 * 例如：undo 后用户又 apply 一条新改写，原 redo 路径不再有意义。
 */
export function clearRedoStack(): RewriteEntry[] {
  return []
}

// ============================================================
// 键盘快捷键解析（P8-B：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）
// ============================================================

/**
 * 快捷键意图。null 表示"不是 undo/redo 快捷键，不要拦截"。
 *
 * 跨平台约定：
 * - Win/Linux: Ctrl+Z = undo, Ctrl+Shift+Z 或 Ctrl+Y = redo
 * - macOS: Cmd+Z = undo, Cmd+Shift+Z = redo（Ctrl+Y 在 Mac 上不常用）
 *
 * 此函数只判断"是否是 undo/redo 快捷键"，是否拦截（preventDefault）
 * 取决于调用方对 target 的判断（textarea 内不拦截，保留原生 undo）。
 */
export type UndoRedoIntent = 'undo' | 'redo' | null

export interface ShortcutEvent {
  /** 修饰键状态 */
  ctrl: boolean
  meta: boolean // Mac command
  shift: boolean
  alt: boolean
  /** 按下的键（不区分大小写） */
  key: string
  /** 当前焦点元素标签（用于判断是否在 textarea/input 内） */
  targetTag: string
}

export function detectUndoRedoShortcut(e: ShortcutEvent): UndoRedoIntent {
  // 在文本输入控件内：让浏览器原生 undo 处理（用户输入的文字 undo）
  // 这是标准编辑器行为：text field 内 Ctrl+Z = text undo，不是 app undo
  const tag = e.targetTag?.toLowerCase() ?? ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return null
  }

  const mod = e.ctrl || e.meta
  if (!mod) return null
  // 不要让 alt 干扰（Mac 上 Option+Cmd 是其他组合）
  if (e.alt) return null

  const k = (e.key ?? '').toLowerCase()
  if (k === 'z') {
    return e.shift ? 'redo' : 'undo'
  }
  // Ctrl+Y = redo（Windows 习惯）
  if (k === 'y' && !e.shift) {
    return 'redo'
  }
  return null
}

/**
 * 把 newText 在 draft 里替换为 oldSnippet，返回新 draft。
 * 找不到 newText 时返回原 draft（调用方应给出提示）。
 */
export function revertInDraft(draft: string, newText: string, oldSnippet: string): string {
  const idx = draft.indexOf(newText)
  if (idx < 0) return draft
  return draft.slice(0, idx) + oldSnippet + draft.slice(idx + newText.length)
}

export interface RewriteTarget {
  start: number
  end: number
  oldSnippet: string
  replacement: string
}

const EDGE_OMISSION_RE = /^[\s.…·•]+|[\s.…·•]+$/g
const LEADING_OMISSION_RE = /^[\s.…·•]+/
const TRAILING_OMISSION_RE = /[\s.…·•]+$/

function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    normalized += ch
    map.push(i)
  }
  return { normalized, map }
}

function hasLeadingOmission(text: string): boolean {
  return LEADING_OMISSION_RE.test(text)
}

function hasTrailingOmission(text: string): boolean {
  return TRAILING_OMISSION_RE.test(text)
}

function stripEdgeOmission(text: string): string {
  return text.replace(EDGE_OMISSION_RE, '')
}

/**
 * 找到一次改写应替换的正文范围。
 *
 * 审核面板里的 snippet 可能来自 extractContext：前后带展示用省略号，且正文空白会被
 * 折叠成单空格。这里先走精确匹配；失败后把边缘省略号去掉，并按"忽略空白"的文本
 * 映射找回 draft 中的真实字符范围。
 */
export function findRewriteTarget(
  draft: string,
  snippet: string,
  replacement: string
): RewriteTarget | null {
  if (!snippet) return null

  const exactIdx = draft.indexOf(snippet)
  if (exactIdx >= 0) {
    return {
      start: exactIdx,
      end: exactIdx + snippet.length,
      oldSnippet: snippet,
      replacement
    }
  }

  const needle = stripEdgeOmission(snippet)
  if (!needle) return null

  const draftNorm = normalizeWithMap(draft)
  const needleNorm = normalizeWithMap(needle)
  if (!needleNorm.normalized) return null

  const normIdx = draftNorm.normalized.indexOf(needleNorm.normalized)
  if (normIdx < 0) return null

  const start = draftNorm.map[normIdx]
  const lastNormIdx = normIdx + needleNorm.normalized.length - 1
  const end = draftNorm.map[lastNormIdx] + 1
  let nextReplacement = replacement
  if (hasLeadingOmission(snippet)) {
    nextReplacement = nextReplacement.replace(LEADING_OMISSION_RE, '')
  }
  if (hasTrailingOmission(snippet)) {
    nextReplacement = nextReplacement.replace(TRAILING_OMISSION_RE, '')
  }

  return {
    start,
    end,
    oldSnippet: draft.slice(start, end),
    replacement: nextReplacement
  }
}

/**
 * 把 oldSnippet 在 draft 里替换为 newText，返回新 draft。
 * 找不到 oldSnippet 时返回原 draft。
 */
export function applyToDraft(draft: string, oldSnippet: string, newText: string): string {
  const idx = draft.indexOf(oldSnippet)
  if (idx < 0) return draft
  return draft.slice(0, idx) + newText + draft.slice(idx + oldSnippet.length)
}
