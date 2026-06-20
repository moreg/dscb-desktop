import type { DetailedOutlineItem } from '../../shared/types'

export interface OutlineDetailRow {
  label: string
  value?: string
  items?: string[]
}

const CLIMAX_LABELS = ['无爽点', '小打脸', '中打脸', '大高潮', '卷中决战', '卷终决战']

function climaxLabel(value: number): string {
  if (value >= 4) return CLIMAX_LABELS[5]
  if (value >= 3.25) return CLIMAX_LABELS[4]
  if (value >= 3) return CLIMAX_LABELS[3]
  if (value >= 2) return CLIMAX_LABELS[2]
  if (value >= 1) return CLIMAX_LABELS[1]
  return CLIMAX_LABELS[0]
}

function cleanList(items: string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items ?? []) {
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function pushValue(rows: OutlineDetailRow[], label: string, value: string | undefined): void {
  const text = value?.trim()
  if (text) rows.push({ label, value: text })
}

function pushItems(rows: OutlineDetailRow[], label: string, items: string[] | undefined): void {
  const list = cleanList(items)
  if (list.length > 0) rows.push({ label, items: list })
}

export function getOutlineDetailRows(item: DetailedOutlineItem): OutlineDetailRow[] {
  const rows: OutlineDetailRow[] = []
  const rhythm: string[] = []
  if (item.emotion != null) rhythm.push(`情绪值：${item.emotion}`)
  if (item.climax != null) rhythm.push(`爽点类型：${item.climax}（${climaxLabel(item.climax)}）`)
  if (rhythm.length > 0) rows.push({ label: '节奏标注', items: rhythm })

  pushValue(rows, '核心事件', item.plotSummary)
  pushValue(rows, '爽点/打脸', item.coolPoint)
  pushItems(rows, '角色出场', item.charactersAppearing)
  pushItems(rows, '伏笔铺设', item.foreshadowings)
  pushValue(rows, '章末钩子', item.hook)
  pushValue(rows, '字数预估', item.wordEstimate)
  pushValue(rows, '金句', item.goldenLine)

  return rows
}
