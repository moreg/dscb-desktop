import type { DetailedOutlineItem, Foreshadowing } from '../../shared/types'
import { isOpenForeshadowing } from './foreshadowingBoardState'
export { parseForeshadowReceipt, type ForeshadowReceipt } from '../../shared/parsers'

export type ReminderKind = 'plant' | 'reinforce' | 'collect'
export type ReminderSource = 'outline' | 'library'

export interface ForeshadowingReminderItem {
  kind: ReminderKind
  source: ReminderSource
  content: string
  id?: string
  plantChapter?: number
  expectedCollect?: number
  note?: string
  /** A missed planned date prompts reassessment, not a forced reveal. */
  overdue?: boolean
  lastProgressChapter?: number
}

export interface ForeshadowingReminders {
  plant: ForeshadowingReminderItem[]
  reinforce: ForeshadowingReminderItem[]
  collect: ForeshadowingReminderItem[]
}

function unique(items: ForeshadowingReminderItem[]): ForeshadowingReminderItem[] {
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const content = item.content.trim()
    const key = item.id ? `id:${item.id}` : `text:${content}`
    if (!content || seen.has(key)) return []
    seen.add(key)
    return [{ ...item, content }]
  })
}

function reminder(kind: ReminderKind, f: Foreshadowing): ForeshadowingReminderItem {
  return { kind, source: 'library', content: f.content, id: f.id, plantChapter: f.plantChapter,
    expectedCollect: f.expectedCollect, note: f.note }
}

function asOfChapter(f: Foreshadowing, chapter: number): Foreshadowing {
  const reinforcementChapters = (f.reinforcementChapters ?? []).filter((n) => n <= chapter)
  const partialCollectChapters = (f.partialCollectChapters ?? []).filter((n) => n <= chapter)
  if (f.plantChapter != null && f.plantChapter > chapter) {
    return { ...f, status: 'pending', reinforcementChapters: [], partialCollectChapters: [], actualCollect: undefined }
  }
  if (f.status === 'collected' && f.actualCollect != null && f.actualCollect > chapter) {
    return { ...f, status: partialCollectChapters.length ? 'partial' : reinforcementChapters.length ? 'reinforced' : 'planted',
      reinforcementChapters, partialCollectChapters, actualCollect: undefined }
  }
  return { ...f, reinforcementChapters, partialCollectChapters }
}

export function buildForeshadowingReminders(
  chapterNumber: number,
  chapterOutline: DetailedOutlineItem | null,
  foreshadowings: Foreshadowing[]
): ForeshadowingReminders {
  const library = foreshadowings.map((item) => asOfChapter(item, chapterNumber))
  const outlineNames = new Set(chapterOutline?.chapterNumber === chapterNumber
    ? (chapterOutline.foreshadowings ?? []).map((text) => text.trim()).filter(Boolean) : [])
  const plant: ForeshadowingReminderItem[] = []
  const reinforce: ForeshadowingReminderItem[] = []
  const collect: ForeshadowingReminderItem[] = []
  for (const content of outlineNames) {
    const matches = library.filter((item) => item.content.trim() === content)
    if (matches.length === 0) plant.push({ kind: 'plant', source: 'outline', content })
    for (const item of matches) {
      if (item.status === 'pending') plant.push(reminder('plant', item))
    }
  }
  for (const item of library) {
    if (item.status === 'pending' && item.plantChapter === chapterNumber) plant.push(reminder('plant', item))
    if (!isOpenForeshadowing(item) || item.plantChapter == null || item.plantChapter > chapterNumber) continue
    if (item.expectedCollect != null && item.expectedCollect <= chapterNumber) {
      collect.push({ ...reminder('collect', item), overdue: item.expectedCollect < chapterNumber })
      continue
    }
    const lastProgressChapter = Math.max(item.plantChapter,
      ...(item.reinforcementChapters ?? []), ...(item.partialCollectChapters ?? []))
    if (lastProgressChapter < chapterNumber &&
      (outlineNames.has(item.content.trim()) || chapterNumber - lastProgressChapter >= 12)) {
      reinforce.push({ ...reminder('reinforce', item), lastProgressChapter })
    }
  }
  reinforce.sort((a, b) => Number(outlineNames.has(b.content.trim())) - Number(outlineNames.has(a.content.trim())) ||
    (a.lastProgressChapter ?? 0) - (b.lastProgressChapter ?? 0))
  collect.sort((a, b) => (a.expectedCollect ?? 0) - (b.expectedCollect ?? 0))
  const reinforcement = unique(reinforce)
  // Limit background reminders, but never hide explicit outline references behind that limit.
  const limit = Math.max(8, reinforcement.filter((item) => outlineNames.has(item.content)).length)
  return { plant: unique(plant), reinforce: reinforcement.slice(0, limit), collect: unique(collect) }
}
