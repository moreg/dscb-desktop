import { promises as fs } from 'fs'

/**
 * 行级 Markdown 解析器，针对技能 v3.2 的高度规整格式设计。
 * 不引入 AST 库——round-trip 可控、零依赖。
 *
 * 核心概念：
 * - 版本头：文件首到第一个 `# ` H1 标题之前的全部内容（`**版本**：...` 等），原样保留。
 * - 节（Section）：`## 标题` 开头的 H2 段，body 是该标题行之后到下一 H2 节的全部内容。
 *   H3/H4 子标题留在父 H2 的 body 内，由 parseSubsections 再切。
 * - 代码围栏（```）内的内容不被切分。
 */

export interface Section {
  level: number // 2 = ##, 3 = ###
  title: string // 不含 ## 前缀和尾部空白
  body: string // 标题行之后到下一节的全部内容
  startLine: number // 标题所在行号（0-based，相对原文）
}

export interface ParsedDoc {
  versionHeader: string // H1 之前原样保留
  h1Title: string // 首个 # 标题文字；无则空串
  /** H1 标题行之后的全部正文（含未归入任何 H2 节的顶层内容，如裸表格） */
  body: string
  sections: Section[] // 全部 H2 节
}

const H1 = /^# (.+?)\s*$/
const H2 = /^## (.+?)\s*$/
const H3 = /^### (.+?)\s*$/

/** 解析整篇文档：拆出版本头 + H1 标题 + 所有 H2 节 */
export function parseDoc(text: string): ParsedDoc {
  const lines = text.split(/\r?\n/)
  let h1Line = -1
  let h1Title = ''
  for (let i = 0; i < lines.length; i++) {
    // H1 必须严格 `# ` 开头，排除 `## `
    if (H1.test(lines[i]) && !lines[i].startsWith('##')) {
      h1Line = i
      h1Title = lines[i].match(H1)![1]
      break
    }
  }
  const versionHeader = h1Line >= 0 ? lines.slice(0, h1Line).join('\n') : ''
  const body = h1Line >= 0 ? lines.slice(h1Line + 1).join('\n') : text
  const sections = scanSections(lines, h1Line >= 0 ? h1Line + 1 : 0, 2)
  return { versionHeader, h1Title, body, sections }
}

/** 在 H2 节体内按 H3 切子节 */
export function parseSubsections(body: string): Section[] {
  return scanSections(body.split(/\r?\n/), 0, 3)
}

export function findSection(doc: ParsedDoc, title: string): Section | null {
  const t = title.trim()
  return doc.sections.find((s) => s.title.trim() === t) ?? null
}

export function findSectionsByPrefix(doc: ParsedDoc, prefix: string): Section[] {
  return doc.sections.filter((s) => s.title.trim().startsWith(prefix))
}

/** 在某节体内按 H3 切子节 */
export function findSubsection(parent: Section, title: string): Section | null {
  const t = title.trim()
  return parseSubsections(parent.body).find((s) => s.title.trim() === t) ?? null
}

/** 通用 H{level} 扫描器。从 startLine 开始，返回所有该级标题的节。 */
function scanSections(lines: string[], startLine: number, level: number): Section[] {
  const re = new RegExp(`^${'#'.repeat(level)} (.+?)\\s*$`)
  const deeper = '#'.repeat(level + 1)
  const sections: Section[] = []
  let cur: Section | null = null
  let bodyLines: string[] = []
  let inFence = false
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) inFence = !inFence
    if (!inFence && re.test(line) && !line.startsWith(deeper)) {
      if (cur) {
        cur.body = bodyLines.join('\n')
        sections.push(cur)
      }
      cur = { level, title: line.match(re)![1], body: '', startLine: i }
      bodyLines = []
    } else if (cur) {
      bodyLines.push(line)
    }
  }
  if (cur) {
    cur.body = bodyLines.join('\n')
    sections.push(cur)
  }
  return sections
}

