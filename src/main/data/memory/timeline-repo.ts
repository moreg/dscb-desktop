import { join } from 'path'
import { readText, parseDoc, parseTable, parseBoldFields } from '../skill-format/md-parser'
import { hashName } from './entity-helpers'
import type { MemoryEntity } from '../../../shared/types'

/**
 * 时间线 repo。真相源 = 追踪/时间线.md 的时间线表。
 * 兼容两种结构：
 * - H2 节（标题含「对照」/「历史事件」）下的表（技能规范格式）
 * - H1 `# 时间线` 下的裸表（开书流程 writeTrackingFiles 产出的格式）
 * 不写：派生结果写入 记忆/时间线/ 由 syncService 维护。
 */

/** 时间线表列索引（按表头关键字匹配，-1 表示无该列） */
export interface TimelineColumnIndex {
  idxTime: number
  idxHistory: number
  idxEvent: number
  idxChapter: number
  idxVolume: number
}

/** 从时间线文件文本解析出表格。回退顺序：H2 对照节 -> H1 下裸表。 */
export function parseTimelineTable(
  text: string
): { headers: string[]; rows: string[][]; body: string } {
  if (!text) return { headers: [], rows: [], body: '' }
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('对照') || s.title.includes('历史事件'))
  const tableBody = sec ? sec.body : doc.body
  const { headers, rows } = parseTable(tableBody)
  return { headers, rows, body: tableBody.trim() }
}

/** 按表头关键字匹配列索引。「事件名」/「小说事件」均算事件列，排除「历史事件」。 */
export function indexTimelineColumns(headers: string[]): TimelineColumnIndex {
  return {
    idxTime: headers.findIndex((h) => h.includes('时间') && !h.includes('时间跨度')),
    idxHistory: headers.findIndex((h) => h.includes('历史')),
    idxEvent: headers.findIndex(
      (h) => (h.includes('事件') || h.includes('小说')) && !h.includes('历史')
    ),
    idxChapter: headers.findIndex((h) => h.includes('章节')),
    idxVolume: headers.findIndex((h) => h.includes('卷'))
  }
}
export class TimelineRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const text = await readText(join(this.projectDir, '追踪', '时间线.md'))
    if (!text) return []
    const { headers, rows } = parseTimelineTable(text)
    if (headers.length < 3) return []

    const { idxTime, idxHistory, idxEvent, idxChapter, idxVolume } = indexTimelineColumns(headers)

    const now = new Date().toISOString()
    const out: MemoryEntity[] = []
    for (const row of rows) {
      const name = idxEvent >= 0 ? row[idxEvent]?.trim() : ''
      if (!name) continue
      const customFields: Record<string, string | string[]> = {}
      if (idxTime >= 0) customFields['时间'] = row[idxTime]?.trim() ?? ''
      if (idxHistory >= 0) customFields['历史事件'] = row[idxHistory]?.trim() ?? ''
      if (idxChapter >= 0) customFields['对应章节'] = row[idxChapter]?.trim() ?? ''
      if (idxVolume >= 0) customFields['对应卷'] = row[idxVolume]?.trim() ?? ''
      out.push({
        id: `tl-${hashName(name)}`,
        type: 'timeline',
        name,
        notes: idxHistory >= 0 ? row[idxHistory]?.trim() : undefined,
        customFields,
        sources: [{ path: '追踪/时间线.md', mtime: now }],
        createdAt: now,
        updatedAt: now
      })
    }
    return out
  }
}