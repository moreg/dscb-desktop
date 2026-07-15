import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc } from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { listMdFilesDeep, extractEntityNameFromDoc, sanitizeForFileName, hashName } from './entity-helpers'
import type { MemoryEntity, CreateMemoryEntityInput, UpdateMemoryEntityInput } from '../../../shared/types'

/**
 * 世界观 repo。主源 = 记忆/世界观/<name>.md（含子目录）；fallback = 设定/世界观/<name>.md。
 */
export class WorldviewRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const seen = new Map<string, MemoryEntity>()
    const now = new Date().toISOString()

    for (const relPath of await listMdFilesDeep(join(this.projectDir, '记忆', '世界观'))) {
      const text = await readText(join(this.projectDir, '记忆', '世界观', relPath))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, relPath)
      if (!name || seen.has(name)) continue
      seen.set(name, this.shapeEntity(doc, name, `记忆/世界观/${relPath}`, now))
    }

    // Fallback：枚举 设定/世界观/*.md（不含子目录）
    const dir = join(this.projectDir, '设定', '世界观')
    let files: string[] = []
    try {
      files = await fs.readdir(dir)
    } catch {
      files = []
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, f)
      if (!name || seen.has(name)) continue
      seen.set(name, this.shapeEntity(doc, name, `设定/世界观/${f}`, now))
    }

    // Fallback v3：记忆系统/世界观设定.md（H2 节格式，每节一个世界观条目）
    const v3Text = await readText(join(this.projectDir, '记忆系统', '世界观设定.md'))
    if (v3Text) {
      const doc = parseDoc(v3Text)
      for (const sec of doc.sections) {
        const name = sec.title.trim()
        if (!name || seen.has(name)) continue
        const notes = sec.body.trim() || undefined
        seen.set(name, {
          id: `wv-${hashName(name)}`,
          type: 'worldview',
          name,
          notes,
          sources: [{ path: '记忆系统/世界观设定.md', mtime: now }],
          createdAt: now,
          updatedAt: now
        })
      }
    }

    return Array.from(seen.values())
  }

  async create(input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const dir = join(this.projectDir, '记忆', '世界观')
    await fs.mkdir(dir, { recursive: true })
    const now = new Date().toISOString()
    const body = this.serializeEntity(input, now)
    await writeTextAtomic(join(dir, `${sanitizeForFileName(input.name)}.md`), body)
    return {
      id: `wv-${hashName(input.name)}`,
      type: 'worldview',
      name: input.name,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    }
  }

  async update(id: string, patch: UpdateMemoryEntityInput): Promise<MemoryEntity | null> {
    const all = await this.list()
    const existing = all.find((e) => e.id === id)
    if (!existing) return null
    const dir = join(this.projectDir, '记忆', '世界观')
    const oldName = existing.name
    const newName = patch.name ? sanitizeForFileName(patch.name) : existing.name
    const merged: MemoryEntity = {
      ...existing,
      ...patch,
      name: newName,
      type: 'worldview',
      updatedAt: new Date().toISOString()
    }
    await writeTextAtomic(join(dir, `${newName}.md`), this.serializeEntity(merged, merged.updatedAt))
    if (newName !== oldName) {
      try { await fs.unlink(join(dir, `${oldName}.md`)) } catch { /* ignore */ }
    }
    return merged
  }

  async delete(id: string): Promise<void> {
    const all = await this.list()
    const target = all.find((e) => e.id === id)
    if (!target) return
    try { await fs.unlink(join(this.projectDir, '记忆', '世界观', `${target.name}.md`)) } catch { /* ignore */ }
  }

  // ===== helpers =====

  private shapeEntity(
    doc: ReturnType<typeof parseDoc>,
    name: string,
    source: string,
    now: string
  ): MemoryEntity {
    const notes = doc.sections.length === 0
      ? doc.body.trim() || undefined
      : doc.sections.map((s) => `## ${s.title}\n\n${s.body.trim()}`).join('\n\n').trim() || undefined
    return {
      id: `wv-${hashName(name)}`,
      type: 'worldview',
      name,
      notes,
      sources: [{ path: source, mtime: now }],
      createdAt: now,
      updatedAt: now
    }
  }

  private serializeEntity(input: { name: string; notes?: string }, _now: string): string {
    const lines: string[] = [`# ${input.name}`, '']
    if (input.notes) lines.push(input.notes, '')
    return lines.join('\n')
  }
}