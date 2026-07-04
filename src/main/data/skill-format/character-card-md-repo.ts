import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseSubsections, parseBoldFields, findSection, parseTable, type FieldValue } from './md-parser'
import {
  replaceH3Block,
  deleteH3Block,
  appendH3UnderH2,
  appendH2Section,
  serializeBoldFields
} from './md-writer'
import { writeTextAtomic } from '../atomic'
import type {
  Character,
  CreateCharacterInput,
  UpdateCharacterInput,
  Relationship
} from '../../../shared/types'

/**
 * 读取角色卡。真相源：`记忆系统/角色卡.md`。
 * 解析 H2 分类（主角 / 核心配角 / 核心反派）下的 `### 人名（子类型）` 块。
 * 路人角色记录 section 结构不同，Phase 1 不解析。
 *
 * id 由姓名确定性生成（hash），保证跨会话稳定，用于关系联动与 React key。
 */
export class CharacterCardMdRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<Character[]> {
    // 1. 旧格式：记忆系统/角色卡.md（H2 分类 + H3 角色块）
    const file = join(this.projectDir, '记忆系统', '角色卡.md')
    const text = await readText(file)
    const now = new Date().toISOString()
    const characters: Character[] = []
    if (text) {
      const doc = parseDoc(text)
      for (const section of doc.sections) {
        const category = section.title.trim()
        if (!isCharacterCategory(category)) continue
        for (const sub of parseSubsections(section.body)) {
          const c = parseCharacterBlock(sub.title, sub.body, category)
          if (c) characters.push({ ...c, createdAt: now, updatedAt: now })
        }
      }
    }

    // 2. 新格式：设定/角色/{角色名}.md（每角色一文件）
    // 如果旧格式已有同名角色则跳过（旧格式优先）
    const existingNames = new Set(characters.map((c) => c.name))
    const newFormatChars = await this.listPerCharacterFiles()
    for (const c of newFormatChars) {
      if (!existingNames.has(c.name)) {
        characters.push({ ...c, createdAt: now, updatedAt: now })
        existingNames.add(c.name)
      }
    }

