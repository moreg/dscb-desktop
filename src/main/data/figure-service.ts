import { join } from 'path'
import { promises as fs } from 'fs'
import { shell } from 'electron'
import { ProjectService } from './project-service'

export interface FigureSummary {
  fileName: string
  /** 从文件名「第N章-标题.html」推断的章号；无则 null */
  chapterNumber: number | null
  /** 来自 H1 的标题 */
  title: string
}

export type FigureSectionKind = 'list' | 'table' | 'mermaid' | 'prose'

export interface FigureSection {
  name: string
  kind: FigureSectionKind
  items?: string[]
  rows?: string[][]
  mermaid?: string
  text?: string
}

export interface ChapterFigure {
  fileName: string
  chapterNumber: number | null
  title: string
  sections: FigureSection[]
}

/**
 * 关键情节图解服务。发现并解析 `图解/第N章-*.html`（技能产出的 Mermaid 图解）。
 * 节奏图谱.html 不在此列（它由 RhythmHtmlRepo 处理）。
 */
export class FigureService {
  constructor(private readonly projectService: ProjectService) {}

  /** 列出所有关键情节图解（排除节奏图谱） */
  async list(projectId: string): Promise<FigureSummary[]> {
    const dir = await this.projectService.resolveDir(projectId)
    const figDir = join(dir, '图解')
    let files: string[]
    try {
      files = await fs.readdir(figDir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const out: FigureSummary[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.html')) continue
      if (f.includes('节奏图谱')) continue
      const text = await fs.readFile(join(figDir, f), 'utf-8').catch(() => '')
      const title = stripTags((text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? f).trim()) || f
      out.push({
        fileName: f,
        chapterNumber: chapterFromFileName(f),
        title
      })
    }
    return out
  }

  /** 读取单个图解的完整结构 */
  async read(projectId: string, fileName: string): Promise<ChapterFigure | null> {
    const dir = await this.projectService.resolveDir(projectId)
    const file = join(dir, '图解', fileName)
    let text: string
    try {
      text = await fs.readFile(file, 'utf-8')
    } catch {
      return null
    }
    const title = stripTags((text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? fileName).trim())
    const sections = parseSections(text)
    return { fileName, chapterNumber: chapterFromFileName(fileName), title, sections }
  }

  /** 在系统默认浏览器打开原图解 HTML（含 Mermaid CDN，浏览器内完整渲染） */
  async open(projectId: string, fileName: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    await shell.openPath(join(dir, '图解', fileName))
  }
}

function chapterFromFileName(name: string): number | null {
  const m = name.match(/第\s*(\d+)\s*章/)
  return m ? parseInt(m[1], 10) : null
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * 解析所有 `<div class="section"><h2>名</h2>内容</div>`。
 * 用深度计数定位每个 section 的真正闭合 div（防止嵌套 div — 如 mermaid — 干扰非贪婪匹配）。
 */
function parseSections(html: string): FigureSection[] {
  const sections: FigureSection[] = []
  const openRe = /<div\b[^>]*class="[^"]*\bsection\b[^"]*"[^>]*>/g
  const openings: { idx: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = openRe.exec(html)) !== null) {
    openings.push({ idx: m.index, end: m.index + m[0].length })
  }
  for (const op of openings) {
    const h2m = html.slice(op.end).match(/^\s*<h2[^>]*>([\s\S]*?)<\/h2>/)
    if (!h2m) continue
    const name = stripTags(h2m[1])
    const bodyStart = op.end + h2m[0].length
    // 深度计数找到真正闭合的 </div>（mermaid 等嵌套 div 不会误闭合）
    let depth = 1
    let i = bodyStart
    let bodyEnd = -1
    while (i < html.length) {
      const nextOpen = html.indexOf('<div', i)
      const nextClose = html.indexOf('</div>', i)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++
        i = nextOpen + 4
      } else {
        depth--
        if (depth === 0) {
          bodyEnd = nextClose
          break
        }
        i = nextClose + 6
      }
    }
    if (bodyEnd < 0) continue
    const body = html.slice(bodyStart, bodyEnd)
    sections.push(parseSectionBody(name, body))
  }
  return sections
}

function parseSectionBody(name: string, body: string): FigureSection {
  // mermaid
  const mer = body.match(/<div[^>]*class="[^"]*mermaid[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (mer) return { name, kind: 'mermaid', mermaid: mer[1].trim() }
  // table
  if (/<table[\s>]/.test(body)) {
    const rows: string[][] = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
    let tr: RegExpExecArray | null
    while ((tr = trRe.exec(body)) !== null) {
      const cells: string[] = []
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g
      let td: RegExpExecArray | null
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(stripTags(td[1]))
      if (cells.length) rows.push(cells)
    }
    return { name, kind: 'table', rows }
  }
  // list
  if (/<ul[\s>]/.test(body) || /<ol[\s>]/.test(body)) {
    const items: string[] = []
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g
    let li: RegExpExecArray | null
    while ((li = liRe.exec(body)) !== null) items.push(stripTags(li[1]))
    return { name, kind: 'list', items }
  }
  // prose
  const text = stripTags(body).replace(/\n{3,}/g, '\n\n').trim()
  return { name, kind: 'prose', text }
}
