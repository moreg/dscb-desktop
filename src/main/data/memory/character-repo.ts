import { cachedMemoryList, findMemoryEntity, readMemoryDocuments, readMemoryText as readText, memoryFileFingerprint, memorySnapshot, memorySourcePath, invalidateMemoryProject } from './repository-cache'
import { join, resolve, relative } from 'path'
import { promises as fs } from 'fs'
import { parseDoc, parseBoldFields, parseSubsections, fieldToStr } from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { withFileLock } from '../file-lock'
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
    return cachedMemoryList(this.projectDir, 'character', () => this.load())
  }

  async get(id: string): Promise<Character | null> {
    return findMemoryEntity(this.projectDir, 'character', () => this.load(), id)
  }

  private async load(): Promise<Character[]> {
    const seen = new Map<string, Character>()
    const now = new Date().toISOString()

    // 主源：记忆/人物/*.md
    const root = join(this.projectDir, '记忆', '人物')
    for (const { path: relPath, text, doc } of await readMemoryDocuments(root, await listMdFilesDeep(root))) {
      if (!text) continue
      const name = extractEntityNameFromDoc(doc, relPath)
      if (!name || seen.has(name)) continue
      seen.set(name, { ...this.parseFromDoc(doc, name, `记忆/人物/${relPath}`), createdAt: now, updatedAt: now })
    }

    // Fallback：设定/角色/*.md（仅补充未在主源出现的人物）
    const rolesDir = join(this.projectDir, '设定', '角色')
    let files: string[]
    try {
      files = await fs.readdir(rolesDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      files = []
    }
    for (const { path: f, text, doc } of await readMemoryDocuments(rolesDir, files.filter(file => file.endsWith('.md')).sort())) {
      if (!text) continue
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

  async create(input: CreateCharacterInput): Promise<Character> {
    return withFileLock(join(this.projectDir, '记忆', '人物'), () => this.writeCreated(input))
  }

  private async writeCreated(input: CreateCharacterInput): Promise<Character> {
    const dir = join(this.projectDir, '记忆', '人物')
    await fs.mkdir(dir, { recursive: true })
    const body = this.serialize(input)
    const fileName = `${sanitizeForFileName(input.name)}.md`
    await writeTextAtomic(join(dir, fileName), body)
    return this.shapeFromInput(input)
  }

  async update(id: string, patch: UpdateCharacterInput): Promise<Character | null> {
    return withFileLock(join(this.projectDir, '记忆', '人物'), async () => {
      const existing = await this.get(id)
      return existing ? this.writeUpdated(existing, patch) : null
    })
  }

  async updateMany(updates: Array<{ id: string; patch: UpdateCharacterInput }>, expected?: Character[]): Promise<Character[]> {
    return withFileLock(join(this.projectDir, '记忆', '人物'), async () => {
      const { entities: characters, fingerprints: sourceFingerprints } = await memorySnapshot(this.projectDir, 'character', () => this.load())
      const byId = new Map(characters.map(character => [character.id, character]))
      const expectedById = new Map(expected?.map(character => [character.id, character]))
      const fingerprints = new Map(characters.map(character => {
        const file = character.sources?.[0]?.path
        const absolute = file ? resolve(this.projectDir, file) : ''
        return [character.id, { file: absolute, fingerprint: sourceFingerprints.get(absolute) }]
      }))
      const results: Character[] = []
      for (const { id, patch } of updates) {
        const existing = byId.get(id)
        if (!existing) continue
        const previous = expectedById.get(id)
        const identityFields = ['name', 'identity', 'role', 'personality', 'abilities', 'synopsis'] as const
        if (previous && (this.serialize(previous) !== this.serialize(existing) ||
          identityFields.some(field => previous[field] !== existing[field]))) {
          throw new Error('人物卡已被修改，请重新读取后重试')
        }
        const baseline = fingerprints.get(id)!
        const currentFingerprint = await memoryFileFingerprint(baseline.file)
        if (!baseline.fingerprint || currentFingerprint !== baseline.fingerprint) {
          invalidateMemoryProject(this.projectDir)
          throw new Error('人物卡已被修改，请重新读取后重试')
        }
        // Same-size edits can share a filesystem timestamp. Re-read only the
        // cards being changed before applying a patch computed from older text.
        const cachedText = await readText(baseline.file)
        const currentText = await fs.readFile(baseline.file, 'utf-8')
        if (cachedText !== currentText) {
          invalidateMemoryProject(this.projectDir)
          throw new Error('人物卡已被修改，请重新读取后重试')
        }
        const updated = await this.writeUpdated(existing, patch)
        results.push(updated)
        byId.set(id, updated)
        const file = memorySourcePath(this.projectDir, '人物', existing.sources?.[0]?.path) ?? join(this.projectDir, '记忆', '人物', `${sanitizeForFileName(existing.name)}.md`)
        const updatedFile = patch.name && patch.name !== existing.name ? join(this.projectDir, '记忆', '人物', `${sanitizeForFileName(patch.name)}.md`) : file
        updated.sources = [{ path: relative(this.projectDir, updatedFile).replace(/\\/g, '/'), mtime: updated.updatedAt }]
        fingerprints.set(id, { file: updatedFile, fingerprint: await memoryFileFingerprint(updatedFile) })
      }
      return results
    })
  }

  private async writeUpdated(existing: Character, patch: UpdateCharacterInput): Promise<Character> {
    const dir = join(this.projectDir, '记忆', '人物')
    // 显示名保留原文；落盘路径始终经 sanitize（与 create 一致）
    const displayName = patch.name ?? existing.name
    const oldPath = memorySourcePath(this.projectDir, '人物', existing.sources?.[0]?.path) ?? join(dir, `${sanitizeForFileName(existing.name)}.md`)
    const newPath = displayName === existing.name ? oldPath : join(dir, `${sanitizeForFileName(displayName)}.md`)
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
    return withFileLock(join(this.projectDir, '记忆', '人物'), () => this.deleteExisting(id))
  }

  private async deleteExisting(id: string): Promise<void> {
    const target = await this.get(id)
    if (!target) return
    const dir = join(this.projectDir, '记忆', '人物')
    try { await fs.unlink(memorySourcePath(this.projectDir, '人物', target.sources?.[0]?.path) ?? join(dir, `${sanitizeForFileName(target.name)}.md`)) } catch { /* ignore */ }
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
