import type { DetailedOutlineItem, Foreshadowing } from '../../shared/types'
// 伏笔回执解析器已迁移到 src/shared/parsers.ts（main 与 renderer 共享）
export { parseForeshadowReceipt, type ForeshadowReceipt } from '../../shared/parsers'

/**
 * 单条伏笔提醒的渲染数据。
 * - kind: 提醒类型（铺设/强化/回收），决定左侧色条与图标
 * - source: 数据来源（细纲/伏笔库），影响是否带 id
 * - content: 伏笔内容（去重后）
 * - meta: 上下文（埋设章节/预计回收章节/备注），可为空
 */
export type ReminderKind = 'plant' | 'reinforce' | 'collect'
export type ReminderSource = 'outline' | 'library'

export interface ForeshadowingReminderItem {
  kind: ReminderKind
  source: ReminderSource
  content: string
  /** 关联的伏笔 id（仅来自伏笔库时有值） */
  id?: string
  /** 元信息：埋设章节 / 预计回收章节 / 备注 */
  plantChapter?: number
  expectedCollect?: number
  note?: string
}

export interface ForeshadowingReminders {
  /** 来自本章细纲要求铺设的伏笔（最高优先级：必须在本章出现） */
  plant: ForeshadowingReminderItem[]
  /** 来自伏笔库、状态 pending、尚未铺设（建议本章铺垫或强化） */
  reinforce: ForeshadowingReminderItem[]
  /** 已铺设且 expectedCollect === 当前章节号（必须在本章回收） */
  collect: ForeshadowingReminderItem[]
}

function compactUniqueByContent(
  items: ForeshadowingReminderItem[]
): ForeshadowingReminderItem[] {
  const seen = new Set<string>()
  const out: ForeshadowingReminderItem[] = []
  for (const item of items) {
    const text = item.content?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push({ ...item, content: text })
  }
  return out
}

export function buildForeshadowingReminders(
  chapterNumber: number,
  chapterOutline: DetailedOutlineItem | null,
  foreshadowings: Foreshadowing[]
): ForeshadowingReminders {
  // 1. 铺设：细纲里写明的伏笔（细纲要求 → 必须埋）
  const plant: ForeshadowingReminderItem[] = []
  if (chapterOutline?.chapterNumber === chapterNumber) {
    for (const text of chapterOutline.foreshadowings ?? []) {
      const t = text?.trim()
      if (!t) continue
      plant.push({
        kind: 'plant',
        source: 'outline',
        content: t
      })
    }
  }
  // 细纲要求埋的伏笔如果在库里已存在，补全 id/元信息便于跳转
  for (const item of plant) {
    const matched = foreshadowings.find(
      (f) => f.content.trim() === item.content && f.status !== 'collected'
    )
    if (matched) {
      item.id = matched.id
      item.plantChapter = matched.plantChapter
      item.expectedCollect = matched.expectedCollect
      item.note = matched.note
    }
  }

  // 2. 强化：伏笔库 pending 状态（建议本章铺）
  const reinforce: ForeshadowingReminderItem[] = foreshadowings
    .filter((f) => f.status === 'pending')
    .map((f) => ({
      kind: 'reinforce' as const,
      source: 'library' as const,
      content: f.content,
      id: f.id,
      expectedCollect: f.expectedCollect,
      note: f.note
    }))

  // 3. 回收：伏笔库 planted 且 expectedCollect === 当前章节
  const collect: ForeshadowingReminderItem[] = foreshadowings
    .filter((f) => f.status === 'planted' && f.expectedCollect === chapterNumber)
    .map((f) => ({
      kind: 'collect' as const,
      source: 'library' as const,
      content: f.content,
      id: f.id,
      plantChapter: f.plantChapter,
      expectedCollect: f.expectedCollect,
      note: f.note
    }))

  return {
    plant: compactUniqueByContent(plant),
    reinforce: compactUniqueByContent(reinforce),
    collect: compactUniqueByContent(collect)
  }
}
