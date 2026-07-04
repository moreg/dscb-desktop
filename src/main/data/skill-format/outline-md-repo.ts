import { join } from 'path'
import { promises as fs } from 'fs'
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
 *
 * 卷结构支持双来源：
 * 1. `大纲/大纲.md` 的 H3 子节 `### 第N卷：卷名（第X-Y章）`
 * 2. 独立卷文件 `大纲/第N卷_卷名.md`（技能标准格式，H1 = `# 卷纲：第N卷 卷名（第X-Y章）`）
 */
export class OutlineMdRepo {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<OutlineMdRead | null> {
    const file = join(this.projectDir, '大纲', '大纲.md')
    const text = await readText(file)
    if (!text) return null
    const doc = parseDoc(text)

    const mainLineSection = findSection(doc, '主线剧情走向')
    const volumesFromMain = mainLineSection ? extractVolumes(mainLineSection.body) : []

    // 补充：扫描独立卷文件 大纲/第N卷_卷名.md
    const volumesFromFiles = await this.readVolumeFiles()

    // 合并去重（以卷号为准，大纲.md 内的优先）
    const volumeMap = new Map<number, Volume>()
    for (const v of volumesFromFiles) volumeMap.set(v.number, v)
    for (const v of volumesFromMain) volumeMap.set(v.number, v) // 大纲.md 优先覆盖
    const volumes = Array.from(volumeMap.values()).sort((a, b) => a.number - b.number)

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

  /** 扫描 大纲/ 目录下的独立卷文件（第N卷_卷名.md），提取卷结构 */
  private async readVolumeFiles(): Promise<Volume[]> {
    const dir = join(this.projectDir, '大纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const volumes: Volume[] = []
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      // 匹配 第N卷_卷名.md（N 为 1-2 位数字）
      const nameMatch = f.match(/^第(\d+)卷[_\s]*(.+?)\.md$/)
      if (!nameMatch) continue
      const number = parseInt(nameMatch[1], 10)
      const name = nameMatch[2].trim()
      // 从文件内容提取章节范围
      const text = await readText(join(dir, f))
      const range = text ? extractChapterRangeFromVolumeFile(text, number) : null
      volumes.push({
        number,
        name,
        chapterStart: range?.start ?? 0,
        chapterEnd: range?.end ?? 0
      })
    }
    return volumes
  }
}

/** 从卷文件内容提取章节范围（H1 或 卷核心 section 中的「章节范围」字段） */
function extractChapterRangeFromVolumeFile(
  text: string,
  volumeNumber: number
): { start: number; end: number } | null {
  // 从 H1 `# 卷纲：第N卷 卷名（第X-Y章）` 提取
  const h1Match = text.match(/第\s*(\d+)\s*[-–—]\s*(\d+)\s*章/)
  if (h1Match) {
    return { start: parseInt(h1Match[1], 10), end: parseInt(h1Match[2], 10) }
  }
  // 从「## 卷核心」的「章节范围」字段提取
  const doc = parseDoc(text)
  const coreSec = doc.sections.find((s) => s.title.includes('卷核心'))
  if (coreSec) {
    const rangeLine = coreSec.body.match(/章节范围[：:]\s*第\s*(\d+)\s*[-–—]\s*(\d+)\s*章/)
    if (rangeLine) {
      return { start: parseInt(rangeLine[1], 10), end: parseInt(rangeLine[2], 10) }
    }
  }
  return null
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
  if (!sec) {
    // 兼容：大纲.md 没有「逐章节奏标注」H2 节时，
    // 尝试从 H1 body 中的表格直接提取（技能标准格式）
    return extractRhythmFromTopLevelTable(doc)
  }
  const entries: RhythmEntry[] = []
  for (const sub of parseSubsections(sec.body)) {
    const volNumMatch = sub.title.match(/第\s*(\d+)\s*卷/)
    const volDefault = volNumMatch ? parseInt(volNumMatch[1], 10) : 0
    const { headers, rows } = parseTable(sub.body)
    if (headers.length < 4) continue
    entries.push(...extractRhythmRows(headers, rows, volDefault))
  }
  return entries
}

/** 从 H1 body 中的顶层表格提取逐章节奏（技能标准格式：H1 + 表格，无 H2 节） */
function extractRhythmFromTopLevelTable(doc: ReturnType<typeof parseDoc>): RhythmEntry[] {
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 4) return []
  // 确认是节奏表：包含 章节/标题/情绪/爽点/卷 列
  const hasChapter = headers.some((h) => h.includes('章节'))
  const hasEmotion = headers.some((h) => h.includes('情绪'))
  if (!hasChapter || !hasEmotion) return []
  return extractRhythmRows(headers, rows, 0)
}

/** 从表格行提取节奏条目 */
function extractRhythmRows(
  headers: string[],
  rows: string[][],
  volDefault: number
): RhythmEntry[] {
  const idxChapter = headers.findIndex((h) => h.includes('章节'))
  const idxTitle = headers.findIndex((h) => h.includes('标题'))
  const idxEmotion = headers.findIndex((h) => h.includes('情绪'))
  const idxClimax = headers.findIndex((h) => h.includes('爽点'))
  const idxVolume = headers.findIndex((h) => h.includes('卷'))
  const entries: RhythmEntry[] = []
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
  return entries
}

function num(s: string | undefined): number {
  if (!s) return 0
  const m = s.match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : 0
}
