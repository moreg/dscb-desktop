import { join } from 'path'
import { promises as fs } from 'fs'
import { readText, parseDoc, parseTable } from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { charId, sanitizeForFileName, hashName } from './entity-helpers'
import type { Character } from '../../../shared/types'
import type { Relationship, CreateRelationshipInput, UpdateRelationshipInput } from '../../../shared/types'

/**
 * 关系 repo。主源 = 记忆/关系/<A>__<B>.md；fallback = 设定/关系.md 的「关系变更日志」表。
 */
export class RelationshipRepo {
  constructor(
    private readonly projectDir: string,
    /** 可选：角色 repo 引用，用于 id -> name 反查（create 只传 id 时）。 */
    private readonly nameResolver?: { list(): Promise<Character[]> }
  ) {}

  async list(): Promise<Relationship[]> {
    const seen = new Map<string, Relationship>()
    const now = new Date().toISOString()

    // 主源：枚举 记忆/关系/*.md
    const dir = join(this.projectDir, '记忆', '关系')
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
      const rel = this.parseMainFile(f, text, now)
      if (!rel) continue
      seen.set(`${rel.characterAId}__${rel.characterBId}`, rel)
    }

    // Fallback：设定/关系.md
    const fallbackText = await readText(join(this.projectDir, '设定', '关系.md'))
    if (fallbackText) {
      const doc = parseDoc(fallbackText)
      const sec = doc.sections.find((s) => s.title.includes('关系变更日志'))
      const body = sec?.body ?? fallbackText.slice(fallbackText.indexOf('\n', fallbackText.indexOf('#')) + 1)
      const { headers, rows } = parseTable(body)
      if (headers.length >= 5) {
        const idx = {
          chapter: headers.findIndex((h) => h.includes('章节')),
          a: headers.findIndex((h) => h.includes('角色A') || h === '角色A'),
          b: headers.findIndex((h) => h.includes('角色B') || h === '角色B'),
          before: headers.findIndex((h) => h.includes('变更前')),
          after: headers.findIndex((h) => h.includes('变更后')),
          trigger: headers.findIndex((h) => h.includes('触发'))
        }
        rows.forEach((row, i) => {
          const a = idx.a >= 0 ? row[idx.a].trim() : ''
          const b = idx.b >= 0 ? row[idx.b].trim() : ''
          if (!a || !b) return
          const after = idx.after >= 0 ? row[idx.after].trim() : ''
          const before = idx.before >= 0 ? row[idx.before].trim() : ''
          const ch = idx.chapter >= 0 ? row[idx.chapter].trim() : ''
          const trigger = idx.trigger >= 0 ? row[idx.trigger].trim() : ''
          const key = `${charId(a)}__${charId(b)}`
          if (seen.has(key)) return
          const desc = [before && after ? `${before}→${after}` : after, ch && `（${ch}）`, trigger]
            .filter(Boolean)
            .join(' ')
          seen.set(key, {
            id: `rel-fb-${i + 1}`,
            characterAId: charId(a),
            characterBId: charId(b),
            relationType: after || before || '关系',
            description: desc || undefined,
            sources: [{ path: '设定/关系.md', mtime: now }],
            createdAt: now,
            updatedAt: now
          })
        })
      }
    }

