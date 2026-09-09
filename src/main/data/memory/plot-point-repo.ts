import { join } from 'path'
import { promises as fs } from 'fs'
import {
  readText,
  parseDoc,
  parseBoldFields,
  fieldToStr
} from '../skill-format/md-parser'
import { hashProse, listProseSources, splitProsePassages } from './prose-memory-index'
import { extractEntityNameFromDoc } from './entity-helpers'
import type { MemoryEntity } from '../../../shared/types'

/** 续写中程记忆：一章一行摘要 */
export interface PlotChapterSummary {
  chapterNumber: number
  /** 章标题（可空） */
  title: string
  /** 核心事件摘要（已截断） */
  summary: string
  source?: 'memory' | 'prose_excerpt'
  sourcePath?: string
  /** True only for exact prose or a summary bound to the current prose hash. */
  verified?: boolean
  sourceHash?: string
  startLine?: number
  endLine?: number
  /** Legacy summaries without matching source evidence must not become established facts. */
  unverifiedMemorySummary?: string
}

/**
 * 续写注入的「本章之前最近 N 章」默认数量。
 * 平衡长篇因果记忆与 token：12 章约覆盖卷内半程，远强于仅 3 条日更。
 */
export const RECENT_PLOT_CHAPTERS = 12

/** 单章摘要最大字符数，防止多剧情点拼接后撑爆 prompt */
export const PLOT_SUMMARY_MAX_CHARS = 200

export interface ListSummariesBeforeOptions {
  /**
   * 仅保留「正文/ 已有文件」的章（默认 true）。
   * 避免把未写正文的细纲/剧情点当成既成事实注入续写。
   */
  onlyWithProse?: boolean
  /** 兼容旧调用；当前实现始终从来源刷新。 */
  skipCache?: boolean
}

/**
 * 剧情点 repo。展示列表兼容细纲；续写记忆只使用有来源证据的摘要或正文摘录。
 */
export class PlotPointRepo {
  constructor(private readonly projectDir: string) {}

  /**
   * 取「写第 chapterNumber 章之前」最近 limit 章的剧情摘要（不含本章）。
   * 优先采用绑定当前正文哈希的记忆摘要；其余回退真实正文摘录。
   * 每次重读这几个章节和摘要，不用 TTL 缓存掩盖保存、改写或删除。
   */
  async listSummariesBefore(
    chapterNumber: number,
    limit: number = RECENT_PLOT_CHAPTERS,
    opts: ListSummariesBeforeOptions = {}
  ): Promise<PlotChapterSummary[]> {
    if (chapterNumber <= 1 || limit <= 0) return []
    const onlyWithProse = opts.onlyWithProse !== false
    const maxCh = chapterNumber - 1

    const proseSources = (await listProseSources(this.projectDir)).filter((s) => s.chapterNumber <= maxCh)
    const sourcesByChapter = new Map(proseSources.map((s) => [s.chapterNumber, s]))
    let targetChapters: number[]
    if (onlyWithProse) {
      targetChapters = proseSources.slice(-limit).map((s) => s.chapterNumber)
      if (targetChapters.length === 0) return []
    } else {
      const minCh = Math.max(1, chapterNumber - limit)
      targetChapters = []
      for (let n = minCh; n <= maxCh; n++) targetChapters.push(n)
    }

    const targetSet = new Set(targetChapters)
    const buckets = new Map<number, { title: string; event: string; sourceHash: string; sourcePath: string }[]>()

    // 1) 主源：只枚举顶层文件名，命中目标章才读内容（避免 400+ 全量 deep read）
    const plotDir = join(this.projectDir, '记忆', '剧情点')
    for (const name of await listPlotFileNames(plotDir)) {
      const num = extractChapterNumFromName(name)
      if (num == null || !targetSet.has(num)) continue
      const text = await readText(join(plotDir, name))
      if (!text) continue
      const doc = parseDoc(text)
      const entityName = extractEntityNameFromDoc(doc, name)
      const { fields } = parseBoldFields(
        doc.sections.map((s) => s.body).join('\n') + '\n' + doc.body
      )
      const event =
        fieldToStr(fields.get('核心事件')) ??
        fieldToStr(fields.get('爽点/打脸')) ??
        extractDescBody(doc) ??
        ''
      const title = stripChapterPrefix(entityName, num)
      const e = event.trim()
      if (!e) continue
      const rows = buckets.get(num) ?? []
      rows.push({ title, event: e, sourceHash: fieldToStr(fields.get('正文哈希')) ?? '', sourcePath: `记忆/剧情点/${name}` })
      buckets.set(num, rows)
    }

    const out: PlotChapterSummary[] = []
    for (const n of targetChapters) {
      const memories = buckets.get(n) ?? []
      const source = sourcesByChapter.get(n)
      const prose = source ? await readText(join(this.projectDir, source.sourcePath)) : null
      if (!prose?.trim()) {
        // Display callers may explicitly request memories without prose; label them unverified.
        if (!onlyWithProse && memories.length) out.push({ chapterNumber: n, title: memories[0].title,
          summary: truncateSummary(memories.map((m) => m.event).join('；'), PLOT_SUMMARY_MAX_CHARS),
          source: 'memory', sourcePath: memories[0].sourcePath, verified: false })
        continue
      }
      const sourceHash = hashProse(prose)
      const verified = memories.filter((m) => m.sourceHash === sourceHash)
      if (verified.length) {
        out.push({ chapterNumber: n, title: verified[0].title,
          summary: truncateSummary([...new Set(verified.map((m) => m.event))].join('；'), PLOT_SUMMARY_MAX_CHARS),
          source: 'memory', sourcePath: verified[0].sourcePath, sourceHash, verified: true })
        continue
      }
      const last = splitProsePassages(prose).at(-1)
      if (!last) continue
      const summary = last.text.slice(-PLOT_SUMMARY_MAX_CHARS)
      const offset = last.endOffset - summary.length
      out.push({ chapterNumber: n, title: source!.title, summary, source: 'prose_excerpt',
        sourcePath: source!.sourcePath, sourceHash, verified: true,
        startLine: 1 + (prose.slice(0, offset).match(/\n/g)?.length ?? 0), endLine: last.endLine,
        ...(memories.length ? { unverifiedMemorySummary: truncateSummary(memories.map((m) => m.event).join('；'), PLOT_SUMMARY_MAX_CHARS) } : {}) })
    }

    return out
  }

