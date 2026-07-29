/**
 * 写后自动同步（记忆 / 设定）结果摘要。
 * 纯函数，供编辑器 toast、状态条与单测共用。
 */

export type PostWriteSyncPhase = 'idle' | 'syncing' | 'ok' | 'partial' | 'failed' | 'skipped'

export interface PostWriteSyncApplied {
  stateChanges: number
  plotPoints: number
  collected: number
  settings: number
}

export interface PostWriteSyncPending {
  characters: number
  locations: number
  items: number
  foreshadowings: number
  settingsConfirm: number
  suggestions: number
}

export interface PostWriteSyncSummary {
  phase: 'ok' | 'partial' | 'failed'
  /** 短句：状态条 / toast 主文案 */
  message: string
  /** 已自动写入计数 */
  applied: PostWriteSyncApplied
  /** 仍需用户确认的新增项 */
  pending: PostWriteSyncPending
  /** memory + settings 错误合集（去空） */
  errors: string[]
  /** 是否有任何自动写入 */
  hasAutoWrites: boolean
  /** 是否有待确认项 */
  hasPendingConfirms: boolean
}

export interface PostWriteSyncInput {
  memory: {
    applied: {
      stateChanges: number
      plotPoints: number
      collected: number
      characters?: number
      locations?: number
      items?: number
      foreshadowings?: number
    }
    errors: string[]
  }
  settings: {
    applied: number
    skipped?: number
    errors: string[]
  }
  extraction: {
    newCharacters?: unknown[]
    newLocations?: unknown[]
    newItems?: unknown[]
    newForeshadowings?: unknown[]
    settingsPatches?: { confidence?: string }[]
    settingsSuggestions?: unknown[]
  }
  /** 写后自检清单对照（可选） */
  selfCheck?: {
    ok: boolean
    summary: string
    counts?: { fail?: number; warn?: number; pass?: number }
  } | null
}

function n(v: number | undefined): number {
  return typeof v === 'number' && v > 0 ? v : 0
}

function len(arr: unknown[] | undefined): number {
  return Array.isArray(arr) ? arr.length : 0
}

/** 统计 extraction 中仍需用户确认的项 */
export function countPendingConfirms(extraction: PostWriteSyncInput['extraction']): PostWriteSyncPending {
  const patches = extraction.settingsPatches ?? []
  const settingsConfirm = patches.filter((p) => p.confidence !== 'high').length
  return {
    characters: len(extraction.newCharacters),
    locations: len(extraction.newLocations),
    items: len(extraction.newItems),
    foreshadowings: len(extraction.newForeshadowings),
    settingsConfirm,
    suggestions: len(extraction.settingsSuggestions)
  }
}

function formatAppliedParts(a: PostWriteSyncApplied): string[] {
  const parts: string[] = []
  if (a.stateChanges > 0) parts.push(`状态 ${a.stateChanges}`)
  if (a.plotPoints > 0) parts.push(`情节 ${a.plotPoints}`)
  if (a.collected > 0) parts.push(`伏笔 ${a.collected}`)
  if (a.settings > 0) parts.push(`设定 ${a.settings}`)
  return parts
}

function formatPendingParts(p: PostWriteSyncPending): string[] {
  const parts: string[] = []
  if (p.characters > 0) parts.push(`新角色 ${p.characters}`)
  if (p.locations > 0) parts.push(`新地点 ${p.locations}`)
  if (p.items > 0) parts.push(`新道具 ${p.items}`)
  if (p.foreshadowings > 0) parts.push(`新伏笔 ${p.foreshadowings}`)
  if (p.settingsConfirm > 0) parts.push(`设定待确认 ${p.settingsConfirm}`)
  if (p.suggestions > 0) parts.push(`设定建议 ${p.suggestions}`)
  return parts
}

/**
 * 将 syncChapterAfterWrite 结果收成 UI 可用摘要。
 * - failed：无任何自动写入且存在错误（提取失败 / 全失败）
 * - partial：有错误，或仅有待确认项而无自动写入但提取成功也可 ok；有错误 + 部分成功 → partial
 * - ok：无错误
 */
