import { promises as fs } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { randomUUID, createHash } from 'crypto'
import { TextDecoder } from 'util'
import { toFolderName } from './folder-name'
import { chineseToNumber } from './teardown/teardown-chapter-splitter'
import type { ProseImportEncoding, ProseImportPreview } from '../../shared/prose-import'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILES = 3000
const NUMBER = '[0-9一二三四五六七八九十百千零〇两]+'
const HEADING = new RegExp(`^(?:#{1,6}\\s+)?第\\s*(${NUMBER})\\s*[章回节](.*)$`, 'u')
const FILENAME = new RegExp(`^(?:第\\s*(${NUMBER})\\s*[章回节]|(\\d+)(?=[ _：:.、-]|$))(?:[ _：:.、-]*(.*))?$`, 'u')

export interface ImportChapter { number: number; title: string; content: string; source: string }
export interface ProseImportPlan {
  preview: ProseImportPreview
  chapters: ImportChapter[]
}

function chapterNumber(value: string): number | null {
  const n = /^[零〇一二三四五六七八九]+$/.test(value)
    ? Number([...value].map(c => '零一二三四五六七八九'.indexOf(c === '〇' ? '零' : c)).join(''))
    : chineseToNumber(value)
  return n !== null && Number.isSafeInteger(n) && n > 0 && n <= 100000 ? n : null
}

function heading(line: string): { number: number; title: string } | null {
  const match = line.trim().replace(/^\uFEFF/, '').match(HEADING)
  if (!match) return null
  const number = chapterNumber(match[1])
  if (number === null) return null
  const title = match[2].replace(/^[\s_：:.、—-]+/, '').replace(/\s+#+\s*$/, '').trim()
  return { number, title: title || `第${number}章` }
}

/** Offsets refer to the original string: no trim, newline normalization or rewriting of prose. */
export function splitImportText(source: string, text: string): { chapters: ImportChapter[]; issues: string[] } {
  const issues: string[] = []
  if (!text.trim()) return { chapters: [], issues: [`${source}：文件为空。`] }
  const stem = basename(source, extname(source))
  const fileMatch = stem.match(FILENAME)
  const fileNumber = fileMatch ? chapterNumber(fileMatch[1] || fileMatch[2]) : null
  const markers: Array<{ number: number; title: string; offset: number }> = []
  const lines = text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)
  for (const line of lines) {
    if (!line[0]) continue
    const parsed = heading(line[0])
    if (parsed) markers.push({ ...parsed, offset: line.index! })
  }
  if (!markers.length) {
    if (!fileNumber) return { chapters: [], issues: [`${source}：没有明确章号，请在文件名或独立章标题中标明章号。`] }
    return { chapters: [{ number: fileNumber, title: fileMatch?.[3]?.trim() || `第${fileNumber}章`, content: text, source }], issues }
  }
  if (fileNumber && markers[0].number !== fileNumber) {
    return { chapters: [], issues: [`${source}：文件名第${fileNumber}章与正文第${markers[0].number}章冲突，未导入。`] }
  }
  if (markers.length === 1 && fileMatch?.[3]?.trim() && fileMatch[3].trim() !== markers[0].title) {
    return { chapters: [], issues: [`${source}：文件名章名与正文章名不一致，未自动选择标题，请核对后重新导入。`] }
  }
  const prefix = text.slice(0, markers[0].offset)
  if (prefix.trim()) {
    return { chapters: [], issues: [`${source}：首章前有前言、目录或其他文字，归属不明，保留源文件待整理。`] }
  }
  if (markers.some((m, i) => i > 0 && m.number <= markers[i - 1].number)) {
    return { chapters: [], issues: [`${source}：文件内章号重复或倒序，可能包含目录或分卷重编号，未自动拆分。`] }
  }
  const chapters = markers.map((m, i) => ({
    number: m.number, title: m.title, source,
    content: text.slice(i === 0 ? 0 : m.offset, markers[i + 1]?.offset ?? text.length)
  }))
  if (chapters.some(c => !c.content.replace(/^[^\r\n]*(?:\r\n|\r|\n|$)/, '').trim())) {
    return { chapters: [], issues: [`${source}：存在只有标题而无正文的章节，可能是目录，未导入。`] }
  }
  return { chapters, issues }
}