    return characters
  }

  /**
   * 读取新格式角色文件：设定/角色/{角色名}.md
   * 每文件 H1 = 角色名，H2 = 基本信息/性格/能力/人物弧线/关系/出场记录/路人记忆点。
   * 解析所有 H2 节的 bold fields 到 rawFields，并提取标准字段。
   */
  private async listPerCharacterFiles(): Promise<Omit<Character, 'createdAt' | 'updatedAt'>[]> {
    const dir = join(this.projectDir, '设定', '角色')
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const characters: Omit<Character, 'createdAt' | 'updatedAt'>[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      const doc = parseDoc(text)
      const name = doc.h1Title.trim() || f.replace(/\.md$/, '')
      if (!name) continue

      // 合并所有 H2 节的 body 到一个字段源
      let fullBody = ''
      for (const sec of doc.sections) {
        fullBody += sec.body + '\n'
      }
      const { fields, order } = parseBoldFields(fullBody)

      // 从「基本信息」节提取标准字段
      const basicSec = doc.sections.find((s) => s.title.includes('基本信息'))
      let role: string | undefined
      let identity: string | undefined
      if (basicSec) {
        const { fields: basicFields } = parseBoldFields(basicSec.body)
        identity = toStr(basicFields.get('身份'))
        // 从身份推断角色类型
        const idStr = identity ?? ''
        const faction = toStr(basicFields.get('阵营')) ?? ''
        if (name === doc.h1Title.trim()) {
          // 默认按身份推断角色
          if (idStr.includes('主角') || faction.includes('主角')) role = '主角'
          else if (idStr.includes('反派') || faction.includes('反派')) role = '核心反派'
          else if (idStr.includes('配角') || faction.includes('配角')) role = '核心配角'
          else role = '核心配角'
        }
      }

      // 从「性格」节提取 personality
      const personalitySec = doc.sections.find((s) => s.title.includes('性格'))
      let personality: string | undefined
      if (personalitySec) {
        const { fields: pFields } = parseBoldFields(personalitySec.body)
        personality = joinFields(pFields.get('显性性格'), pFields.get('隐性性格'))
          ?? toStr(pFields.get('性格'))
      }

      // 从「能力」节提取 abilities
      const abilitySec = doc.sections.find((s) => s.title.includes('能力'))
      let abilities: string | undefined
      if (abilitySec) {
        const { fields: aFields } = parseBoldFields(abilitySec.body)
        abilities = toStr(aFields.get('金手指'))
          ?? toStr(aFields.get('当前境界'))
          ?? toStr(aFields.get('当前修为'))
      }

      characters.push({
        id: charId(name),
        name,
        role,
        identity,
        personality,
        abilities,
        tags: parseTags(fields.get('专属标签')),
        synopsis: toStr(fields.get('当前状态')),
        rawFields: toRawFields(fields, order)
      })
    }
    return characters
  }

  /**
   * 读取「关系变更日志」表 → Relationship[]。
   * 表列：章节 | 角色A | 角色B | 变更前 | 变更后 | 触发事件。
   * 每行映射为一条关系（relationType=变更后，description 含变更轨迹+触发事件）。
   * characterAId/BId 用与角色一致的 charId 哈希，便于交叉引用。
   */
  async listRelationships(): Promise<Relationship[]> {
    const file = join(this.projectDir, '记忆系统', '角色卡.md')
    const text = await readText(file)
    if (!text) return []
    const doc = parseDoc(text)
    const sec = findSection(doc, '关系变更日志')
    if (!sec) return []
    const { headers, rows } = parseTable(sec.body)
    if (headers.length < 5) return []
    const idx = {
      chapter: headers.findIndex((h) => h.includes('章节')),
      a: headers.findIndex((h) => h.includes('角色A') || h === '角色A'),
      b: headers.findIndex((h) => h.includes('角色B') || h === '角色B'),
      before: headers.findIndex((h) => h.includes('变更前')),
      after: headers.findIndex((h) => h.includes('变更后')),
      trigger: headers.findIndex((h) => h.includes('触发'))
    }
    const now = new Date().toISOString()
    return rows
      .map((row, i) => {
        const nameA = idx.a >= 0 ? row[idx.a] : ''
        const nameB = idx.b >= 0 ? row[idx.b] : ''
        if (!nameA || !nameB) return null
        const after = idx.after >= 0 ? row[idx.after] : ''
        const before = idx.before >= 0 ? row[idx.before] : ''
        const ch = idx.chapter >= 0 ? row[idx.chapter] : ''
        const trigger = idx.trigger >= 0 ? row[idx.trigger] : ''
        const desc = [before && after ? `${before}→${after}` : after, ch && `（${ch}）`, trigger]
          .filter(Boolean)
          .join(' ')
        return {
          id: `rel-${i + 1}`,
          characterAId: charId(nameA),
          characterBId: charId(nameB),
          relationType: after || before || '关系',
          description: desc || undefined,
          createdAt: now,
          updatedAt: now
        } as Relationship
      })
      .filter((r): r is Relationship => r !== null)
  }

  // ===== Phase 3 写入（外科手术式，保留 路人/关系图/关系日志 等未识别节） =====

  private async file(): Promise<{ path: string; text: string }> {
    const path = join(this.projectDir, '记忆系统', '角色卡.md')
    return { path, text: await readText(path) }
  }

  async create(input: CreateCharacterInput): Promise<Character> {
    const { path, text } = await this.file()
    const category = categoryFromRole(input.role)
    const subRole = subRoleFromRole(input.role)
    const block = serializeCharacterBlock(input.name, subRole, canonicalFields(input))
    let next = text
    // 若分类 H2 不存在，先建
    const lines = next.split(/\r?\n/)
    const hasSection = lines.some((l) => new RegExp(`^## ${category}\\s*$`).test(l))
    if (!hasSection) next = appendH2Section(next, category, '')
    next = appendH3UnderH2(next, category, block)
    await writeTextAtomic(path, next)
    const now = new Date().toISOString()
    return { ...characterFromInput(input), createdAt: now, updatedAt: now }
  }

  async update(oldName: string, patch: UpdateCharacterInput): Promise<Character | null> {
    const { path, text } = await this.file()
    // 取现有角色的 rawFields（保留全部原始字段）
    const existing = (await this.list()).find((c) => c.name === oldName)
    if (!existing) return null
    const raw = applyPatchToRaw({ ...(existing.rawFields ?? {}) }, patch)
    const newName = patch.name ?? oldName
    const subRole = patch.role !== undefined ? subRoleFromRole(patch.role) : subRoleFromRole(existing.role)
    const block = `### ${newName}${subRole ? `（${subRole}）` : ''}\n${serializeBoldFields(raw)}`
    const next = replaceH3Block(text, oldName, block)
    if (next === text) return null
    await writeTextAtomic(path, next)
    return {
      ...existing,
      ...patch,
      name: newName,
      role: patch.role ?? existing.role,
      rawFields: raw,
      updatedAt: new Date().toISOString()
    }
  }

  async delete(name: string): Promise<void> {
    const { path, text } = await this.file()
    const next = deleteH3Block(text, name)
    if (next === text) return
    await writeTextAtomic(path, next)
  }
}

/** 由 role 推断分类 H2 标题 */
function categoryFromRole(role: string | undefined): string {
  const r = role ?? ''
  if (r.includes('主角')) return '主角'
  if (r.includes('反派')) return '核心反派'
  if (r.includes('配角')) return '核心配角'
  return '核心配角'
}

