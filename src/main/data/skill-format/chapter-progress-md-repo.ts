import { join } from 'path'
import { readText, parseDoc, parseTable } from './md-parser'

export interface ChapterProgressEntry {
  chapter: number
  /** v3.2 原始状态文本（待生成细纲 / 已生成细纲 …） */
  statusText?: string
  wordCount?: number
  note?: string
}

/**
 * 读取章节进度。真相源：`记忆系统/章节进度.md`。
 * 解析每卷的章节表（章节|标题|状态|字数|备注）→ Map<章号, 进度>。
 * 用于补全 ChapterMeta 的 status/wordCount/note。
 */
export class ChapterProgressMdRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<Map<number, ChapterProgressEntry>> {
    const text = await readText(join(this.projectDir, '记忆系统', '章节进度.md'))
    if (!text) return new Map()
    const doc = parseDoc(text)
    const map = new Map<number, ChapterProgressEntry>()
    for (const section of doc.sections) {
      const { headers, rows } = parseTable(section.body)
      if (headers.length < 4) continue
      const idxCh = headers.findIndex((h) => h.includes('章节'))
      const idxTitle = headers.findIndex((h) => h.includes('标题'))
      const idxStatus = headers.findIndex((h) => h.includes('状态'))
      const idxWord = headers.findIndex((h) => h.includes('字数'))
      const idxNote = headers.findIndex((h) => h.includes('备注'))
      for (const row of rows) {
        const chText = idxCh >= 0 ? row[idxCh] : idxTitle >= 0 ? row[idxTitle] : ''
        // 跳过范围行（「第 61-90 章」是卷摘要，非单章）
        if (/第\s*\d+\s*[-–—]\s*\d+\s*章/.test(chText)) continue
        const cm = chText.match(/(\d+)/)
        if (!cm) continue
        const chapter = parseInt(cm[1], 10)
        const wordText = idxWord >= 0 ? row[idxWord] : ''
        const wm = wordText.match(/(\d+)/)
        map.set(chapter, {
          chapter,
          statusText: idxStatus >= 0 ? row[idxStatus] || undefined : undefined,
          wordCount: wm ? parseInt(wm[1], 10) : undefined,
          note: idxNote >= 0 ? row[idxNote] || undefined : undefined
        })
      }
    }
    return map
  }
}
