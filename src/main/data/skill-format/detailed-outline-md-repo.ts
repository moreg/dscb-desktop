import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseBoldFields, parseVolumeNumber, parseChapterNumber, type FieldValue } from './md-parser'
import type { ChapterDetail } from '../../../shared/types'

/**
 * 读取细纲。真相源：`细纲/第NN卷.md`（每卷一个文件）。
 * 每文件 H1 给出卷号；H2 `## 第N章：标题` 每章一块，含富字段。
 */
export class DetailedOutlineMdRepo {
  constructor(private readonly projectDir: string) {}

  /** 读取所有卷的细纲，合并为 ChapterDetail[] */
  async listAll(): Promise<ChapterDetail[]> {
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const details: ChapterDetail[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      details.push(...this.parseFile(text))
    }
    return details.sort((a, b) => a.chapterNumber - b.chapterNumber)
  }

  /** 读取指定卷的细纲 */
  async listVolume(volume: number): Promise<ChapterDetail[]> {
    const file = join(this.projectDir, '细纲', `第${String(volume).padStart(2, '0')}卷.md`)
    const text = await readText(file)
    if (!text) return []
    return this.parseFile(text)
  }

  private parseFile(text: string): ChapterDetail[] {
    const doc = parseDoc(text)
    const volumeFromH1 = parseVolumeNumber(doc.h1Title) ?? undefined
    // 细纲每章是 H2（## 第N章：标题），直接用 doc.sections 过滤
    const chapters = doc.sections.filter((s) => parseChapterNumber(s.title) != null)
    const details: ChapterDetail[] = []
    for (const ch of chapters) {
      const d = parseChapterBlock(ch.title, ch.body, volumeFromH1)
      if (d) details.push(d)
    }
    return details
  }
}

function parseChapterBlock(heading: string, body: string, volumeDefault?: number): ChapterDetail | null {
  const chapterNumber = parseChapterNumber(heading)
  if (chapterNumber == null) return null
  // heading 形如 "第 2 章：破窗" 或 "第 30 章：变异兽王（卷终决战）"
  const titleMatch = heading.match(/[：:]\s*([^\n（(]+)/)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const { fields, order } = parseBoldFields(body)

  const rhythmAnn = toArr(fields.get('节奏标注')) ?? []
  let emotion: number | undefined
  let climax: number | undefined
  for (const line of rhythmAnn) {
    const em = line.match(/情绪值[：:]\s*(\d+(?:\.\d+)?)/)
    if (em) emotion = Number(em[1])
    const cl = line.match(/爽点类型[：:]\s*(\d+(?:\.\d+)?)/)
    if (cl) climax = Number(cl[1])
  }

  const detail: ChapterDetail = {
    chapterNumber,
    title,
    volume: volumeDefault,
    emotion,
    climax,
    plotSummary: toStr(fields.get('核心事件')),
    coolPoint: toStr(fields.get('爽点/打脸')) ?? toStr(fields.get('爽点')),
    charactersAppearing: toArr(fields.get('角色出场')),
    foreshadowings: toArr(fields.get('伏笔铺设')),
    hook: toStr(fields.get('章末钩子')),
    wordEstimate: toStr(fields.get('字数预估')),
    goldenLine: toStr(fields.get('金句')),
    climaxTag: toStr(fields.get('卷终反转')) ?? toStr(fields.get('关键设定')),
    writingRequirements: toStr(fields.get('本章写作要求')) ?? toStr(fields.get('写作要求')),
    rawFields: toRawFields(fields, order)
  }
  return detail
}

function toStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

function toArr(v: FieldValue | undefined): string[] | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v : [v]
}

function toRawFields(fields: Map<string, FieldValue>, order: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of order) {
    const v = fields.get(k)
    if (v == null) continue
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}