/** 由 role 提取子类型（用于 H3 标题的括号） */
function subRoleFromRole(role: string | undefined): string {
  const r = role ?? ''
  const dot = r.indexOf('·')
  return dot >= 0 ? r.slice(dot + 1).trim() : ''
}

/** 新建角色的规范字段集（无 rawFields 时用） */
function canonicalFields(input: CreateCharacterInput): Record<string, string | string[]> {
  const f: Record<string, string | string[]> = {}
  f['姓名'] = input.name
  if (input.identity) f['身份'] = input.identity
  if (input.personality) f['显性性格'] = input.personality
  if (input.abilities) f['金手指'] = input.abilities
  if (input.tags && input.tags.length) f['专属标签'] = input.tags.map((t) => `#${t}#`).join(' ')
  if (input.synopsis) f['当前状态'] = input.synopsis
  return f
}

function serializeCharacterBlock(
  name: string,
  subRole: string,
  fields: Record<string, string | string[]>
): string {
  return `### ${name}${subRole ? `（${subRole}）` : ''}\n${serializeBoldFields(fields)}`
}

/** 把 app patch 应用到 rawFields（保留其他原始字段；清掉对应的次要字段避免重复） */
function applyPatchToRaw(
  raw: Record<string, string | string[]>,
  patch: UpdateCharacterInput
): Record<string, string | string[]> {
  const next = { ...raw }
  if (patch.name !== undefined) next['姓名'] = patch.name
  if (patch.identity !== undefined) next['身份'] = patch.identity
  if (patch.personality !== undefined) {
    next['显性性格'] = patch.personality
    delete next['隐性性格']
  }
  if (patch.abilities !== undefined) {
    next['金手指'] = patch.abilities
    delete next['觉醒路线']
  }
  if (patch.tags !== undefined) {
    next['专属标签'] = patch.tags && patch.tags.length ? patch.tags.map((t) => `#${t}#`).join(' ') : ''
  }
  if (patch.synopsis !== undefined) next['当前状态'] = patch.synopsis
  return next
}

function characterFromInput(input: CreateCharacterInput): Omit<Character, 'createdAt' | 'updatedAt'> {
  return {
    id: charId(input.name),
    name: input.name,
    role: input.role,
    identity: input.identity,
    personality: input.personality,
    abilities: input.abilities,
    tags: input.tags,
    synopsis: input.synopsis
  }
}

function isCharacterCategory(title: string): boolean {
  return ['主角', '核心配角', '核心反派'].includes(title)
}

function parseCharacterBlock(
  heading: string,
  body: string,
  category: string
): Omit<Character, 'createdAt' | 'updatedAt'> | null {
  // heading 形如 "苏铭（男主）" 或 "老吴"
  const parenMatch = heading.match(/^(.+?)（(.+?)）/)
  const name = (parenMatch ? parenMatch[1] : heading).trim()
  const subRole = parenMatch ? parenMatch[2].trim() : ''
  if (!name) return null

  const { fields, order } = parseBoldFields(body)
  const role = subRole ? `${category}·${subRole}` : category
  const personality = joinFields(fields.get('显性性格'), fields.get('隐性性格'))
  const abilities = joinFields(fields.get('金手指'), fields.get('觉醒路线'))

  return {
    id: charId(name),
    name,
    role,
    identity: toStr(fields.get('身份')),
    personality,
    abilities,
    tags: parseTags(fields.get('专属标签')),
    synopsis: toStr(fields.get('当前状态')) ?? toStr(fields.get('核心动机')),
    rawFields: toRawFields(fields, order)
  }
}

function charId(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return 'char-' + Math.abs(h).toString(36)
}

function joinFields(a: FieldValue | undefined, b: FieldValue | undefined): string | undefined {
  const parts: string[] = []
  if (a) parts.push(...(Array.isArray(a) ? a : [a]))
  if (b) parts.push(...(Array.isArray(b) ? b : [b]))
  return parts.length ? parts.join('；') : undefined
}

function parseTags(v: FieldValue | undefined): string[] | undefined {
  if (v == null) return undefined
  const s = Array.isArray(v) ? v.join(' ') : v
  // 专属标签形如 `#末日也要先领证#` `#闷骚护妻狂魔#`
  const tags = s.match(/#([^#]+)#/g)?.map((t) => t.replace(/#/g, '').trim()) ?? []
  return tags.length ? tags : undefined
}

function toStr(v: FieldValue | undefined): string | undefined {
  if (v == null || v === '') return undefined
  return Array.isArray(v) ? v.join('；') : v
}

function toRawFields(
  fields: Map<string, FieldValue>,
  order: string[]
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of order) {
    const v = fields.get(k)
    if (v == null) continue
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}