    return Array.from(seen.values())
  }

  async create(input: CreateRelationshipInput): Promise<Relationship> {
    const aName = input.characterAName ?? (await this.nameFromId(input.characterAId))
    const bName = input.characterBName ?? (await this.nameFromId(input.characterBId))
    if (!aName || !bName) {
      throw new Error('RelationshipRepo.create 需要 characterAName + characterBName（或对应的 id 能反查到角色名）')
    }
    const aId = input.characterAId || charId(aName)
    const bId = input.characterBId || charId(bName)
    const dir = join(this.projectDir, '记忆', '关系')
    await fs.mkdir(dir, { recursive: true })
    const now = new Date().toISOString()
    const fileName = `${sanitizeForFileName(aName)}__${sanitizeForFileName(bName)}.md`
    const body = this.serializeForCreate(aName, bName, input)
    await writeTextAtomic(join(dir, fileName), body)
    return {
      id: `rel-${hashName(aName + bName)}`,
      characterAId: aId,
      characterBId: bId,
      relationType: input.relationType,
      description: input.description,
      strength: input.strength,
      sources: [{ path: `记忆/关系/${fileName}`, mtime: now }],
      createdAt: now,
      updatedAt: now
    }
  }

  async update(id: string, patch: UpdateRelationshipInput): Promise<Relationship | null> {
    const all = await this.list()
    const existing = all.find((r) => r.id === id)
    if (!existing) return null
    const merged: Relationship = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    const dir = join(this.projectDir, '记忆', '关系')
    // 回写主源文件（按 A/B id 反查文件名）
    const target = await this.findFileByPair(dir, existing.characterAId, existing.characterBId)
    if (target) {
      // 优先 H1 显示名（与 create 一致），避免对已 sanitize 文件名段做回写
      const existingText = await readText(join(dir, target))
      const names = existingText ? this.pairNamesFromFile(target, existingText) : null
      const aName = names?.a ?? existing.characterAId
      const bName = names?.b ?? existing.characterBId
      const body = this.serializeForCreate(aName, bName, {
        relationType: merged.relationType,
        description: merged.description,
        strength: merged.strength
      })
      await writeTextAtomic(join(dir, target), body)
    }
    return merged
  }

  async delete(id: string): Promise<void> {
    const all = await this.list()
    const target = all.find((r) => r.id === id)
    if (!target) return
    const dir = join(this.projectDir, '记忆', '关系')
    const fileName = await this.findFileByPair(dir, target.characterAId, target.characterBId)
    if (fileName) {
      try { await fs.unlink(join(dir, fileName)) } catch { /* ignore */ }
    }
  }

  // ===== helpers =====

  /**
   * 按 A/B 的 charId 反查主源文件名。
   * 优先用 H1「A ↔ B」显示名算 charId（与 create 返回的 id 一致）；
   * 文件名经 sanitize 后可能与显示名不同，不能直接对文件名段做 charId。
   */
  private async findFileByPair(
    dir: string,
    aId: string,
    bId: string
  ): Promise<string | null> {
    let files: string[] = []
    try {
      files = await fs.readdir(dir)
    } catch {
      return null
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const text = await readText(join(dir, f))
      if (!text) continue
      const names = this.pairNamesFromFile(f, text)
      if (!names) continue
      if (charId(names.a) === aId && charId(names.b) === bId) return f
    }
    return null
  }

  /** 从 H1（优先）或文件名解析 A/B 显示名 */
  private pairNamesFromFile(fileName: string, text: string): { a: string; b: string } | null {
    const doc = parseDoc(text)
    const h1 = doc.h1Title.match(/^(.+?)\s*↔\s*(.+)$/)
    if (h1) return { a: h1[1].trim(), b: h1[2].trim() }
    const m = fileName.match(/^(.+)__(.+)\.md$/)
    if (!m) return null
    return { a: m[1], b: m[2] }
  }

  private parseMainFile(fileName: string, text: string, now: string): Relationship | null {
    const names = this.pairNamesFromFile(fileName, text)
    if (!names) return null
    const a = names.a
    const b = names.b

    const doc = parseDoc(text)
    // 既查 H2 节体，也查顶层 body（顶层表的情况）
    const allBody = [doc.body, ...doc.sections.map((s) => s.body)].join('\n')

    let relationType = ''
    let description = ''
    let chapter = ''
    let trigger = ''
    const lines = allBody.split(/\r?\n/)
    for (const line of lines) {
      const m1 = line.match(/^\|\s*当前关系\s*\|\s*(.+?)\s*\|/)
      if (m1) relationType = m1[1]
      const m2 = line.match(/^\|\s*变更轨迹\s*\|\s*(.+?)\s*\|/)
      if (m2 && !description) description = m2[1]
      const m3 = line.match(/^\|\s*章节\s*\|\s*(.+?)\s*\|/)
      if (m3) chapter = m3[1]
      const m4 = line.match(/^\|\s*触发事件\s*\|\s*(.+?)\s*\|/)
      if (m4) trigger = m4[1]
    }
    // description 包含 当前关系 + 章节 + 触发（主源 fixture 期望）
    const parts = [relationType, chapter && `（${chapter}）`, trigger].filter(Boolean)
    if (!description) description = parts.join(' ')

    return {
      id: `rel-${hashName(a + b)}`,
      characterAId: charId(a),
      characterBId: charId(b),
      relationType: relationType || '关系',
      description: description || undefined,
      sources: [{ path: `记忆/关系/${fileName}`, mtime: now }],
      createdAt: now,
      updatedAt: now
    }
  }

  private serializeForCreate(a: string, b: string, input: CreateRelationshipInput): string {
    const lines: string[] = [`# ${a} ↔ ${b}`, '']
    lines.push('| 项目 | 内容 |', '|------|------|')
    if (input.relationType) lines.push(`| 当前关系 | ${input.relationType} |`)
    if (input.description) lines.push(`| 变更轨迹 | ${input.description} |`)
    if (input.strength != null) lines.push(`| 强度 | ${input.strength} |`)
    lines.push('')
    return lines.join('\n')
  }

  /**
   * id -> 角色名反查：若构造时注入了 nameResolver（CharacterRepo），
   * 则枚举角色列表找到 id 匹配的 name；否则返回 undefined。
   */
  private async nameFromId(id: string | undefined): Promise<string | undefined> {
    if (!id || !this.nameResolver) return undefined
    try {
      const chars = await this.nameResolver.list()
      return chars.find((c) => c.id === id)?.name
    } catch {
      return undefined
    }
  }
}