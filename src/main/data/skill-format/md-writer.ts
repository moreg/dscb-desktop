import type { FieldValue } from './md-parser'

/**
 * Markdown 外科手术式回写。Phase 3 核心基础设施。
 *
 * 设计原则（满足技能兼容）：
 * - 只改目标节/行，版本头、H1、其他节、代码块、注释原样保留。
 * - 字段序列化保留多行子列表形态（`**字段**：\n  - x\n  - y`）。
 * - 按「标题」定位节，不依赖 AST，round-trip 可控。
 */

/** 转义正则元字符 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 找 `## title` 节的行范围 [start, end)：start=标题行，end=下一 H2 或 EOF */
export function findH2Range(lines: string[], title: string): { start: number; end: number } | null {
  const re = new RegExp(`^## ${escapeRegex(title.trim())}\\s*$`)
  let inFence = false
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) inFence = !inFence
    if (!inFence && re.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  inFence = false
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) inFence = !inFence
    if (!inFence && /^## /.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * 找 `### name（...）` 或 `### name` 块的行范围 [start, end)。
 * start=标题行，end=下一 H3/H2 或 EOF。用于角色卡的单角色块。
 */
export function findH3BlockRange(
  lines: string[],
  name: string
): { start: number; end: number } | null {
  // 匹配 `### name`、`### name（中文括号）`、`### name(英文括号)`
  const re = new RegExp(
    `^### ${escapeRegex(name.trim())}(（[^）]*）|\\([^)]*\\))?\\s*$`
  )
  let inFence = false
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) inFence = !inFence
    if (!inFence && re.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  inFence = false
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) inFence = !inFence
    if (!inFence && (/^### /.test(lines[i]) || /^## /.test(lines[i]))) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 替换 `## title` 节的 body（不含标题行）。节不存在则原样返回。 */
export function replaceH2Body(text: string, title: string, newBody: string): string {
  const lines = text.split(/\r?\n/)
  const range = findH2Range(lines, title)
  if (!range) return text
  const next = [
    ...lines.slice(0, range.start + 1),
    ...newBody.split(/\r?\n/),
    ...lines.slice(range.end)
  ]
  return next.join('\n')
}

/** 替换 `### name（...）` 整块（含标题行）。newBlock 含自己的标题行。 */
export function replaceH3Block(text: string, name: string, newBlock: string): string {
  const lines = text.split(/\r?\n/)
  const range = findH3BlockRange(lines, name)
  if (!range) return text
  const next = [...lines.slice(0, range.start), ...newBlock.split(/\r?\n/), ...lines.slice(range.end)]
  return next.join('\n')
}

/** 删除 `### name（...）` 整块，清理紧随的空行 */
export function deleteH3Block(text: string, name: string): string {
  const lines = text.split(/\r?\n/)
  const range = findH3BlockRange(lines, name)
  if (!range) return text
  let end = range.end
  // 吃掉块后空行，避免留双空行
  while (end < lines.length && lines[end].trim() === '') end++
  const next = [...lines.slice(0, range.start), ...lines.slice(end)]
  return next.join('\n')
}

/** 在 `## h2Title` 节末尾追加一个 H3 块。节不存在则原样返回。 */
export function appendH3UnderH2(text: string, h2Title: string, h3Block: string): string {
  const lines = text.split(/\r?\n/)
  const range = findH2Range(lines, h2Title)
  if (!range) return text
  const block = `\n${h3Block}\n`
  const next = [...lines.slice(0, range.end), ...block.split(/\r?\n/), ...lines.slice(range.end)]
  return next.join('\n')
}

/** 在文件末尾（去掉尾部空行后）追加一个 H2 节 */
export function appendH2Section(text: string, title: string, body: string): string {
  const trimmed = text.replace(/\s+$/, '')
  const section = `\n\n## ${title}\n\n${body}\n`
  return trimmed + section
}

/** 删除 `## title` 整节及其尾部空行 */
export function deleteH2Section(text: string, title: string): string {
  const lines = text.split(/\r?\n/)
  const range = findH2Range(lines, title)
  if (!range) return text
  let end = range.end
  while (end < lines.length && lines[end].trim() === '') end++
  const next = [...lines.slice(0, range.start), ...lines.slice(end)]
  return next.join('\n')
}

/**
 * 在首个表格末尾追加一行（按表头列数补齐）。
 * 若文件尚无表格：
 * - 传入 `headers` 时新建表头 + 分隔行 + 数据行；
 * - 未传 headers 时原样返回（调用方应保证骨架有表，或传 headers）。
 */
export function appendTableRow(text: string, cells: string[], headers?: string[]): string {
  const lines = text.split(/\r?\n/)
  let tableStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      tableStart = i
      break
    }
  }
  if (tableStart < 0) {
    if (!headers || headers.length === 0) return text
    const colCount = headers.length
    const padded = [...cells]
    while (padded.length < colCount) padded.push('')
    const headerRow = `| ${headers.join(' | ')} |`
    const sepRow = `| ${headers.map(() => '---').join(' | ')} |`
    const dataRow = `| ${padded.slice(0, colCount).join(' | ')} |`
    const trimmed = text.replace(/\s+$/, '')
    return `${trimmed}\n\n${headerRow}\n${sepRow}\n${dataRow}\n`
  }
  let tableEnd = tableStart
  for (let i = tableStart; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) tableEnd = i
    else break
  }
  const colCount = splitRow(lines[tableStart]).length
  const padded = [...cells]
  while (padded.length < colCount) padded.push('')
  const newRow = `| ${padded.slice(0, colCount).join(' | ')} |`
  const next = [...lines.slice(0, tableEnd + 1), newRow, ...lines.slice(tableEnd + 1)]
  return next.join('\n')
}

/** 删除首个匹配的表格行 */
export function deleteTableRow(
  text: string,
  matcher: (cells: string[]) => boolean
): string {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim().startsWith('|')) continue
    if (l.includes('---')) continue
    if (matcher(splitRow(l))) {
      return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n')
    }
  }
  return text
}

/**
 * 替换 GFM 表格中首个匹配的行。matcher 判定是否命中，newRowCells 写回。
 * 表头/分隔行不动；未命中则原样返回。
 */
export function replaceTableRow(
  text: string,
  rowMatcher: (cells: string[]) => boolean,
  newRowCells: string[]
): string {
  const lines = text.split(/\r?\n/)
  let tableStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) {
      tableStart = i
      break
    }
  }
  if (tableStart < 0) return text
  // 找表尾
  let tableEnd = tableStart
  for (let i = tableStart; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) tableEnd = i
    else break
  }
  const colCount = splitRow(lines[tableStart]).length
  const out = [...lines]
  for (let i = tableStart + 2; i <= tableEnd; i++) {
    const cells = splitRow(lines[i])
    if (rowMatcher(cells)) {
      const padded = [...newRowCells]
      while (padded.length < colCount) padded.push('')
      padded.length = colCount
      out[i] = `| ${padded.join(' | ')} |`
      return out.join('\n')
    }
  }
  return text
}

/** 序列化 BoldFields：保留多行子列表形态 */
export function serializeBoldFields(fields: Record<string, string | string[]>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) return `- **${key}**：`
        return `- **${key}**：\n${value.map((v) => `  - ${v}`).join('\n')}`
      }
      return `- **${key}**：${value}`
    })
    .join('\n')
}

/** 把单个字段值规范成字符串（数组取首项） */
export function fieldFirst(v: FieldValue | undefined): string {
  if (v == null) return ''
  return Array.isArray(v) ? v[0] ?? '' : v
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}