export function decodeImportText(bytes: Uint8Array, encoding: ProseImportEncoding): string {
  let selected = encoding
  if (encoding === 'auto') {
    selected = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  }
  try {
    const text = new TextDecoder(selected, { fatal: true, ignoreBOM: true }).decode(bytes)
    if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('invalid text')
    return text
  } catch {
    throw new Error('无法可靠解码，请选择正确编码后重新预览（旧版中文 TXT 可尝试 GB18030）。')
  }
}

export function buildImportPlan(files: Array<{ source: string; text: string }>, suggestedName: string, issues: string[] = []): ProseImportPlan {
  const all: ImportChapter[] = []
  const problems = [...issues]
  for (const file of files) {
    const parsed = splitImportText(file.source, file.text)
    all.push(...parsed.chapters)
    problems.push(...parsed.issues)
  }
  const duplicates: string[] = []
  const grouped = new Map<number, ImportChapter[]>()
  for (const chapter of all) grouped.set(chapter.number, [...(grouped.get(chapter.number) ?? []), chapter])
  const chapters: ImportChapter[] = []
  for (const [number, copies] of grouped) {
    if (copies.some(c => c.content !== copies[0].content)) {
      problems.push(`第${number}章存在不同版本，全部暂缓：${copies.map(c => c.source).join('；')}。`)
      continue
    }
    chapters.push(copies[0])
    if (copies.length > 1) duplicates.push(`第${number}章内容完全相同，仅导入一次：${copies.map(c => c.source).join('；')}。`)
  }
  // Compare prose without chapter heading so differently numbered copies cannot silently pass.
  const hashes = new Map<string, ImportChapter[]>()
  for (const chapter of chapters) {
    const firstLine = chapter.content.split(/\r\n|\r|\n/, 1)[0]
    const body = heading(firstLine) ? chapter.content.slice(firstLine.length).replace(/^(?:\r\n|\r|\n)/, '') : chapter.content
    const hash = createHash('sha256').update(body).digest('hex')
    hashes.set(hash, [...(hashes.get(hash) ?? []), chapter])
  }
  const blocked = new Set<number>()
  for (const copies of hashes.values()) if (copies.length > 1) {
    copies.forEach(c => blocked.add(c.number))
    problems.push(`不同章号出现相同正文，暂缓导入：${copies.map(c => `第${c.number}章（${c.source}）`).join('；')}。`)
  }
  const ready = chapters.filter(c => !blocked.has(c.number)).sort((a, b) => a.number - b.number)
  const nums = [...grouped.keys()].sort((a, b) => a - b)
  const missing: string[] = []
  for (let i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1] + 1) {
    const start = nums[i - 1] + 1, end = nums[i] - 1
    missing.push(start === end ? `第${start}章` : `第${start}—${end}章`)
  }
  return {
    chapters: ready,
    preview: { token: randomUUID(), suggestedName, fileCount: files.length, detectedCount: all.length,
      chapters: ready.map(c => ({ number: c.number, title: c.title, source: c.source, excerpt: c.content.slice(0, 240) })),
      issues: problems, duplicates, missing }
  }
}

