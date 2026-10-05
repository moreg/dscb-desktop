import { SHORT_STORY_PRESETS } from '../../shared/short-story'
import type { ShortStoryCreateInput, ShortStoryIdea, ShortStoryKind } from '../../shared/short-story'

export const SHORT_STORY_CREATE_DRAFT_PREFIX = 'ai-writer:short-story:create-draft:'

export interface ShortStoryCreateDraft {
  input: ShortStoryCreateInput
  /** 仅自动填入的标题可随下一次采用脑洞更新，手动编辑时清空。 */
  autoTitle: string
  savedAt: number
}

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface DraftRead {
  draft: ShortStoryCreateDraft | null
  warning: string
}

interface DraftWrite {
  ok: boolean
  warning: string
  preservedNewerDraft?: boolean
}

// 完成创建后的清理即使被浏览器拒绝，也不能在本次运行中重新恢复为未创建表单。
const completedByStorage = new WeakMap<DraftStorage, Set<ShortStoryKind>>()
const completedDefaultKinds = new Set<ShortStoryKind>()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function warning(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cache(storage?: DraftStorage): DraftStorage {
  return storage ?? window.localStorage
}

export function newShortStoryCreateDraft(kind: ShortStoryKind, savedAt = Date.now()): ShortStoryCreateDraft {
  return { input: { title: '', kind, genre: '', brief: '', requirements: '',
    targetWords: SHORT_STORY_PRESETS[kind].targetWords, sectionCount: SHORT_STORY_PRESETS[kind].sectionCount }, autoTitle: '', savedAt }
}

export function validShortStoryCreateDraft(value: unknown, kind: ShortStoryKind): value is ShortStoryCreateDraft {
  if (!record(value) || !record(value.input) || value.input.kind !== kind ||
    typeof value.autoTitle !== 'string' || value.autoTitle.length > 120 ||
    !Number.isSafeInteger(value.savedAt) || Number(value.savedAt) < 0) return false
  const input = value.input
  const limits = { title: 120, genre: 200, brief: 10000, requirements: 10000 }
  if (Object.entries(limits).some(([field, limit]) => typeof input[field] !== 'string' || String(input[field]).length > limit)) return false
  // 新建草稿允许空标题、清空后得到的 0，以及尚未达到创建条件的预算。
  return Number.isInteger(input.targetWords) && Number(input.targetWords) >= 0 && Number(input.targetWords) <= 120000 &&
    Number.isInteger(input.sectionCount) && Number(input.sectionCount) >= 0 && Number(input.sectionCount) <= 60
}

export function editShortStoryCreateDraft(draft: ShortStoryCreateDraft, changes: Partial<ShortStoryCreateInput>): ShortStoryCreateDraft {
  return { input: { ...draft.input, ...changes }, autoTitle: changes.title !== undefined ? '' : draft.autoTitle,
    savedAt: Math.max(Date.now(), draft.savedAt + 1) }
}

export function adoptShortStoryCreateIdea(draft: ShortStoryCreateDraft, idea: ShortStoryIdea, brief: string): ShortStoryCreateDraft {
  const fillTitle = !draft.input.title.trim() || draft.input.title === draft.autoTitle
  return { input: { ...draft.input, title: fillTitle ? idea.title : draft.input.title, brief },
    autoTitle: fillTitle ? idea.title : draft.autoTitle, savedAt: Math.max(Date.now(), draft.savedAt + 1) }
}

export function sameShortStoryCreateDraftVersion(left: ShortStoryCreateDraft, right: ShortStoryCreateDraft): boolean {
  const fields = ['title', 'kind', 'genre', 'brief', 'requirements', 'targetWords', 'sectionCount'] as const
  return left.savedAt === right.savedAt && left.autoTitle === right.autoTitle && fields.every(field => left.input[field] === right.input[field])
}

export function readShortStoryCreateDraft(kind: ShortStoryKind, storage?: DraftStorage): DraftRead {
  try {
    const target = cache(storage)
    const raw = target.getItem(SHORT_STORY_CREATE_DRAFT_PREFIX + kind)
    if (!raw) return { draft: null, warning: '' }
    if ((!storage && completedDefaultKinds.has(kind)) || completedByStorage.get(target)?.has(kind)) {
      return { draft: null, warning: '该新建草稿已创建为作品，缓存清理未完成，已停止自动恢复。' }
    }
    if (raw.length > 100000) throw new Error('记录长度超出范围')
    const value: unknown = JSON.parse(raw)
    if (record(value) && value.version === 1 && value.kind === kind && typeof value.createdId === 'string') {
      return { draft: null, warning: '上次作品已创建，本地草稿清理未完成，不会重复恢复新建表单。' }
    }
    if (!record(value) || value.version !== 1 || !validShortStoryCreateDraft(value.draft, kind)) {
      throw new Error('记录格式或字段范围有误')
    }
    const draft = value.draft
    return { draft: { input: { ...draft.input }, autoTitle: draft.autoTitle === draft.input.title ? draft.autoTitle : '', savedAt: draft.savedAt }, warning: '' }
  } catch (error) {
    return { draft: null, warning: `无法恢复${SHORT_STORY_PRESETS[kind].label}新建草稿：${warning(error)}。现有作品仍可正常打开。` }
  }
}

export function readLatestShortStoryCreateDraft(storage?: DraftStorage): DraftRead {
  const reads = (['short', 'medium'] as const).map(kind => readShortStoryCreateDraft(kind, storage))
  const drafts = reads.flatMap(item => item.draft ? [item.draft] : []).sort((a, b) => b.savedAt - a.savedAt)
  return { draft: drafts[0] ?? null, warning: reads.map(item => item.warning).filter(Boolean).join(' ') }
}

export function writeShortStoryCreateDraft(draft: ShortStoryCreateDraft, storage?: DraftStorage): DraftWrite {
  if (!validShortStoryCreateDraft(draft, draft.input.kind)) {
    return { ok: false, warning: '新建草稿有字段超出范围，请修正数字或缩短文本；也可以先复制新建草稿。' }
  }
  try {
    const target = cache(storage)
    const key = SHORT_STORY_CREATE_DRAFT_PREFIX + draft.input.kind
    const raw = JSON.stringify({ version: 1, draft })
    target.setItem(key, raw)
    if (target.getItem(key) !== raw) throw new Error('写入后未能读取完整记录')
    completedByStorage.get(target)?.delete(draft.input.kind)
    if (!storage) completedDefaultKinds.delete(draft.input.kind)
    return { ok: true, warning: '' }
  } catch (error) {
    return { ok: false, warning: `无法自动保存${SHORT_STORY_PRESETS[draft.input.kind].label}新建草稿，请先复制：${warning(error)}` }
  }
}

export function clearShortStoryCreateDraft(kind: ShortStoryKind, storage?: DraftStorage): DraftWrite {
  try {
    const target = cache(storage)
    const key = SHORT_STORY_CREATE_DRAFT_PREFIX + kind
    target.removeItem(key)
    if (target.getItem(key) !== null) throw new Error('删除后记录仍存在')
    return { ok: true, warning: '' }
  } catch (error) {
    return { ok: false, warning: `无法丢弃${SHORT_STORY_PRESETS[kind].label}新建草稿，内容仍保留：${warning(error)}` }
  }
}

export function completeShortStoryCreateDraft(kind: ShortStoryKind, createdId: string, storage?: DraftStorage,
  submitted?: ShortStoryCreateDraft): DraftWrite {
  try {
    const target = cache(storage)
    const key = SHORT_STORY_CREATE_DRAFT_PREFIX + kind
    if (submitted) {
      const current = readShortStoryCreateDraft(kind, target).draft
      if (current && (current.savedAt > submitted.savedAt ||
        (current.savedAt === submitted.savedAt && !sameShortStoryCreateDraftVersion(current, submitted)))) {
        // 旧请求结束时，新挂载的栏目可能已经继续编辑同类表单；不能清掉新版本。
        return { ok: true, warning: '作品已创建；检测到后来更新的新建草稿，已保留新的表单内容。', preservedNewerDraft: true }
      }
    }
    if (!storage) completedDefaultKinds.add(kind)
    const completed = completedByStorage.get(target) ?? new Set<ShortStoryKind>()
    completed.add(kind); completedByStorage.set(target, completed)
    let markerWritten = false
    try {
      const marker = JSON.stringify({ version: 1, kind, createdId })
      target.setItem(key, marker)
      markerWritten = target.getItem(key) === marker
    } catch { /* 清理成功仍可完成；清理失败时保留内存中的已创建标记。 */ }
    const cleared = clearShortStoryCreateDraft(kind, target)
    if (cleared.ok) return cleared
    return { ok: false, warning: markerWritten
      ? '作品已创建，但新建草稿缓存清理失败；已标记为已创建，不会自动重复恢复。'
      : '作品已创建，但新建草稿缓存清理失败；本次运行不会重复恢复，请勿根据旧草稿再次创建同一作品。' }
  } catch (error) {
    if (!storage) completedDefaultKinds.add(kind)
    return { ok: false, warning: `作品已创建，但无法清理新建草稿缓存，请勿再次创建同一作品：${warning(error)}` }
  }
}

export function shortStoryCreateDraftText(draft: ShortStoryCreateDraft): string {
  const input = draft.input
  return `# ${input.title || '未命名新建草稿'}\n\n篇幅：${SHORT_STORY_PRESETS[input.kind].label}\n题材：${input.genre}\n全文目标：${input.targetWords || '待填写'} 字\n分节数：${input.sectionCount || '待填写'}\n\n## 故事梗概\n\n${input.brief}\n\n## 写作要求\n\n${input.requirements}\n`
}
