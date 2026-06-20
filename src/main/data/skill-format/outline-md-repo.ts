import { join } from 'path'
import { readText, parseDoc, findSection, parseSubsections, parseTable, parseVolumeNumber } from './md-parser'
import type { MainOutline, Volume, RhythmEntry } from '../../../shared/types'

export interface OutlineMdRead {
  main: MainOutline
  volumes: Volume[]
  /**
   * 逐章节奏，来自 `大纲.md` 的「逐章节奏标注」表。
   * 这是 rhythmData html 缺失时的回退源；有 html 时以 html 为准。
   * 大纲表全部是预测值，actualized 固定 false。
   */
  rhythmFallback: RhythmEntry[]
}

/**
 * 读取大纲。真相源：`大纲/大纲.md`。
 * 解析：主线概要、卷结构（来自「## 主线剧情走向」的 H3）、逐章节奏（来自「## 逐章节奏标注」表）。
 */
export class OutlineMdRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<OutlineMdRead | null> {
    const file = join(this.projectDir, '大纲', '大纲.md')
    const text = await readText(file)
    if (!text) return null
    const doc = parseDoc(text)

    const mainLineSection = findSection(doc, '主线剧情走向')
    const volumes = mainLineSection ? extractVolumes(mainLineSection.body) : []

    const main: MainOutline = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      synopsis: extractSynopsis(doc, mainLineSection),
      mainLine: volumes.length
        ? volumes.map((v) => `第${v.number}卷（第${v.chapterStart}-${v.chapterEnd}章）：${v.name}`).join('\n')
        : (mainLineSection?.body.trim() ?? '')
    }

    const rhythmFallback = extractRhythmFallback(doc)
    return { main, volumes, rhythmFallback }
  }
}

function extractSynopsis(doc: ReturnType<typeof parseDoc>, mainLineSection: ReturnType<typeof findSection>): string {
  // 主线剧情走向 section 在首个 H3 之前的引言部分作为总纲
  if (mainLineSection) {
    const subs = parseSubsections(mainLineSection.body)
    if (subs.length > 0) {
      const firstH3 = mainLineSection.body.indexOf('###')
      if (firstH3 > 0) return mainLineSection.body.slice(0, firstH3).trim()
    } else {
      return mainLineSection.body.trim()
    }
  }
  return ''
}

/** 从「主线剧情走向」的 H3 `### 第N卷：卷名（第X-Y章）` 提取卷结构 */
function extractVolumes(body: string): Volume[] {
  const subs = parseSubsections(body)
  const volumes: Volume[] = []
  for (const sub of subs) {
    const v = parseVolumeHeading(sub.title)
    if (v) volumes.push(v)
  }
  return volumes
}

function parseVolumeHeading(title: string): Volume | null {
  const number = parseVolumeNumber(title)
  if (number == null) return null
  // 卷名：在 `：` 和 `（`/`(` 之间
  const nameMatch = title.match(/[：:]\s*([^\n（(]+)/)
  const name = nameMatch ? nameMatch[1].trim() : ''
  const rangeMatch = title.match(/第\s*(\d+)\s*[-–—]\s*(\d+)\s*章/)
  return {
    number,
    name,
    chapterStart: rangeMatch ? parseInt(rangeMatch[1], 10) : 0,
    chapterEnd: rangeMatch ? parseInt(rangeMatch[2], 10) : 0
  }
}

/** 从「逐章节奏标注」的所有 H3 子表提取逐章节奏 */
function extractRhythmFallback(doc: ReturnType<typeof parseDoc>): RhythmEntry[] {
  const sec = findSection(doc, '逐章节奏标注')
  if (!sec) return []
  const entries: RhythmEntry[] = []
  for (const sub of parseSubsections(sec.body)) {
    const volNumMatch = sub.title.match(/第\s*(\d+)\s*卷/)
    const volDefault = volNumMatch ? parseInt(volNumMatch[1], 10) : 0
    const { headers, rows } = parseTable(sub.body)
    if (headers.length < 4) continue
    // 列定位：章节 / 标题 / 情绪值 / 爽点类型 / 卷
    const idxChapter = headers.findIndex((h) => h.includes('章节'))
    const idxTitle = headers.findIndex((h) => h.includes('标题'))
    const idxEmotion = headers.findIndex((h) => h.includes('情绪'))
    const idxClimax = headers.findIndex((h) => h.includes('爽点'))
    const idxVolume = headers.findIndex((h) => h.includes('卷'))
    for (const row of rows) {
      const chapterText = idxChapter >= 0 ? row[idxChapter] : ''
      const cm = chapterText.match(/(\d+)/)
      if (!cm) continue
      const chapter = parseInt(cm[1], 10)
      const title = idxTitle >= 0 ? row[idxTitle] : ''
      const emotion = idxEmotion >= 0 ? num(row[idxEmotion]) : 0
      const climax = idxClimax >= 0 ? num(row[idxClimax]) : 0
      const volume = idxVolume >= 0 ? num(row[idxVolume]) || volDefault : volDefault
      entries.push({ chapter, title, emotion, climax, volume, actualized: false })
    }
  }
  return entries
}

function num(s: string | undefined): number {
  if (!s) return 0
  const m = s.match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : 0
}