export async function prepareProseImport(paths: string[], encoding: ProseImportEncoding): Promise<ProseImportPlan> {
  const files: Array<{ source: string; text: string }> = []
  const issues: string[] = []
  const seen = new Set<string>()
  let bytes = 0, count = 0
  const visit = async (input: string): Promise<void> => {
    const path = resolve(input)
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 10000) throw new Error('目录条目过多，请选择仅包含正文的文件夹。')
    const stat = await fs.lstat(path)
    if (stat.isSymbolicLink()) { issues.push(`${path}：跳过链接。`); return }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(path, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['node_modules', '大纲', '细纲', '设定', '追踪', '图解', '记忆', '对标'].includes(entry.name)) continue
        try { await visit(join(path, entry.name)) }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!['EACCES', 'EPERM', 'ENOENT', 'EISDIR'].includes(code ?? '')) throw error
          issues.push(`${join(path, entry.name)}：无法读取（${code}），未导入。`)
        }
      }
      return
    }
    if (!stat.isFile() || !['.txt', '.md'].includes(extname(path).toLowerCase())) {
      issues.push(`${path}：未处理，仅支持 TXT、Markdown 正文。`); return
    }
    count++
    bytes += stat.size
    if (count > MAX_FILES || bytes > MAX_BYTES) throw new Error('一次最多导入 3000 个文本文件，总大小不超过 64 MB。')
    const buffer = await fs.readFile(path)
    if (buffer.length !== stat.size) throw new Error('读取期间源文件发生变化，请重新预览。')
    try { files.push({ source: path, text: decodeImportText(buffer, encoding) }) }
    catch (error) { issues.push(`${path}：${(error as Error).message}`) }
  }
  for (const path of paths) {
    try { await visit(path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EACCES', 'EPERM', 'ENOENT', 'EISDIR'].includes(code ?? '')) throw error
      issues.push(`${path}：无法读取（${code}），未导入。`)
    }
  }
  const first = paths[0] ? await fs.lstat(paths[0]).catch(() => null) : null
  const suggested = first?.isDirectory() ? basename(paths[0]) : ''
  const plan = buildImportPlan(files, suggested, issues)
  plan.preview.fileCount = count
  return plan
}

/** Create a fresh book only. Never merge into or overwrite any source/previous project. */
export async function writeProseImport(root: string, name: string, plan: ProseImportPlan): Promise<string> {
  const safeName = toFolderName(name)
  if (!safeName || safeName !== name.trim() || safeName.length > 100) throw new Error('书名需为 1—100 个字符，不能含文件名非法字符。')
  if (!plan.chapters.length) throw new Error('没有可导入的章节，请先处理识别问题。')
  await fs.mkdir(root, { recursive: true })
  const dir = join(root, safeName)
  try { await fs.mkdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('已有同名小说文件夹，请修改书名；不会覆盖已有内容。', { cause: error })
    throw error
  }
  const written: string[] = []
  const directories: string[] = []
  // Publish the outline last: an interrupted import cannot be scanned as a complete book.
  try {
    await fs.mkdir(join(dir, '正文'))
    directories.push(join(dir, '正文'))
    await fs.mkdir(join(dir, '大纲'))
    directories.push(join(dir, '大纲'))
    for (const chapter of plan.chapters) {
      const fileTitle = (toFolderName(chapter.title) || `第${chapter.number}章`).slice(0, 90)
      const target = join(dir, '正文', `第${String(chapter.number).padStart(3, '0')}章_${fileTitle}.md`)
      const handle = await fs.open(target, 'wx')
      written.push(target)
      try { await handle.writeFile(chapter.content, 'utf8') } finally { await handle.close() }
    }
    // Encode table delimiters as entities; parser must decode these for the original title.
    const cell = (s: string) => s.replace(/&/g, '&amp;').replace(/\|/g, '&#124;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const rows = plan.chapters.map(c => `| 第${c.number}章 | ${cell(c.title)} | 待评估 | 待评估 |`).join('\n')
    const outline = join(dir, '大纲', '大纲.md')
    const partial = `${outline}.partial`
    const handle = await fs.open(partial, 'wx')
    written.push(partial)
    try { await handle.writeFile(`# 《${safeName}》大纲\n\n## 逐章节奏标注\n\n| 章节 | 标题 | 情绪值 | 爽点类型 |\n|---|---|---|---|\n${rows}\n`, 'utf8') }
    finally { await handle.close() }
    await fs.rename(partial, outline)
    written.push(outline)
    return dir
  } catch (error) {
    // Only remove files created in our exclusive new directory; never recursively remove a source.
    for (const file of written.reverse()) await fs.unlink(file).catch(() => undefined)
    for (const folder of directories.reverse()) await fs.rmdir(folder).catch(() => undefined)
    await fs.rmdir(dir).catch(() => undefined)
    throw error
  }
}