export function summarizePostWriteSync(input: PostWriteSyncInput): PostWriteSyncSummary {
  const applied: PostWriteSyncApplied = {
    stateChanges: n(input.memory.applied.stateChanges),
    plotPoints: n(input.memory.applied.plotPoints),
    collected: n(input.memory.applied.collected),
    settings: n(input.settings.applied)
  }
  const pending = countPendingConfirms(input.extraction)
  const errors = [
    ...(input.memory.errors ?? []),
    ...(input.settings.errors ?? [])
  ].filter((e) => typeof e === 'string' && e.trim().length > 0)

  const hasAutoWrites =
    applied.stateChanges + applied.plotPoints + applied.collected + applied.settings > 0
  const hasPendingConfirms =
    pending.characters +
      pending.locations +
      pending.items +
      pending.foreshadowings +
      pending.settingsConfirm +
      pending.suggestions >
    0

  let phase: PostWriteSyncSummary['phase']
  if (errors.length > 0 && !hasAutoWrites) {
    phase = 'failed'
  } else if (errors.length > 0) {
    phase = 'partial'
  } else {
    phase = 'ok'
  }

  const appliedParts = formatAppliedParts(applied)
  const pendingParts = formatPendingParts(pending)
  let message: string

  if (phase === 'failed') {
    const first = errors[0] ?? '未知错误'
    message =
      first.length > 80
        ? `同步失败：${first.slice(0, 80)}…`
        : `同步失败：${first}`
  } else if (phase === 'partial') {
    const base =
      appliedParts.length > 0
        ? `部分同步：${appliedParts.join(' · ')}`
        : '部分同步'
    message = `${base}（${errors.length} 项失败）`
  } else {
    // ok
    if (appliedParts.length > 0 && pendingParts.length > 0) {
      message = `已同步 ${appliedParts.join(' · ')}；待确认 ${pendingParts.join(' · ')}`
    } else if (appliedParts.length > 0) {
      message = `已同步 ${appliedParts.join(' · ')}`
    } else if (pendingParts.length > 0) {
      message = `记忆已提取，待确认 ${pendingParts.join(' · ')}`
    } else {
      message = '已同步（本章无新增状态/设定）'
    }
  }

  // 附加写后自检摘要：不抬升同步 phase（避免「自检未过」被当成「同步失败」）
  const sc = input.selfCheck
  if (sc && typeof sc.summary === 'string' && sc.summary.trim()) {
    message = `${message}；${sc.summary}`
  }

  return {
    phase,
    message,
    applied,
    pending,
    errors,
    hasAutoWrites,
    hasPendingConfirms
  }
}

/** 写后同步错误码 → 短中文（状态条 / 记忆面板共用） */
export function friendlySyncError(err: string): string {
  const e = err.trim()
  if (!e) return '同步失败'
  if (e === 'LLM_OUTPUT_TRUNCATED' || /output.?truncated/i.test(e)) {
    return '模型输出被截断，请点「补跑同步」重试'
  }
  if (e === 'LLM_TIMEOUT' || /aborted due to timeout/i.test(e)) {
    return '同步超时，请重试'
  }
  if (e === 'LLM_RATE_LIMIT') return '请求过于频繁，请稍后再试'
  if (e === 'LLM_ABORTED') return '已取消'
  if (e === 'LLM_AUTH_FAILED' || e === 'NO_KEY' || e === 'LLM_NOT_CONFIGURED') {
    return '模型未配置或鉴权失败'
  }
  if (e.startsWith('LLM_REQUEST_FAILED')) return '模型请求失败'
  return e.length > 60 ? `${e.slice(0, 60)}…` : e
}

/** 失败时用于状态条的短错误文案 */
export function formatSyncErrorHint(errors: string[], max = 2): string {
  if (errors.length === 0) return ''
  const shown = errors.slice(0, max).map((e) => friendlySyncError(e))
  const more = errors.length > max ? ` 等 ${errors.length} 条` : ''
  return shown.join('；') + more
}
