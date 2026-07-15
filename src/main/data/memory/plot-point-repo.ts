import { join } from 'path'
import { promises as fs } from 'fs'
import {
  readText,
  parseDoc,
  parseBoldFields,
  parseChapterNumber,
  titleAfterColon,
  fieldToStr
} from '../skill-format/md-parser'
import { listMdFilesDeep, extractEntityNameFromDoc } from './entity-helpers'
import type { MemoryEntity } from '../../../shared/types'

/**
 * 剧情点 repo。主源 = 记忆/剧情点/*.md；fallback = 细纲/细纲_第NNN章_*.md。
 */
export class PlotPointRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const seen = new Map<number, MemoryEntity>()
    const now = new Date().toISOString()

    for (const relPath of await listMdFilesDeep(join(this.projectDir, '记忆', '剧情点'))) {
      const text = await readText(join(this.projectDir, '记忆', '剧情点', relPath))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, relPath)
      const num = this.extractChapterNum(name) ?? this.extractChapterNum(relPath)
      if (num == null) continue
      if (seen.has(num)) continue
      const { fields, order } = parseBoldFields(doc.sections.map((s) => s.body).join('\n'))
      seen.set(num, this.shapeEntity(name, num, fields, order, `记忆/剧情点/${relPath}`, now, true))
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

  // ===== helpers =====

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

  private extractChapterNum(name: string): number | null {
    const m = name.match(/第(\d+)章/)
    return m ? parseInt(m[1], 10) : null
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