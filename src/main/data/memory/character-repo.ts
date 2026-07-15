import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseBoldFields, parseSubsections, fieldToStr } from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import {
  charId,
  listMdFilesDeep,
  extractEntityNameFromDoc,
  fieldToJoinedString,
  sanitizeForFileName
} from './entity-helpers'
import type { Character, CreateCharacterInput, UpdateCharacterInput } from '../../../shared/types'

/**
 * 人物 repo。一真相源 = 记忆/人物/<name>.md；fallback = 设定/角色/<name>.md。
 * 解析：H1=name；H2 节（基本信息/性格/能力/...）→ first-class 字段；剩余 bold fields → customFields。
 */
export class CharacterRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<Character[]> {
    const seen = new Map<string, Character>()
    const now = new Date().toISOString()

    // 主源：记忆/人物/*.md
    for (const relPath of await listMdFilesDeep(join(this.projectDir, '记忆', '人物'))) {
      const text = await readText(join(this.projectDir, '记忆', '人物', relPath))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, relPath)
      if (!name || seen.has(name)) continue
      seen.set(name, { ...this.parseFromDoc(doc, name, `记忆/人物/${relPath}`), createdAt: now, updatedAt: now })
    }

    // Fallback：设定/角色/*.md（仅补充未在主源出现的人物）
    const rolesDir = join(this.projectDir, '设定', '角色')
    let files: string[] = []
    try {
      files = await fs.readdir(rolesDir)
    } catch {
      files = []
    }
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(rolesDir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const name = extractEntityNameFromDoc(doc, f)
      if (!name || seen.has(name)) continue
      seen.set(name, { ...this.parseFromDoc(doc, name, `设定/角色/${f}`), createdAt: now, updatedAt: now })
    }

    // Fallback：记忆系统/角色卡.md（v3 聚合格式，H2 分类 + H3 角色块）
    if (seen.size === 0) {
      for (const c of await this.listFromV3Card(now)) {
        if (!seen.has(c.name)) seen.set(c.name, c)
      }
    }

    return Array.from(seen.values())
  }

  async get(id: string): Promise<Character | null> {
    const all = await this.list()
    return all.find((c) => c.id === id) ?? null
  }

  async create(input: CreateCharacterInput): Promise<Character> {
    const dir = join(this.projectDir, '记忆', '人物')
    await fs.mkdir(dir, { recursive: true })
    const body = this.serialize(input)
    const fileName = `${sanitizeForFileName(input.name)}.md`
    await writeTextAtomic(join(dir, fileName), body)
    return this.shapeFromInput(input)
  }

  async update(id: string, patch: UpdateCharacterInput): Promise<Character | null> {
    const all = await this.list()
    const existing = all.find((c) => c.id === id)
    if (!existing) return null
    const dir = join(this.projectDir, '记忆', '人物')
    // 显示名保留原文；落盘路径始终经 sanitize（与 create 一致）
    const displayName = patch.name ?? existing.name
    const oldPath = join(dir, `${sanitizeForFileName(existing.name)}.md`)
    const newPath = join(dir, `${sanitizeForFileName(displayName)}.md`)
    // customFields 浅合并：patch 里的 key 覆盖原值，未列出的 key 保留
    const mergedCustomFields = patch.customFields
      ? { ...(existing.customFields ?? {}), ...patch.customFields }
      : existing.customFields
    const merged: Character = {
      ...existing,
      ...patch,
      name: displayName,
      customFields: mergedCustomFields,
      updatedAt: new Date().toISOString()
    }
    const body = this.serialize(merged)
    await writeTextAtomic(newPath, body)
    if (oldPath !== newPath) {
      try { await fs.unlink(oldPath) } catch { /* ignore */ }
      // 兼容历史未 sanitize 的文件名
      if (existing.name !== sanitizeForFileName(existing.name)) {
        try { await fs.unlink(join(dir, `${existing.name}.md`)) } catch { /* ignore */ }
      }
    }
    return merged
  }

  async delete(id: string): Promise<void> {
    const all = await this.list()
    const target = all.find((c) => c.id === id)
    if (!target) return
    const dir = join(this.projectDir, '记忆', '人物')
    try { await fs.unlink(join(dir, `${sanitizeForFileName(target.name)}.md`)) } catch { /* ignore */ }
    if (target.name !== sanitizeForFileName(target.name)) {
      try { await fs.unlink(join(dir, `${target.name}.md`)) } catch { /* ignore */ }
    }
  }

  // ===== 解析器 =====

  private parseFromDoc(
    doc: ReturnType<typeof parseDoc>,
    name: string,
    source: string
  ): Omit<Character, 'createdAt' | 'updatedAt'> {
    // 合并所有 H2 节体（不区分 section，按出现顺序）
    const allBody = doc.sections.map((s) => s.body).join('\n')
    const { fields, order } = parseBoldFields(allBody)

    const basicSec = doc.sections.find((s) => s.title.includes('基本信息'))
    const personalitySec = doc.sections.find((s) => s.title.includes('性格'))
    const abilitySec = doc.sections.find((s) => s.title.includes('能力'))

    let identity: string | undefined
    let role: string | undefined
    if (basicSec) {
      const { fields: bf } = parseBoldFields(basicSec.body)
      identity = fieldToStr(bf.get('身份'))
      // 优先读专用字段「角色定位」（与 serialize 对齐）；否则从身份/阵营关键词推断
      const explicitRole = fieldToStr(bf.get('角色定位'))
      if (explicitRole) {
        role = explicitRole
      } else {
        const idStr = identity ?? ''
        const faction = fieldToStr(bf.get('阵营')) ?? ''
        if (idStr.includes('主角') || faction.includes('主角')) role = '主角'
        else if (idStr.includes('反派') || faction.includes('反派')) role = '核心反派'
        else if (idStr.includes('配角') || faction.includes('配角')) role = '核心配角'
        else role = '核心配角'
      }
    }

    let personality: string | undefined
    if (personalitySec) {
      const { fields: pf } = parseBoldFields(personalitySec.body)
      const explicit = fieldToJoinedString(pf.get('显性性格'))
      const implicit = fieldToJoinedString(pf.get('隐性性格'))
      const parts = [explicit, implicit].filter((v): v is string => Boolean(v))
      if (parts.length > 0) {
        personality = parts.join('；')
      } else {
        personality = fieldToStr(pf.get('性格'))
      }
    }

    let abilities: string | undefined
    if (abilitySec) {
      const { fields: af } = parseBoldFields(abilitySec.body)
      abilities = fieldToStr(af.get('金手指'))
        ?? fieldToStr(af.get('当前境界'))
        ?? fieldToStr(af.get('当前修为'))
    }

    // 解析 tags（#tag# 模式）
    const tagsRaw = fields.get('专属标签')
    const tagsStr = fieldToJoinedString(tagsRaw) ?? ''
    const tags = (tagsStr.match(/#([^#]+)#/g) ?? []).map((t) => t.replace(/#/g, '').trim())
    // 把所有解析到的字段都进 customFields（UI 始终渲染 customFields，与 first-class 合并显示）
    const customFields: Record<string, string | string[]> = {}
    for (const k of order) {
      const v = fields.get(k)
      if (v == null) continue
      customFields[k] = Array.isArray(v) ? [...v] : v
    }

    return {
      id: charId(name),
      name,
      role,
      identity,
      personality,
      abilities,
      tags: tags.length ? tags : undefined,
      synopsis: fieldToStr(fields.get('当前状态')) ?? fieldToStr(fields.get('核心动机')),
      customFields: Object.keys(customFields).length ? customFields : undefined,
      sources: [{ path: source, mtime: new Date().toISOString() }]
    }
  }

  /**
   * v3 兼容：从 记忆系统/角色卡.md（H2 分类 + H3 角色块）解析角色。
   * 仅在 记忆/人物/ 和 设定/角色/ 都为空时作为最后回退。
   */
  private async listFromV3Card(now: string): Promise<Character[]> {
    const text = await readText(join(this.projectDir, '记忆系统', '角色卡.md'))
    if (!text) return []
    const doc = parseDoc(text)
    const out: Character[] = []
    for (const section of doc.sections) {
      const category = section.title.trim()
      if (!['主角', '核心配角', '核心反派'].includes(category)) continue
      for (const sub of parseSubsections(section.body)) {
        const paren = sub.title.match(/^(.+?)（(.+?)）/)
        const name = paren ? paren[1].trim() : sub.title.trim()
        if (!name) continue
        const { fields, order } = parseBoldFields(sub.body)
        const identity = fieldToStr(fields.get('身份'))
        const idStr = identity ?? ''
        const faction = fieldToStr(fields.get('阵营')) ?? ''
        let role: string | undefined
        if (idStr.includes('主角') || faction.includes('主角')) role = '主角'
        else if (idStr.includes('反派') || faction.includes('反派')) role = '核心反派'
        else role = '核心配角'
        const customFields: Record<string, string | string[]> = {}
        for (const k of order) {
          const v = fields.get(k)
          if (v == null) continue
          customFields[k] = Array.isArray(v) ? [...v] : v
        }
        out.push({
          id: charId(name),
          name,
          role: paren ? `${category}·${paren[2].trim()}` : role,
          identity,
          personality: fieldToStr(fields.get('显性性格')) ?? fieldToStr(fields.get('性格')),
          abilities: fieldToStr(fields.get('金手指')) ?? fieldToStr(fields.get('当前境界')),
          synopsis: fieldToStr(fields.get('当前状态')) ?? fieldToStr(fields.get('核心动机')),
          customFields: Object.keys(customFields).length ? customFields : undefined,
          sources: [{ path: '记忆系统/角色卡.md', mtime: now }],
          createdAt: now,
          updatedAt: now
        })
      }
    }
    return out
  }

  /**
   * 统一序列化：create（CreateCharacterInput 无 customFields）与 update（Character 有 customFields）共用。
   * 任何含 name/role/identity/personality/abilities/synopsis/tags/customFields 的对象都可传入。
   */
  private serialize(c: {
    name: string
    role?: string
    identity?: string
    personality?: string
    abilities?: string
    synopsis?: string
    tags?: string[]
    customFields?: Record<string, string | string[]>
  }): string {
    const lines: string[] = [`# ${c.name}`, '']
    if (c.role || c.identity) {
      lines.push('## 基本信息', '')
      // 与 parseFromDoc 对齐：身份 = identity，角色定位 = role
      if (c.identity) lines.push(`- **身份**：${c.identity}`)
      if (c.role) lines.push(`- **角色定位**：${c.role}`)
      lines.push('')
    }
    if (c.personality) {
      lines.push('## 性格', '', `- **显性性格**：${c.personality}`, '')
    }
    if (c.abilities) {
      lines.push('## 能力', '', `- **金手指**：${c.abilities}`, '')
    }
    if (c.synopsis) {
      lines.push('## 当前状态', '', `- **当前状态**：${c.synopsis}`, '')
    }
    if (c.tags && c.tags.length) {
      lines.push('## 标签', '', `- **专属标签**：${c.tags.map((t) => `#${t}#`).join(' ')}`, '')
    }
    if (c.customFields) {
      lines.push('## 自定义', '')
      for (const [k, v] of Object.entries(c.customFields)) {
        if (Array.isArray(v)) {
          lines.push(`- **${k}**：${v[0] ?? ''}`)
          for (const sub of v.slice(1)) lines.push(`  - ${sub}`)
        } else {
          lines.push(`- **${k}**：${v}`)
        }
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  private shapeFromInput(input: CreateCharacterInput): Character {
    return {
      id: charId(input.name),
      name: input.name,
      role: input.role,
      identity: input.identity,
      personality: input.personality,
      abilities: input.abilities,
      tags: input.tags,
      synopsis: input.synopsis,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }
}