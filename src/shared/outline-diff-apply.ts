/**
 * 细纲对照：以正文为准回写细纲的纯函数工具。
 * main / renderer 共享，不依赖 Node API。
 */
import type {
  DetailedOutlineItem,
  OutlineDiffItem,
  OutlineDiffPatch,
  OutlineDiffResolution
} from './types'

const PATCH_STRING_KEYS = [
  'title',
  'plotSummary',
  'coolPoint',
  'hook',
  'wordEstimate',
  'goldenLine'
] as const

const PATCH_LIST_KEYS = ['charactersAppearing', 'foreshadowings'] as const

/** 像人名：2–4 个汉字/间隔号，无常见动作词 */
const NAME_TOKEN_RE = /^[\u4e00-\u9fff·•]{2,4}$/
const NAME_VERB_RE = /改成|变为|变成|改为|地点|见|发现|到达|离开|前往|来到|进入/

/** 漏写只能改正文，不能靠改细纲消掉 */
export function canUpdateOutlineFromDiff(diff: OutlineDiffItem): boolean {
  if (diff.type === 1) return false
  if (diff.resolution === 'updateContent') return false
  return true
}

/** 类型 2/3 或 resolution 指向回写细纲时，推荐一键更新 */
export function isRecommendedOutlineUpdate(diff: OutlineDiffItem): boolean {
  if (!canUpdateOutlineFromDiff(diff)) return false
  if (diff.resolution === 'updateOutline' || diff.resolution === 'either') return true
  return diff.type === 2 || diff.type === 3
}

/** 核心事件改 / 结构性偏离：回写前需用户确认 */
export function needsConfirmOutlineUpdate(diff: OutlineDiffItem): boolean {
  if (diff.resolution === 'review') return true
  return diff.type === 4 || diff.type === 5
}

/** 从类型推断默认 resolution（LLM 未返回时） */
export function defaultResolutionForType(type: OutlineDiffItem['type']): OutlineDiffResolution {
  switch (type) {
    case 1:
      return 'updateContent'
    case 2:
      return 'updateOutline'
    case 3:
      return 'either'
    case 4:
    case 5:
      return 'review'
    default:
      return 'review'
  }
}

function uniqStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const s = String(raw ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 清洗 LLM / 调用方给出的 outlinePatch */
export function sanitizeOutlinePatch(raw: unknown): OutlineDiffPatch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const patch: OutlineDiffPatch = {}

  for (const key of PATCH_STRING_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) {
      patch[key] = v.trim()
    }
  }
  for (const key of PATCH_LIST_KEYS) {
    const v = obj[key]
    if (Array.isArray(v)) {
      const list = uniqStrings(v.filter((x) => typeof x === 'string') as string[])
      if (list.length > 0) patch[key] = list
    } else if (typeof v === 'string' && v.trim()) {
      patch[key] = uniqStrings(v.split(/[、,，;；]/).map((s) => s.trim()))
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

/** actual 是否更像 diff 片段而非完整核心事件句 */
function looksLikePlotDelta(actual: string, base: string): boolean {
  if (!base) return false
  if (/[→→]|改成|变为|变成|改为/.test(actual)) return true
  if (actual.length < Math.min(40, base.length)) return true
  if (actual.length < 40 && !/[。！？；]/.test(actual)) return true
  return false
}

function appendPlotSummary(base: string, actual: string, tag: string): string {
  const b = base.trim()
  const a = actual.trim()
  if (!b) return a
  if (!a) return b
  if (b.includes(a)) return b
  return `${b}；${tag}：${a}`
}

/**
 * 无 outlinePatch 时，用 actual 文本按类型做兜底补丁。
 * 兜底偏保守：默认写 plotSummary；仅明确人名列表才进 charactersAppearing。
 */
export function buildFallbackOutlinePatch(
  diff: OutlineDiffItem,
  current?: Partial<DetailedOutlineItem> | null
): OutlineDiffPatch | null {
  const actual = (diff.actual ?? '').trim()
  if (!actual) return null

  switch (diff.type) {
    case 2: {
      if (/伏笔/.test(actual) || /埋下|回收|暗示/.test(actual)) {
        return { foreshadowings: [actual.replace(/^伏笔[：:]\s*/, '')] }
      }

      const hasRolePrefix = /^(新角色|角色出场|角色|出场)[：:\s]/u.test(actual)
      const nameChunk = actual.replace(/^(新角色|角色出场|角色|出场)[：:\s]*/u, '').trim()
      const names = uniqStrings(nameChunk.split(/[、,，;；\s]+/).map((s) => s.trim()))
      const allLookLikeNames =
        names.length > 0 &&
        names.every((n) => NAME_TOKEN_RE.test(n) && !NAME_VERB_RE.test(n))
      const hasListSep = /[、,，;；]/.test(actual) || names.length > 1
      const looksLikeSingleName = names.length === 1 && NAME_TOKEN_RE.test(names[0]!)
      // 仅：带角色前缀 / 明确列表 / 单一 2–4 字人名
      if (
        allLookLikeNames &&
        names.length <= 6 &&
        actual.length <= 40 &&
        (hasRolePrefix || hasListSep || looksLikeSingleName)
      ) {
        return { charactersAppearing: names }
      }

      const base = (current?.plotSummary ?? '').trim()
      return { plotSummary: appendPlotSummary(base, actual, '另（正文增量）') }
    }
    case 3:
    case 4: {
      const base = (current?.plotSummary ?? '').trim()
      if (looksLikePlotDelta(actual, base)) {
        return { plotSummary: appendPlotSummary(base, actual, '正文调整') }
      }
      return { plotSummary: actual }
    }
    case 5:
      if (/字/.test(actual) && /\d/.test(actual)) {
        return { wordEstimate: actual }
      }
      {
        const base = (current?.plotSummary ?? '').trim()
        if (looksLikePlotDelta(actual, base)) {
          return { plotSummary: appendPlotSummary(base, actual, '正文调整') }
        }
        return { plotSummary: actual }
      }
    default:
      return null
  }
}

/**
 * 生成可写入细纲的补丁：优先 LLM outlinePatch，否则兜底。
 * 列表字段会与 current 做并集（避免覆盖掉已有出场/伏笔）。
 */
export function buildOutlinePatchFromDiff(
  diff: OutlineDiffItem,
  current?: Partial<DetailedOutlineItem> | null
): OutlineDiffPatch | null {
  if (!canUpdateOutlineFromDiff(diff)) return null

  const fromLlm = sanitizeOutlinePatch(diff.outlinePatch)
  const base = fromLlm ?? buildFallbackOutlinePatch(diff, current)
  if (!base) return null

  const patch: OutlineDiffPatch = { ...base }

  if (patch.charactersAppearing) {
    patch.charactersAppearing = uniqStrings([
      ...(current?.charactersAppearing ?? []),
      ...patch.charactersAppearing
    ])
  }
  if (patch.foreshadowings) {
    patch.foreshadowings = uniqStrings([
      ...(current?.foreshadowings ?? []),
      ...patch.foreshadowings
    ])
  }

  return patch
}

/** 把补丁叠到工作副本上（顺序应用多条 diff 时用） */
export function applyPatchToWorking(
  current: Partial<DetailedOutlineItem>,
  patch: OutlineDiffPatch
): Partial<DetailedOutlineItem> {
  const next: Partial<DetailedOutlineItem> = { ...current }
  for (const key of PATCH_STRING_KEYS) {
    if (typeof patch[key] === 'string' && patch[key]!.trim()) {
      next[key] = patch[key]!.trim()
    }
  }
  for (const key of PATCH_LIST_KEYS) {
    if (patch[key]?.length) {
      next[key] = uniqStrings([...(next[key] ?? []), ...patch[key]!])
    }
  }
  return next
}

/** 合并多条补丁：字符串后者覆盖前者，列表做并集 */
export function mergeOutlinePatches(patches: OutlineDiffPatch[]): OutlineDiffPatch {
  const merged: OutlineDiffPatch = {}
  for (const p of patches) {
    for (const key of PATCH_STRING_KEYS) {
      if (typeof p[key] === 'string' && p[key]!.trim()) {
        merged[key] = p[key]!.trim()
      }
    }
    for (const key of PATCH_LIST_KEYS) {
      if (p[key]?.length) {
        merged[key] = uniqStrings([...(merged[key] ?? []), ...p[key]!])
      }
    }
  }
  return merged
}

export interface CollectOutlinePatchesResult {
  /** 成功生成补丁的原序下标 */
  appliedIndexes: number[]
  /** 无法生成补丁的原序下标 */
  skippedIndexes: number[]
  /** 顺序叠合后的最终补丁（相对初始 current 的写入值） */
  merged: OutlineDiffPatch
  /** 叠合后的工作副本 */
  working: Partial<DetailedOutlineItem>
}

/**
 * 顺序从多条差异收集补丁：
 * - 每条基于上一轮 working 生成，避免 plotSummary last-write-wins 丢增量
 * - 只把真正产出补丁的 index 记入 appliedIndexes
 */
export function collectOutlinePatchesFromDiffs(
  items: { index: number; diff: OutlineDiffItem }[],
  current?: Partial<DetailedOutlineItem> | null
): CollectOutlinePatchesResult {
  let working: Partial<DetailedOutlineItem> = { ...(current ?? {}) }
  const appliedIndexes: number[] = []
  const skippedIndexes: number[] = []
  const patches: OutlineDiffPatch[] = []

  for (const { index, diff } of items) {
    if (!canUpdateOutlineFromDiff(diff)) {
      skippedIndexes.push(index)
      continue
    }
    const p = buildOutlinePatchFromDiff(diff, working)
    if (!p || Object.keys(p).length === 0) {
      skippedIndexes.push(index)
      continue
    }
    patches.push(p)
    appliedIndexes.push(index)
    working = applyPatchToWorking(working, p)
  }

  return {
    appliedIndexes,
    skippedIndexes,
    merged: mergeOutlinePatches(patches),
    working
  }
}

/** 人类可读的补丁预览（确认对话框用） */
export function formatOutlinePatchPreview(
  current: Partial<DetailedOutlineItem> | null | undefined,
  patch: OutlineDiffPatch
): string {
  const lines: string[] = []
  const cur = current ?? {}
  const label: Record<(typeof PATCH_STRING_KEYS)[number], string> = {
    title: '标题',
    plotSummary: '核心事件',
    coolPoint: '爽点',
    hook: '钩子',
    wordEstimate: '字数预估',
    goldenLine: '金句'
  }
  for (const key of PATCH_STRING_KEYS) {
    if (typeof patch[key] === 'string' && patch[key]!.trim()) {
      const before = (cur[key] as string | undefined)?.trim() || '（空）'
      const after = patch[key]!.trim()
      if (before === after) continue
      lines.push(`${label[key]}：\n  前：${before}\n  后：${after}`)
    }
  }
  for (const key of PATCH_LIST_KEYS) {
    if (patch[key]?.length) {
      const name = key === 'charactersAppearing' ? '角色出场' : '伏笔铺设'
      const before = (cur[key] ?? []).join('、') || '（空）'
      const after = patch[key]!.join('、')
      if (before === after) continue
      lines.push(`${name}：\n  前：${before}\n  后：${after}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : '（无字段变化）'
}

/** 计算仍待处理的差异（排除已忽略/已应用）后是否通过 */
export function recomputeOutlineDiffPassed(
  diffs: OutlineDiffItem[],
  resolvedIndexes: Iterable<number>
): boolean {
  const resolved = new Set(resolvedIndexes)
  return !diffs.some(
    (d, i) => !resolved.has(i) && (d.priority === 'P0' || d.priority === 'P1')
  )
}
