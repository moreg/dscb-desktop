import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, findSection, parseSubsections, parseTable, parseChapterNumber } from './md-parser'
import { parseRhythmData, serializeRhythmData } from './rhythm-html'
import { writeTextAtomic } from '../atomic'

export interface RhythmPatch {
  title?: string
  emotion?: number
  climax?: number
}

/**
 * 章节节奏多文件同步器。改一个章节的 标题/情绪值/爽点 时，原子更新三处：
 * 1. 图解/节奏图谱.html 的 rhythmData（真相源）
 * 2. 大纲/大纲.md 「逐章节奏标注」对应卷表行
 * 3. 细纲/第NN卷.md 该章块的 情绪值/爽点类型 行
 *
 * 任一处缺失（如未生成细纲）则跳过，不报错。
 */
export class ChapterRhythmWriter {
  constructor(private readonly projectDir: string) {}

  async update(chapter: number, patch: RhythmPatch): Promise<void> {
    await this.updateRhythmHtml(chapter, patch)
    await this.updateOutlineTable(chapter, patch)
    await this.updateDetailedRhythm(chapter, patch)
  }

  /** 正文写完后调用：rhythmData 该章 actualized 置 true（预测值→实际值） */
  async markActualized(chapter: number): Promise<void> {
    const file = join(this.projectDir, '图解', '节奏图谱.html')
    const html = await readText(file)
    if (!html) return
    const entries = parseRhythmData(html)
    if (!entries) return
    const entry = entries.find((e) => e.chapter === chapter)
    if (!entry || entry.actualized) return
    entry.actualized = true
    await writeTextAtomic(file, serializeRhythmData(html, entries))
  }

  /** 1. 节奏图谱 html 的 rhythmData（真相源） */
  private async updateRhythmHtml(chapter: number, patch: RhythmPatch): Promise<void> {
    const file = join(this.projectDir, '图解', '节奏图谱.html')
    const html = await readText(file)
    if (!html) return
    const entries = parseRhythmData(html)
    if (!entries) return
    const entry = entries.find((e) => e.chapter === chapter)
    if (!entry) return
    if (patch.title !== undefined) entry.title = patch.title
    if (patch.emotion !== undefined) entry.emotion = patch.emotion
    if (patch.climax !== undefined) entry.climax = patch.climax
    await writeTextAtomic(file, serializeRhythmData(html, entries))
  }

  /** 2. 大纲.md 逐章节奏标注 —— 定位含该章的卷表，替换行 */
  private async updateOutlineTable(chapter: number, patch: RhythmPatch): Promise<void> {
    const file = join(this.projectDir, '大纲', '大纲.md')
    const text = await readText(file)
    if (!text) return
    const doc = parseDoc(text)
    const sec = findSection(doc, '逐章节奏标注')
    if (!sec) return
    // 逐 H3 卷子表查找含 chapter 的表
    const lines = text.split(/\r?\n/)
    let modified = false
    for (const sub of parseSubsections(sec.body)) {
      const { headers, rows } = parseTable(sub.body)
      if (headers.length < 4) continue
      const idxCh = headers.findIndex((h) => h.includes('章节'))
      const idxTitle = headers.findIndex((h) => h.includes('标题'))
      const idxEmotion = headers.findIndex((h) => h.includes('情绪'))
      const idxClimax = headers.findIndex((h) => h.includes('爽点'))
      const idxVolume = headers.findIndex((h) => h.includes('卷'))
      const matchRowIdx = rows.findIndex((r) => {
        const c = idxCh >= 0 ? r[idxCh] : ''
        const m = c.match(/(\d+)/)
        return m && parseInt(m[1], 10) === chapter ? true : false
      })
      if (matchRowIdx < 0) continue
      const row = rows[matchRowIdx]
      if (patch.title !== undefined && idxTitle >= 0) row[idxTitle] = patch.title
      if (patch.emotion !== undefined && idxEmotion >= 0) row[idxEmotion] = String(patch.emotion)
      if (patch.climax !== undefined && idxClimax >= 0) row[idxClimax] = String(patch.climax)
      void idxVolume
      // 在全文行数组中，按「第 N 章」定位并替换该行
      replaceChapterRowInPlace(lines, chapter, row)
      modified = true
      break
    }
    if (modified) await writeTextAtomic(file, lines.join('\n'))
  }

  /** 3. 细纲/第NN卷.md 该章块的 情绪值/爽点类型 行 */
  private async updateDetailedRhythm(chapter: number, patch: RhythmPatch): Promise<void> {
    if (patch.emotion === undefined && patch.climax === undefined) return
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const file = join(dir, f)
      const text = await readText(file)
      if (!text) continue
      const doc = parseDoc(text)
      const chSec = doc.sections.find((s) => parseChapterNumber(s.title) === chapter)
      if (!chSec) continue
      const bodyLines = chSec.body.split(/\r?\n/)
      let changed = false
      for (let i = 0; i < bodyLines.length; i++) {
        if (patch.emotion !== undefined && /^\s*-\s*情绪值[：:]/.test(bodyLines[i])) {
          bodyLines[i] = `  - 情绪值：${patch.emotion}`
          changed = true
        }
        if (patch.climax !== undefined && /^\s*-\s*爽点类型[：:]/.test(bodyLines[i])) {
          bodyLines[i] = `  - 爽点类型：${patch.climax}${climaxSuffix(patch.climax)}`
          changed = true
        }
      }
      if (!changed) continue
      const nextText = replaceSectionBody(text, chSec.title, bodyLines.join('\n'))
      await writeTextAtomic(file, nextText)
      return
    }
  }
}

/** 爽点类型的中文后缀（与技能模板一致） */
function climaxSuffix(c: number): string {
  const map: Record<number, string> = {
    0: '（无爽点）',
    1: '（小打脸）',
    2: '（中打脸）',
    3: '（大高潮）',
    3.5: '（卷中决战）',
    4: '（卷终决战）'
  }
  return map[c] ?? ''
}

/** 在全文行数组中，把含「第 chapter 章」的表格行替换成 newRowCells */
function replaceChapterRowInPlace(lines: string[], chapter: number, newRowCells: string[]): void {
  const colCount = lines.find((l) => l.trim().startsWith('|'))?.trim().split('|').length ?? newRowCells.length
  const padded = [...newRowCells]
  while (padded.length < colCount - 2) padded.push('')
  const newRowText = `| ${padded.join(' | ')} |`
  const needle = `第 ${chapter} 章`
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim().startsWith('|')) continue
    if (l.includes('---')) continue
    if (l.includes(needle)) {
      lines[i] = newRowText
      return
    }
  }
}

/** 替换 `## title` 节的 body（细粒度版，按标题精确匹配） */
function replaceSectionBody(text: string, title: string, newBody: string): string {
  const lines = text.split(/\r?\n/)
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()}\\s*$`)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i
      break
    }
  }
  const next = [...lines.slice(0, start + 1), ...newBody.split(/\r?\n/), ...lines.slice(end)]
  return next.join('\n')
}
