import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseBoldFields, stripNumberPrefix, fieldToStr } from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { listMdFilesDeep, safeFileName, extractEntityNameFromDoc, fieldToJoinedString, sanitizeForFileName, hashName } from './entity-helpers'
import type { MemoryEntity, CreateMemoryEntityInput, UpdateMemoryEntityInput } from '../../../shared/types'

/**
 * 地点 repo。主源 = 记忆/地点/<name>.md；fallback = 设定/世界观/地理.md 的 H2 节。
 */
export class LocationRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const seen = new Map<string, MemoryEntity>()
    const now = new Date().toISOString()

    for (const relPath of await listMdFilesDeep(join(this.projectDir, '记忆', '地点'))) {
      const text = await readText(join(this.projectDir, '记忆', '地点', relPath))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, relPath)
      if (!name || seen.has(name)) continue
      seen.set(name, this.shapeEntity(doc, name, `记忆/地点/${relPath}`, now))
    }

    // Fallback：设定/世界观/地理.md
    await this.parseLocationFallback(join(this.projectDir, '设定', '世界观', '地理.md'), '设定/世界观/地理.md', seen, now)
    // Fallback v3：记忆系统/地点档案.md
    await this.parseLocationFallback(join(this.projectDir, '记忆系统', '地点档案.md'), '记忆系统/地点档案.md', seen, now)

    return Array.from(seen.values())
  }

  async create(input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const dir = join(this.projectDir, '记忆', '地点')
    await fs.mkdir(dir, { recursive: true })
    const now = new Date().toISOString()
    const body = this.serializeEntity(input, now)
    await writeTextAtomic(join(dir, `${sanitizeForFileName(input.name)}.md`), body)
    return {
      id: `loc-${hashName(input.name)}`,
      type: 'location',
      name: input.name,
      category: input.category,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    }
  }

  async update(id: string, patch: UpdateMemoryEntityInput): Promise<MemoryEntity | null> {
    const all = await this.list()
    const existing = all.find((e) => e.id === id)
    if (!existing) return null
    const dir = join(this.projectDir, '记忆', '地点')
    const displayName = patch.name ?? existing.name
    const oldPath = join(dir, `${sanitizeForFileName(existing.name)}.md`)
    const newPath = join(dir, `${sanitizeForFileName(displayName)}.md`)
    const merged: MemoryEntity = {
      ...existing,
      ...patch,
      name: displayName,
      type: 'location',
      updatedAt: new Date().toISOString()
    }
    await writeTextAtomic(newPath, this.serializeEntity(merged, merged.updatedAt))
    if (oldPath !== newPath) {
      try { await fs.unlink(oldPath) } catch { /* ignore */ }
      if (existing.name !== sanitizeForFileName(existing.name)) {
        try { await fs.unlink(join(dir, `${existing.name}.md`)) } catch { /* ignore */ }
      }
    }
    return merged
  }

  async delete(id: string): Promise<void> {
    const all = await this.list()
    const target = all.find((e) => e.id === id)
    if (!target) return
    const dir = join(this.projectDir, '记忆', '地点')
    try { await fs.unlink(join(dir, `${sanitizeForFileName(target.name)}.md`)) } catch { /* ignore */ }
    if (target.name !== sanitizeForFileName(target.name)) {
      try { await fs.unlink(join(dir, `${target.name}.md`)) } catch { /* ignore */ }
    }
  }

  // ===== helpers =====

  private shapeEntity(
    doc: ReturnType<typeof parseDoc>,
    name: string,
    source: string,
    now: string
  ): MemoryEntity {
    const allBody = doc.sections.map((s) => s.body).join('\n')
    const { fields, order } = parseBoldFields(allBody)
    // 「## 描述」节优先作为 notes（v4 序列化格式）
    const descSec = doc.sections.find((s) => s.title.trim() === '描述')
    const notes = descSec
      ? descSec.body.trim() || undefined
      : fieldToStr(fields.get('特征描述')) ?? fieldToStr(fields.get('当前状态'))
    return {
      id: `loc-${hashName(name)}`,
      type: 'location',
      name,
      category: fieldToStr(fields.get('类型')),
      notes,
      customFields: this.customFromFields(fields, order, ['类型', '特征描述', '当前状态']),
      sources: [{ path: source, mtime: now }],
      createdAt: now,
      updatedAt: now
    }
  }

  /** 从 H2 节格式的地点文件（设定/世界观/地理.md 或 记忆系统/地点档案.md）解析地点 */
  private async parseLocationFallback(
    absPath: string,
    relPath: string,
    seen: Map<string, MemoryEntity>,
    now: string
  ): Promise<void> {
    const text = await readText(absPath)
    if (!text) return
    const doc = parseDoc(text)
    for (const sec of doc.sections) {
      const raw = stripNumberPrefix(sec.title)
      const name = safeFileName(raw)
      if (!name || seen.has(name)) continue
      const { fields, order } = parseBoldFields(sec.body)
      const customFields = this.customFromFields(fields, order)
      seen.set(name, {
        id: `loc-${hashName(name)}`,
        type: 'location',
        name,
        category: fieldToStr(fields.get('类型')),
        notes: fieldToStr(fields.get('特征描述')) ?? fieldToStr(fields.get('当前状态')),
        customFields,
        sources: [{ path: relPath, mtime: now }],
        createdAt: now,
        updatedAt: now
      })
    }
  }

  private customFromFields(
    fields: Map<string, import('../skill-format/md-parser').FieldValue>,
    order: string[],
    reserved: string[] = []
  ): Record<string, string | string[]> | undefined {
    const reservedSet = new Set(reserved)
    const out: Record<string, string | string[]> = {}
    for (const k of order) {
      if (reservedSet.has(k)) continue
      const v = fields.get(k)
      if (v == null) continue
      out[k] = Array.isArray(v) ? [...v] : v
    }
    return Object.keys(out).length ? out : undefined
  }

  private serializeEntity(input: { name: string; category?: string; notes?: string; customFields?: Record<string, string | string[]> }, now: string): string {
    const lines: string[] = [`# ${input.name}`, '']
    if (input.notes) lines.push('## 描述', '', input.notes, '')
    lines.push('## 字段', '')
    if (input.category) lines.push(`- **类型**：${input.category}`)
    if (input.customFields) {
      for (const [k, v] of Object.entries(input.customFields)) {
        if (Array.isArray(v)) {
          lines.push(`- **${k}**：${v[0] ?? ''}`)
          for (const sub of v.slice(1)) lines.push(`  - ${sub}`)
        } else {
          lines.push(`- **${k}**：${v}`)
        }
      }
    }
    lines.push('')
    return lines.join('\n')
  }
}