  /** 兼容旧写后同步调用；不再保留跨调用摘要缓存。 */
  static invalidateCache(_projectDir?: string): void { /* Compatibility: summaries now read source evidence every time. */ }

  async list(): Promise<MemoryEntity[]> {
    const seen = new Map<number, MemoryEntity>()
    const now = new Date().toISOString()

    const plotDir = join(this.projectDir, '记忆', '剧情点')
    for (const name of await listPlotFileNames(plotDir)) {
      const text = await readText(join(plotDir, name))
      if (!text) continue
      const doc = parseDoc(text)
      const entityName = extractEntityNameFromDoc(doc, name)
      const num =
        extractChapterNumFromName(entityName) ?? extractChapterNumFromName(name)
      if (num == null) continue
      if (seen.has(num)) continue
      const { fields, order } = parseBoldFields(doc.sections.map((s) => s.body).join('\n'))
      seen.set(
        num,
        this.shapeEntity(entityName, num, fields, order, `记忆/剧情点/${name}`, now, true)
      )
    }

    // Fallback：细纲/细纲_第NNN章_*.md
    const dir = join(this.projectDir, '细纲')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      files = []
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const m = f.match(/^细纲_第(\d+)章_(.+)\.md$/)
      if (!m) continue
      const num = parseInt(m[1], 10)
      const title = m[2]
      if (seen.has(num)) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const { fields, order } = parseBoldFields(doc.sections.map((s) => s.body).join('\n'))
      const name = `第${num}章 ${title}`
      const customFields = this.customFromFields(fields, order, [])
      customFields['章节号'] = String(num)
      seen.set(num, {
        id: `plot-${num}`,
        type: 'plot_point',
        name,
        notes: fieldToStr(fields.get('核心事件')) ?? fieldToStr(fields.get('爽点/打脸')),
        customFields,
        sources: [{ path: `细纲/${f}`, mtime: now }],
        createdAt: now,
        updatedAt: now
      })
    }

    return Array.from(seen.values()).sort((a, b) => {
      const an = a.customFields?.['章节号'] ? Number(a.customFields['章节号']) : 0
      const bn = b.customFields?.['章节号'] ? Number(b.customFields['章节号']) : 0
      return an - bn
    })
  }

  private shapeEntity(
    name: string,
    num: number,
    fields: Map<string, import('../skill-format/md-parser').FieldValue>,
    order: string[],
    source: string,
    now: string,
    includePrimaryInCustom = true
  ): MemoryEntity {
    const customFields = this.customFromFields(fields, order, includePrimaryInCustom ? [] : [])
    customFields['章节号'] = String(num)
    return {
      id: `plot-${num}`,
      type: 'plot_point',
      name,
      notes: fieldToStr(fields.get('核心事件')) ?? fieldToStr(fields.get('爽点/打脸')),
      customFields,
      sources: [{ path: source, mtime: now }],
      createdAt: now,
      updatedAt: now
    }
  }

  private customFromFields(
    fields: Map<string, import('../skill-format/md-parser').FieldValue>,
    order: string[],
    reserved: string[] = []
  ): Record<string, string | string[]> {
    const reservedSet = new Set(reserved)
    const out: Record<string, string | string[]> = {}
    for (const k of order) {
      if (reservedSet.has(k)) continue
      const v = fields.get(k)
      if (v == null) continue
      out[k] = Array.isArray(v) ? [...v] : v
    }
    return out
  }
}

/** 仅顶层 .md 文件名（剧情点目录通常扁平；避免 deep walk 400+ 文件） */
async function listPlotFileNames(plotDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(plotDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch {
    return []
  }
}

function extractChapterNumFromName(name: string): number | null {
  const m = name.match(/第(\d+)章/)
  return m ? parseInt(m[1], 10) : null
}

function stripChapterPrefix(name: string, chapter: number): string {
  return name
    .replace(new RegExp(`^第\\s*0*${chapter}\\s*章\\s*[：:_\\-\\s]*`), '')
    .replace(/^细纲[_\s]*/, '')
    .trim()
}

function extractDescBody(doc: ReturnType<typeof parseDoc>): string | undefined {
  const desc = doc.sections.find((s) => s.title.includes('描述'))
  const raw = (desc?.body ?? doc.body).trim()
  if (!raw) return undefined
  const first = raw
    .split(/\n+/)
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('- **'))
  return first
}

function truncateSummary(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}
