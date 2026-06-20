import type { DetailedOutlineItem, Foreshadowing } from '../../shared/types'

export interface ForeshadowingReminders {
  /** 本章细纲里直接写明要铺设的伏笔 */
  outline: string[]
  /** 伏笔库里仍未埋设/待强化的伏笔 */
  toPlant: string[]
  /** 已埋设且预计本章回收的伏笔 */
  toCollect: string[]
}

function compactUnique(items: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = item?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function buildForeshadowingReminders(
  chapterNumber: number,
  chapterOutline: DetailedOutlineItem | null,
  foreshadowings: Foreshadowing[]
): ForeshadowingReminders {
  const outline =
    chapterOutline?.chapterNumber === chapterNumber
      ? compactUnique(chapterOutline.foreshadowings ?? [])
      : []

  const toPlant = compactUnique(
    foreshadowings
      .filter((f) => f.status === 'pending')
      .map((f) => f.content)
  )

  const toCollect = compactUnique(
    foreshadowings
      .filter((f) => f.status === 'planted' && f.expectedCollect === chapterNumber)
      .map((f) => f.content)
  )

  return { outline, toPlant, toCollect }
}
