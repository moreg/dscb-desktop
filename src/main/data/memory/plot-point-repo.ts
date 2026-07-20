import { join } from 'path'
import { promises as fs } from 'fs'
import {
  readText,
  parseDoc,
  parseBoldFields,
  fieldToStr
} from '../skill-format/md-parser'
import { ProseRepo } from '../skill-format/prose-repo'
import { extractEntityNameFromDoc } from './entity-helpers'
import type { MemoryEntity } from '../../../shared/types'

/** 续写中程记忆：一章一行摘要 */
export interface PlotChapterSummary {
  chapterNumber: number
  /** 章标题（可空） */
  title: string
  /** 核心事件摘要（已截断） */
  summary: string
}

/**
 * 续写注入的「本章之前最近 N 章」默认数量。
 * 平衡长篇因果记忆与 token：12 章约覆盖卷内半程，远强于仅 3 条日更。
 */
export const RECENT_PLOT_CHAPTERS = 12

/** 单章摘要最大字符数，防止多剧情点拼接后撑爆 prompt */
export const PLOT_SUMMARY_MAX_CHARS = 200

/** 摘要缓存 TTL（毫秒）：同进程内短时复用，避免写后自检/续写连打两次 */
const SUMMARY_CACHE_TTL_MS = 30_000

type CacheEntry = { at: number; value: PlotChapterSummary[] }

const summaryCache = new Map<string, CacheEntry>()

export interface ListSummariesBeforeOptions {
  /**
   * 仅保留「正文/ 已有文件」的章（默认 true）。
   * 避免把未写正文的细纲/剧情点当成既成事实注入续写。
   */
  onlyWithProse?: boolean
  /** 跳过缓存（测试或强制刷新） */
  skipCache?: boolean
}

/**
 * 剧情点 repo。主源 = 记忆/剧情点/*.md；fallback = 细纲/细纲_第NNN章_*.md。
 */
export class PlotPointRepo {
  constructor(private readonly projectDir: string) {}

  /**
   * 取「写第 chapterNumber 章之前」最近 limit 章的剧情摘要（不含本章）。
   * 优先 记忆/剧情点；缺章时用 细纲 核心事件补洞。
   * 默认 onlyWithProse：先找已写正文的最近 limit 章，再按文件名过滤后只读目标章。
   */
  async listSummariesBefore(
    chapterNumber: number,
    limit: number = RECENT_PLOT_CHAPTERS,
    opts: ListSummariesBeforeOptions = {}
  ): Promise<PlotChapterSummary[]> {
    if (chapterNumber <= 1 || limit <= 0) return []
    const onlyWithProse = opts.onlyWithProse !== false
    const maxCh = chapterNumber - 1

    const cacheKey = `${this.projectDir}|${chapterNumber}|${limit}|${onlyWithProse ? 1 : 0}`
    if (!opts.skipCache) {
      const hit = summaryCache.get(cacheKey)
      if (hit && Date.now() - hit.at < SUMMARY_CACHE_TTL_MS) {
        return hit.value
      }
    }

    // 目标章号列表：已写正文的最近 limit 章，或简单窗口 [max-limit+1, max]
    let targetChapters: number[]
    if (onlyWithProse) {
      const written = (await new ProseRepo(this.projectDir).listChapterNumbers()).filter(
        (n) => n >= 1 && n <= maxCh
      )
      targetChapters = written.slice(-limit)
      if (targetChapters.length === 0) {
        summaryCache.set(cacheKey, { at: Date.now(), value: [] })
        return []
      }
    } else {
      const minCh = Math.max(1, chapterNumber - limit)
      targetChapters = []
      for (let n = minCh; n <= maxCh; n++) targetChapters.push(n)
    }

    const targetSet = new Set(targetChapters)
    const buckets = new Map<number, { titles: string[]; events: string[] }>()

    const ensure = (n: number) => {
      let b = buckets.get(n)
      if (!b) {
        b = { titles: [], events: [] }
        buckets.set(n, b)
      }
      return b
    }

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
      const b = ensure(num)
      if (title && !b.titles.includes(title)) b.titles.push(title)
      const e = event.trim()
      if (e && !b.events.some((x) => x === e || x.includes(e) || e.includes(x))) {
        b.events.push(e)
      }
    }

    // 2) 细纲补洞：只 readdir 一次，按文件名过滤目标章
    const outlineDir = join(this.projectDir, '细纲')
    let outlineFiles: string[] = []
    try {
      outlineFiles = await fs.readdir(outlineDir)
    } catch {
      outlineFiles = []
    }
    for (const f of outlineFiles) {
      if (!f.endsWith('.md')) continue
      const m = f.match(/^细纲_第(\d+)章_(.+)\.md$/)
      if (!m) continue
      const num = parseInt(m[1], 10)
      if (!targetSet.has(num)) continue
      const existing = buckets.get(num)
      if (existing && existing.events.length > 0) continue
      const text = await readText(join(outlineDir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const { fields } = parseBoldFields(
        doc.sections.map((s) => s.body).join('\n') + '\n' + doc.body
      )
      const event = fieldToStr(fields.get('核心事件')) ?? ''
      const title = m[2]
      const b = ensure(num)
      if (title && !b.titles.includes(title)) b.titles.push(title)
      if (event.trim()) b.events.push(event.trim())
    }

    const out: PlotChapterSummary[] = []
    for (const n of targetChapters) {
      const b = buckets.get(n)
      if (b) {
        const summary = truncateSummary(b.events.join('；'), PLOT_SUMMARY_MAX_CHARS)
        out.push({
          chapterNumber: n,
          title: b.titles[0] ?? '',
          summary: summary || b.titles[0] || `第 ${n} 章（已写，摘要待同步）`
        })
      } else if (onlyWithProse) {
        out.push({
          chapterNumber: n,
          title: '',
          summary: `第 ${n} 章已有正文（记忆摘要待写后同步）`
        })
      }
    }

    summaryCache.set(cacheKey, { at: Date.now(), value: out })
    return out
  }

  /** 写后同步等场景可清缓存，避免读到旧摘要 */
  static invalidateCache(projectDir?: string): void {
    if (!projectDir) {
      summaryCache.clear()
      return
    }
    for (const k of summaryCache.keys()) {
      if (k.startsWith(projectDir + '|')) summaryCache.delete(k)
    }
  }

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
    let files: string[] = []
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
