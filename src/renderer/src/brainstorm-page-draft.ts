export interface BrainstormPageDraft {
  version: 1
  genre: string
  targetChapters: string
  sourceBrief: string
}

export type BrainstormPageDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const BRAINSTORM_PAGE_DRAFT_KEY = 'ai-writer:brainstorm-page:draft'

interface BrainstormPageDraftRead {
  draft: BrainstormPageDraft
  warning: string
  corrupt: boolean
  found: boolean
}

const FIELD_LIMITS = { genre: 100, targetChapters: 32, sourceBrief: 5000 } as const
let unsafeRead = false

export function emptyBrainstormPageDraft(): BrainstormPageDraft {
  return { version: 1, genre: '', targetChapters: '', sourceBrief: '' }
}

function storagePort(storage?: BrainstormPageDraftStorage): BrainstormPageDraftStorage | null {
  if (storage) return storage
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validDraft(value: unknown): value is BrainstormPageDraft {
  const draft = record(value)
  return !!draft && draft.version === 1 && (Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[])
    .every(field => typeof draft[field] === 'string' && draft[field].length <= FIELD_LIMITS[field])
}

function decode(raw: string): BrainstormPageDraftRead {
  const draft = emptyBrainstormPageDraft()
  try {
    const saved = record(JSON.parse(raw))
    if (!saved || saved.version !== 1) throw new Error('草稿版本或格式有误')
    let corrupt = false
    for (const field of Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[]) {
      const value = saved[field]
      if (typeof value === 'string') {
        draft[field] = value.slice(0, FIELD_LIMITS[field])
        if (value.length > FIELD_LIMITS[field]) corrupt = true
      } else corrupt = true
    }
    return { draft, warning: corrupt ? '脑洞条件草稿有部分内容损坏，已恢复可读取的内容；原记录暂不覆盖。' : '', found: true, corrupt }
  } catch {
    return { draft, warning: '脑洞条件草稿无法读取；原记录保留，编辑条件后可重新保存。', found: true, corrupt: true }
  }
}

export function readBrainstormPageDraft(storage?: BrainstormPageDraftStorage): BrainstormPageDraftRead {
  const port = storagePort(storage)
  if (port) {
    try {
      const raw = port.getItem(BRAINSTORM_PAGE_DRAFT_KEY)
      const result = raw === null
        ? { draft: emptyBrainstormPageDraft(), warning: '', found: false, corrupt: false }
        : decode(raw)
      unsafeRead = result.corrupt
      return result
    } catch { /* 无法读取时禁止自动保存空状态，避免覆盖尚未读取的条件。 */ }
  }
  unsafeRead = true
  return { draft: emptyBrainstormPageDraft(), warning: '无法访问本地脑洞条件草稿。', found: false, corrupt: true }
}

/** 仅在作者明确编辑条件之后解除损坏记录保护；页面挂载不能自动解除。 */
export function allowBrainstormPageDraftWrite(): void { unsafeRead = false }

export function writeBrainstormPageDraft(draft: BrainstormPageDraft, storage?: BrainstormPageDraftStorage): boolean {
  if (unsafeRead || !validDraft(draft)) return false
  const port = storagePort(storage)
  if (!port) return false
  try {
    if (!draft.genre && !draft.targetChapters && !draft.sourceBrief) port.removeItem(BRAINSTORM_PAGE_DRAFT_KEY)
    else port.setItem(BRAINSTORM_PAGE_DRAFT_KEY, JSON.stringify({
      version: 1, genre: draft.genre, targetChapters: draft.targetChapters, sourceBrief: draft.sourceBrief
    }))
    return true
  } catch { return false }
}