/** GFM 表格解析。body 内首个连续 `|` 行块作为表。 */
export function parseTable(body: string): { headers: string[]; rows: string[][] } {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = splitRow(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    if (isSeparatorRow(lines[i])) continue
    rows.push(splitRow(lines[i]))
  }
  return { headers, rows }
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isSeparatorRow(line: string): boolean {
  return splitRow(line).every((c) => /^:?-+:?$/.test(c))
}

export type FieldValue = string | string[]

/** 有序键值表，保留字段在原文的出现顺序 */
export interface BoldFields {
  fields: Map<string, FieldValue>
  order: string[]
}

/**
 * 解析 `- **字段**：值` 行。
 * - 行内值非空 → string
 * - 行内空 + 后续缩进子列表（`  - xxx`）→ string[]
 * - 行内有值 + 子列表 → 合并为 string[]
 */
export function parseBoldFields(body: string): BoldFields {
  const lines = body.split(/\r?\n/)
  const fields = new Map<string, FieldValue>()
  const order: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^\s*-\s+\*\*(.+?)\*\*\s*[：:]\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1].trim()
    const inline = m[2].trim()
    const sub: string[] = []
    let j = i + 1
    while (j < lines.length) {
      // 连字符子列表：  - xxx
      const sm = lines[j].match(/^\s{2,}-\s+(.+)$/)
      if (sm) {
        sub.push(sm[1].trim())
        j++
        continue
      }
      // 数字子列表：  1. xxx /  2. xxx（技能 v3.2 细纲情节点序列等使用此格式）
      const nm = lines[j].match(/^\s{2,}\d+\s*[.、)]\s+(.+)$/)
      if (nm) {
        sub.push(nm[1].trim())
        j++
        continue
      }
      break
    }
    let val: FieldValue
    if (sub.length > 0 && inline === '') val = sub
    else if (sub.length > 0) val = [inline, ...sub]
    else val = inline
    fields.set(key, val)
    order.push(key)
    i = j
  }
  return { fields, order }
}

/** 提取「第 N 章」/「第 N 卷」中的数字 */
export function parseChapterNumber(text: string): number | null {
  const m = text.match(/第\s*(\d+)\s*章/)
  return m ? parseInt(m[1], 10) : null
}

export function parseVolumeNumber(text: string): number | null {
  // 先试阿拉伯数字：第N卷 / 第N部 / 第 N 卷
  const m = text.match(/第\s*(\d+)\s*[卷部]/)
  if (m) return parseInt(m[1], 10)
  // 再试中文数字：第一卷 / 第十卷 / 第二十卷
  const cm = text.match(/第\s*([一二三四五六七八九十]+)\s*[卷部]/)
  if (cm) {
    const n = chineseNumToInt(cm[1])
    if (n > 0) return n
  }
  return null
}

/** 简易中文数字 → 整数（支持一..五十，够卷号用） */
function chineseNumToInt(s: string): number {
  const CN = '零一二三四五六七八九'
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s === '十') return 10
  if (s.startsWith('十')) return 10 + (CN.indexOf(s.slice(1)) >= 0 ? CN.indexOf(s.slice(1)) : 0)
  const shiIdx = s.indexOf('十')
  if (shiIdx > 0) {
    const tens = CN.indexOf(s[0])
    const ones = shiIdx < s.length - 1 ? CN.indexOf(s[shiIdx + 1]) : 0
    return (tens >= 0 ? tens : 1) * 10 + (ones >= 0 ? ones : 0)
  }
  const idx = CN.indexOf(s)
  return idx >= 0 ? idx : 0
}

/** 读取文本文件，ENOENT 返回空串 */
export async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return ''
    throw err
  }
}

// ========== 字段助手（各 repo 共用） ==========

/** 字段值 → 字符串。多行子列表用「；」拼接。 */
export function fieldToStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

/** 字段值 → string[]。单值包装成单元素数组。 */
export function fieldToArr(v: FieldValue | undefined): string[] | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v : [v]
}

/** 把 BoldFields 序列化为 rawFields 兜底对象（保留全部原始字段）。 */
export function fieldsToRaw(
  fields: Map<string, FieldValue>,
  order: string[]
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of order) {
    const v = fields.get(k)
    if (v == null) continue
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}

/** 由前缀 + 名称生成确定性 id（跨会话稳定，用于 React key 与关联引用）。 */
export function deterministicId(prefix: string, name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return `${prefix}-${Math.abs(h).toString(36)}`
}

/** 剥离标题前的数字序号：「1. 大学图书馆」→「大学图书馆」 */
export function stripNumberPrefix(title: string): string {
  return title.replace(/^\s*\d+\s*[.、)]?\s*/, '').trim()
}

/** 从「第 N 章」/「第 N 章：标题」中提取章号后的标题文字 */
export function titleAfterColon(heading: string): string {
  const m = heading.match(/[：:]\s*([^\n（(]+)/)
  return m ? m[1].trim() : ''
}
