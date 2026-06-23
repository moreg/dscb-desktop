import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseChapterNumber, parseBoldFields } from './md-parser'
import { writeTextAtomic } from '../atomic'

/**
 * 细纲更新补丁。所有字段可选，只更新提供的字段。
 */
export interface DetailedOutlinePatch {
  title?: string
  plotSummary?: string
  coolPoint?: string
  hook?: string
  charactersAppearing?: string[]
  foreshadowings?: string[]
  wordEstimate?: string
  goldenLine?: string
  emotion?: number
  climax?: number
  writingRequirements?: string
}

/**
 * 细纲写入器。更新 细纲/第NN卷.md 中指定章节的字段。
 *
 * 策略：
 * - 遍历所有细纲文件，找到包含目标章节的文件
 * - 定位章节 section，解析现有字段
 * - 根据 patch 更新或新增字段
 * - 原子写入文件
 */
export class DetailedOutlineWriter {
  constructor(private readonly projectDir: string) {}

  /**
   * 更新指定章节的细纲
   * @throws Error 如果找不到该章节的细纲
   */
  async update(chapterNumber: number, patch: DetailedOutlinePatch): Promise<void> {
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      throw new Error('CHAPTER_NOT_FOUND: 细纲目录不存在')
    }

    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const file = join(dir, f)
      const updated = await this.updateChapterInFile(file, chapterNumber, patch)
      if (updated) return
    }

    throw new Error(`CHAPTER_NOT_FOUND: 找不到第 ${chapterNumber} 章的细纲`)
  }

  /**
   * 在指定文件中更新章节细纲
   * @returns true 如果成功更新，false 如果文件中没有该章节
   */
  private async updateChapterInFile(
    file: string,
    chapterNumber: number,
    patch: DetailedOutlinePatch
  ): Promise<boolean> {
    const text = await readText(file)
    if (!text) return false

    const doc = parseDoc(text)
    const chSec = doc.sections.find((s) => parseChapterNumber(s.title) === chapterNumber)
    if (!chSec) return false

    // 解析现有字段
    const { fields, order } = parseBoldFields(chSec.body)

    // 构建新字段
    const newFields = new Map(fields)
    const newOrder = [...order]

    // 更新标题（如果在 patch 中）
    let newTitle = chSec.title
    if (patch.title !== undefined) {
      // 标题格式: "第 N 章：标题"
      const numMatch = chSec.title.match(/^(第\s*\d+\s*章)[：:]/)
      if (numMatch) {
        newTitle = `${numMatch[1]}：${patch.title}`
      }
    }

    // 更新简单字段
    if (patch.plotSummary !== undefined) {
      this.setField(newFields, newOrder, '核心事件', patch.plotSummary)
    }
    if (patch.coolPoint !== undefined) {
      this.setField(newFields, newOrder, '爽点/打脸', patch.coolPoint)
    }
    if (patch.hook !== undefined) {
      this.setField(newFields, newOrder, '章末钩子', patch.hook)
    }
    if (patch.wordEstimate !== undefined) {
      this.setField(newFields, newOrder, '字数预估', patch.wordEstimate)
    }
    if (patch.goldenLine !== undefined) {
      this.setField(newFields, newOrder, '金句', patch.goldenLine)
    }
    if (patch.writingRequirements !== undefined) {
      const key = newFields.has('写作要求') ? '写作要求' : '本章写作要求'
      this.setField(newFields, newOrder, key, patch.writingRequirements)
    }

    // 更新列表字段
    if (patch.charactersAppearing !== undefined) {
      this.setListField(newFields, newOrder, '角色出场', patch.charactersAppearing)
    }
    if (patch.foreshadowings !== undefined) {
      this.setListField(newFields, newOrder, '伏笔铺设', patch.foreshadowings)
    }

    // 更新节奏标注（特殊处理：合并情绪值和爽点类型）
    if (patch.emotion !== undefined || patch.climax !== undefined) {
      this.updateRhythmAnnotation(newFields, newOrder, patch.emotion, patch.climax)
    }

    // 生成新的 body
    const newBody = this.renderFields(newFields, newOrder)

    // 替换 section body
    const nextText = this.replaceSectionBody(text, chSec.title, newTitle, newBody)
    await writeTextAtomic(file, nextText)
    return true
  }

  /**
   * 设置简单字段值（字符串）
   */
  private setField(
    fields: Map<string, string | string[]>,
    order: string[],
    key: string,
    value: string
  ): void {
    if (!fields.has(key)) {
      order.push(key)
    }
    fields.set(key, value)
  }

  /**
   * 设置列表字段值
   */
  private setListField(
    fields: Map<string, string | string[]>,
    order: string[],
    key: string,
    values: string[]
  ): void {
    if (!fields.has(key)) {
      order.push(key)
    }
    // 过滤空值
    const filtered = values.map(v => v.trim()).filter(v => v.length > 0)
    if (filtered.length > 0) {
      fields.set(key, filtered)
    } else {
      fields.delete(key)
      const idx = order.indexOf(key)
      if (idx >= 0) order.splice(idx, 1)
    }
  }

  /**
   * 更新节奏标注（情绪值 + 爽点类型）
   */
  private updateRhythmAnnotation(
    fields: Map<string, string | string[]>,
    order: string[],
    emotion: number | undefined,
    climax: number | undefined
  ): void {
    // 获取现有节奏标注
    let rhythmLines: string[] = []
    const existing = fields.get('节奏标注')
    if (Array.isArray(existing)) {
      rhythmLines = [...existing]
    } else if (typeof existing === 'string' && existing.trim()) {
      rhythmLines = [existing]
    }

    // 更新或添加情绪值
    let hasEmotion = false
    if (emotion !== undefined) {
      for (let i = 0; i < rhythmLines.length; i++) {
        if (/情绪值[：:]/.test(rhythmLines[i])) {
          rhythmLines[i] = `情绪值：${emotion}`
          hasEmotion = true
          break
        }
      }
      if (!hasEmotion) {
        rhythmLines.push(`情绪值：${emotion}`)
      }
    }

    // 更新或添加爽点类型
    let hasClimax = false
    if (climax !== undefined) {
      const suffix = this.climaxSuffix(climax)
      for (let i = 0; i < rhythmLines.length; i++) {
        if (/爽点类型[：:]/.test(rhythmLines[i])) {
          rhythmLines[i] = `爽点类型：${climax}${suffix}`
          hasClimax = true
          break
        }
      }
      if (!hasClimax) {
        rhythmLines.push(`爽点类型：${climax}${suffix}`)
      }
    }

    if (rhythmLines.length > 0) {
      if (!fields.has('节奏标注')) {
        order.push('节奏标注')
      }
      fields.set('节奏标注', rhythmLines)
    }
  }

  /**
   * 爽点类型的中文后缀
   */
  private climaxSuffix(c: number): string {
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

  /**
   * 将字段 Map 渲染为 markdown body
   */
  private renderFields(fields: Map<string, string | string[]>, order: string[]): string {
    const lines: string[] = []
    for (const key of order) {
      const value = fields.get(key)
      if (value === undefined) continue

      if (Array.isArray(value)) {
        // 列表字段
        lines.push(`- **${key}**：`)
        for (const item of value) {
          lines.push(`  - ${item}`)
        }
      } else {
        // 简单字段
        lines.push(`- **${key}**：${value}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 替换 section 的标题和 body
   */
  private replaceSectionBody(
    text: string,
    oldTitle: string,
    newTitle: string,
    newBody: string
  ): string {
    const lines = text.split(/\r?\n/)
    const re = new RegExp(`^## ${this.escapeRegex(oldTitle.trim())}\\s*$`)

    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        start = i
        break
      }
    }
    if (start < 0) return text

    // 找到下一个 H2 或文件结尾
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i]) && !/^###/.test(lines[i])) {
        end = i
        break
      }
    }

    // 构建新内容
    const next = [
      ...lines.slice(0, start),
      `## ${newTitle}`,
      ...newBody.split(/\r?\n/),
      '', // 空行分隔
      ...lines.slice(end)
    ]
    return next.join('\n')
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
