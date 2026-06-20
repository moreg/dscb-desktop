import { join } from 'path'
import {
  readText,
  parseDoc,
  parseBoldFields,
  fieldToStr,
  fieldsToRaw,
  deterministicId,
  stripNumberPrefix
} from './md-parser'
import { appendH2Section, deleteH2Section, serializeBoldFields } from './md-writer'
import { writeTextAtomic } from '../atomic'
import type {
  MemoryEntity,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../../shared/types'

/**
 * 读取地点档案。真相源：`记忆系统/地点档案.md`。
 * 每个 `## N. 地名` 是一个地点，含 类型/特征描述/关联事件/关联角色/当前状态 等字段。
 */
export class LocationMdRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<MemoryEntity[]> {
    const text = await readText(join(this.projectDir, '记忆系统', '地点档案.md'))
    if (!text) return []
    const doc = parseDoc(text)
    const now = new Date().toISOString()
    const entities: MemoryEntity[] = []
    for (const section of doc.sections) {
      const name = stripNumberPrefix(section.title)
      if (!name) continue
      const { fields, order } = parseBoldFields(section.body)
      entities.push({
        id: deterministicId('loc', name),
        name,
        category: fieldToStr(fields.get('类型')),
        notes:
          fieldToStr(fields.get('特征描述')) ??
          fieldToStr(fields.get('当前状态')),
        rawFields: fieldsToRaw(fields, order),
        createdAt: now,
        updatedAt: now
      })
    }
    return entities
  }

  // ===== Phase 3b 写入（## N. 地名 节增删改） =====

  private async file(): Promise<{ path: string; text: string }> {
    const path = join(this.projectDir, '记忆系统', '地点档案.md')
    return { path, text: await readText(path) }
  }

  private async nextNumber(): Promise<number> {
    const { text } = await this.file()
    const doc = parseDoc(text)
    let max = 0
    for (const s of doc.sections) {
      const m = s.title.match(/^\s*(\d+)\s*[.、]/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return max + 1
  }

  async create(input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const { path, text } = await this.file()
    const num = await this.nextNumber()
    const title = `${num}. ${input.name}`
    const body = serializeLocationBody(input)
    await writeTextAtomic(path, appendH2Section(text, title, body))
    const now = new Date().toISOString()
    return {
      id: deterministicId('loc', input.name),
      name: input.name,
      category: input.category,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    }
  }

  async update(oldName: string, patch: UpdateMemoryEntityInput): Promise<MemoryEntity | null> {
    const { path, text } = await this.file()
    const existing = (await this.list()).find((e) => e.name === oldName)
    if (!existing) return null
    // 保留原 rawFields，应用 patch 到对应字段
    const raw: Record<string, string | string[]> = { ...(existing.rawFields ?? {}) }
    if (patch.category !== undefined) raw['类型'] = patch.category
    if (patch.notes !== undefined) raw['特征描述'] = patch.notes
    if (Object.keys(raw).length === 0) {
      raw['类型'] = existing.category ?? ''
      raw['特征描述'] = existing.notes ?? ''
    }
    const newName = patch.name ?? oldName
    // 节标题里的序号保留：`## N. oldName` → 重建为 `## N. newName`
    const headingLine = text.split(/\r?\n/).find((l) => new RegExp(`^## \\d+[.、]\\s*${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l))
    const numPrefix = headingLine?.match(/^##\s*(\d+\s*[.、])/)?.[1] ?? `${await this.nextNumber()}. `
    const next = deleteH2Section(text, headingLine?.replace(/^##\s*/, '').trim() ?? oldName)
    const recreated = appendH2Section(next, `${numPrefix}${newName}`, serializeBoldFields(raw))
    await writeTextAtomic(path, recreated)
    return { ...existing, ...patch, name: newName, rawFields: raw, updatedAt: new Date().toISOString() }
  }

  async delete(name: string): Promise<void> {
    const { path, text } = await this.file()
    // 节标题可能带序号前缀，按 name 结尾匹配整节
    const doc = parseDoc(text)
    const sec = doc.sections.find((s) => stripNumberPrefix(s.title) === name)
    if (!sec) return
    await writeTextAtomic(path, deleteH2Section(text, sec.title))
  }
}

function serializeLocationBody(input: CreateMemoryEntityInput): string {
  const fields: Record<string, string | string[]> = {}
  if (input.category) fields['类型'] = input.category
  if (input.notes) fields['特征描述'] = input.notes
  return Object.keys(fields).length ? serializeBoldFields(fields) : '- **类型**：未分类'
}
