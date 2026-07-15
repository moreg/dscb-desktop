import { promises as fs } from 'fs'
import { join } from 'path'
import {
  readText,
  parseDoc,
  parseBoldFields,
  parseSubsections,
  parseChapterNumber,
  parseTable,
  titleAfterColon,
  stripNumberPrefix,
  fieldToStr,
  fieldsToRaw
} from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { safeFileName, sanitizeForFileName } from './entity-helpers'

export interface MigrationOptions {
  dryRun?: boolean
}

export interface MigrationReport {
  dryRun: boolean
  skipped: boolean
  wouldConvert: number
  converted: number
  removedDirs: string[]
  errors: Array<{ file: string; message: string }>
}

/**
 * 把 v3 项目的 `记忆系统/` + `chapters/` + `参考资料/` 转为 v4 的 `记忆/` + `资料/`。
 * - 记忆系统/角色卡.md (H3 角色) → 记忆/人物/<name>.md
 * - 记忆系统/角色卡.md (关系变更日志表) → 记忆/关系/<A>__<B>.md
 * - 记忆系统/地点档案.md (H2) → 记忆/地点/<name>.md
 * - 记忆系统/世界观设定.md (H2) → 记忆/世界观/<name>.md
 * - 记忆系统/核心情节.md (H3 章) → 记忆/剧情点/第NNN章 <title>.md
 * - 记忆系统/伏笔追踪.md + 追踪/伏笔.md 合并 → 追踪/伏笔.md（追踪版优先，按 FB-NNN 去重）
 * - 记忆系统/伏笔追踪.md → 记忆/伏笔/FB-NNN.md（每条详情）
 * - 生成 记忆/索引.md
 * - 重命名 参考资料/ → 资料/
 * - 删除 chapters/、记忆系统/
 */
export async function migrateProjectV3ToV4(
  projectDir: string,
  options: MigrationOptions = {}
): Promise<MigrationReport> {
  const dryRun = options.dryRun ?? false
  const report: MigrationReport = {
    dryRun,
    skipped: false,
    wouldConvert: 0,
    converted: 0,
    removedDirs: [],
    errors: []
  }

  // 已经是 v4 项目（无 记忆系统/）→ 跳过
  const legacyDir = join(projectDir, '记忆系统')
  let hasLegacy = true
  try {
    await fs.access(legacyDir)
  } catch {
    hasLegacy = false
  }
  if (!hasLegacy) {
    report.skipped = true
    return report
  }

  // 1. 收集所有需要转换的内容（dryRun 模式只统计）
  const tasks = await collectTasks(projectDir)

  if (dryRun) {
    report.wouldConvert = tasks.length
    return report
  }

  // 2. 创建 记忆/ 子目录
  await fs.mkdir(join(projectDir, '记忆', '人物'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '地点'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '世界观'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '时间线'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '剧情点'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '关系'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '伏笔'), { recursive: true })
  await fs.mkdir(join(projectDir, '记忆', '道具'), { recursive: true })

  // 3. 执行每个 task
  for (const task of tasks) {
    try {
      await task.run()
      report.converted++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report.errors.push({ file: task.label, message })
    }
  }

  // 4. 伏笔合并：记忆系统/伏笔追踪.md → 追踪/伏笔.md（追踪版优先）
  await mergeForeshadowing(projectDir)

  // 5. 生成 记忆/索引.md
  await writeMemoryIndex(projectDir)

  // 6. 重命名 参考资料/ → 资料/
  await renameRefs(projectDir)

  // 7. 删除 chapters/ 和 记忆系统/
  await safeRemoveDir(projectDir, 'chapters', report)
  await safeRemoveDir(projectDir, '记忆系统', report)

  return report
}

interface MigrationTask {
  label: string
  run: () => Promise<void>
}

async function collectTasks(projectDir: string): Promise<MigrationTask[]> {
  const tasks: MigrationTask[] = []

  // 角色卡 → 人物 + 关系
  const charCard = await readText(join(projectDir, '记忆系统', '角色卡.md'))
  if (charCard) {
    const chars = parseCharacterCard(charCard)
    for (const c of chars) {
      const safe = sanitizeForFileName(c.name)
      tasks.push({
        label: `记忆系统/角色卡.md → 记忆/人物/${safe}.md`,
        run: async () => {
          const dir = join(projectDir, '记忆', '人物')
          await fs.mkdir(dir, { recursive: true })
          const body = serializeEntityDoc(c.name, c.fields, c.notes)
          await writeTextAtomic(join(dir, `${safe}.md`), body)
        }
      })
    }
    const rels = parseRelationshipsFromCard(charCard)
    for (const r of rels) {
      tasks.push({
        label: `记忆系统/角色卡.md[关系变更日志] → 记忆/关系/${r.fileName}`,
        run: async () => {
          const dir = join(projectDir, '记忆', '关系')
          await fs.mkdir(dir, { recursive: true })
          const body = serializeRelationshipDoc(r)
          await writeTextAtomic(join(dir, r.fileName), body)
        }
      })
    }
  }

  // 地点档案
  const locDoc = await readText(join(projectDir, '记忆系统', '地点档案.md'))
  if (locDoc) {
    const locs = parseLocationDoc(locDoc)
    for (const loc of locs) {
      const safe = sanitizeForFileName(loc.name)
      tasks.push({
        label: `记忆系统/地点档案.md → 记忆/地点/${safe}.md`,
        run: async () => {
          const dir = join(projectDir, '记忆', '地点')
          await fs.mkdir(dir, { recursive: true })
          const body = serializeEntityDoc(loc.name, loc.fields, loc.notes)
          await writeTextAtomic(join(dir, `${safe}.md`), body)
        }
      })
    }
  }

  // 世界观
  const wvDoc = await readText(join(projectDir, '记忆系统', '世界观设定.md'))
  if (wvDoc) {
    const wvs = parseWorldviewDoc(wvDoc)
    for (const w of wvs) {
      const { dir: subDir, fileName } = splitDirAndName(w.name)
      const fullDir = join(projectDir, '记忆', '世界观', subDir)
      tasks.push({
        label: `记忆系统/世界观设定.md → 记忆/世界观/${subDir ? subDir + '/' : ''}${fileName}`,
        run: async () => {
          await fs.mkdir(fullDir, { recursive: true })
          const body = serializeEntityDoc(w.name, {}, w.notes)
          await writeTextAtomic(join(fullDir, fileName), body)
        }
      })
    }
  }

  // 核心情节 → 剧情点
  const cpDoc = await readText(join(projectDir, '记忆系统', '核心情节.md'))
  if (cpDoc) {
    const plots = parseCorePlotDoc(cpDoc)
    for (const p of plots) {
      tasks.push({
        label: `记忆系统/核心情节.md → 记忆/剧情点/${p.fileName}`,
        run: async () => {
          const dir = join(projectDir, '记忆', '剧情点')
          await fs.mkdir(dir, { recursive: true })
          const body = serializeEntityDoc(p.name, p.fields, p.notes)
          await writeTextAtomic(join(dir, p.fileName), body)
        }
      })
    }
  }

  // 伏笔详情（从 记忆系统/伏笔追踪.md）
  const fDoc = await readText(join(projectDir, '记忆系统', '伏笔追踪.md'))
  if (fDoc) {
    const fs2 = parseForeshadowingDoc(fDoc)
    for (const f of fs2) {
      tasks.push({
        label: `记忆系统/伏笔追踪.md → 记忆/伏笔/${f.id}.md`,
        run: async () => {
          const dir = join(projectDir, '记忆', '伏笔')
          await fs.mkdir(dir, { recursive: true })
          const body = serializeEntityDoc(f.id, {}, f.content)
          await writeTextAtomic(join(dir, `${f.id}.md`), body)
        }
      })
    }
  }

  return tasks
}

// ========== 解析器 ==========

interface ParsedEntity {
  name: string
  notes?: string
  fields: Record<string, string | string[]>
}

interface ParsedCharacter extends ParsedEntity {
  role?: string
}

function parseCharacterCard(text: string): ParsedCharacter[] {
  const doc = parseDoc(text)
  const out: ParsedCharacter[] = []
  for (const section of doc.sections) {
    const category = section.title.trim()
    if (!['主角', '核心配角', '核心反派'].includes(category)) continue
    for (const sub of parseSubsections(section.body)) {
      const paren = sub.title.match(/^(.+?)（(.+?)）/)
      const name = paren ? paren[1].trim() : sub.title.trim()
      if (!name) continue
      const { fields, order } = parseBoldFields(sub.body)
      out.push({
        name,
        role: paren ? `${category}·${paren[2].trim()}` : category,
        fields: fieldsToRaw(fields, order),
        notes: undefined
      })
    }
  }
  return out
}

function parseRelationshipsFromCard(text: string): Array<{
  fileName: string
  a: string
  b: string
  before?: string
  after?: string
  chapter?: string
  trigger?: string
}> {
  const doc = parseDoc(text)
  const sec = doc.sections.find((s) => s.title.includes('关系变更日志'))
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
  const out: Array<{
    fileName: string
    a: string
    b: string
    before?: string
    after?: string
    chapter?: string
    trigger?: string
  }> = []
  for (const row of rows) {
    const a = idx.a >= 0 ? row[idx.a].trim() : ''
    const b = idx.b >= 0 ? row[idx.b].trim() : ''
    if (!a || !b) continue
    const fileName = `${sanitizeForFileName(a)}__${sanitizeForFileName(b)}.md`
    out.push({
      fileName,
      a,
      b,
      before: idx.before >= 0 ? row[idx.before].trim() : undefined,
      after: idx.after >= 0 ? row[idx.after].trim() : undefined,
      chapter: idx.chapter >= 0 ? row[idx.chapter].trim() : undefined,
      trigger: idx.trigger >= 0 ? row[idx.trigger].trim() : undefined
    })
  }
  return out
}

/**
 * 把含 `/` 的标题拆成目录前缀 + 文件名（如「力量/境界体系」->「力量/境界体系.md」）。
 * 用于支持嵌套分类（如世界观下分力量体系/境界子节）。
 */
export function splitDirAndName(raw: string): { dir: string; fileName: string } {
  const cleaned = safeFileName(raw)
  if (!cleaned.includes('/')) {
    return { dir: '', fileName: `${cleaned}.md` }
  }
  const parts = cleaned.split('/').filter(Boolean)
  const fileName = `${parts.pop()}.md`
  const dir = parts.join('/')
  return { dir, fileName }
}

function parseLocationDoc(text: string): ParsedEntity[] {
  const doc = parseDoc(text)
  const out: ParsedEntity[] = []
  for (const section of doc.sections) {
    const rawName = stripNumberPrefix(section.title)
    if (!rawName) continue
    const name = safeFileName(rawName)
    const { fields, order } = parseBoldFields(section.body)
    out.push({
      name,
      fields: fieldsToRaw(fields, order),
      notes: fieldToStr(fields.get('特征描述')) ?? fieldToStr(fields.get('当前状态'))
    })
  }
  return out
}

function parseWorldviewDoc(text: string): ParsedEntity[] {
  const doc = parseDoc(text)
  const out: ParsedEntity[] = []
  for (const section of doc.sections) {
    const name = section.title.trim()
    if (!name) continue
    out.push({ name, notes: section.body.trim(), fields: {} })
  }
  return out
}

function parseCorePlotDoc(text: string): Array<ParsedEntity & { fileName: string }> {
  const doc = parseDoc(text)
  const out: Array<ParsedEntity & { fileName: string }> = []
  for (const volume of doc.sections) {
    for (const ch of parseSubsections(volume.body)) {
      const chapterNumber = parseChapterNumber(ch.title)
      if (chapterNumber == null) continue
      const title = titleAfterColon(ch.title) || ch.title.trim()
      const fileName = `第${String(chapterNumber).padStart(3, '0')}章 ${sanitizeForFileName(title)}.md`
      const { fields, order } = parseBoldFields(ch.body)
      out.push({
        name: `第${chapterNumber}章 ${title}`,
        fileName,
        fields: fieldsToRaw(fields, order),
        notes: fieldToStr(fields.get('核心事件')) ?? fieldToStr(fields.get('爽点/打脸'))
      })
    }
  }
  return out
}

function parseForeshadowingDoc(text: string): Array<{ id: string; content: string }> {
  const { headers, rows } = parseTable(text)
  if (headers.length < 2) return []
  const idxId = headers.findIndex((h) => h.includes('编号'))
  const idxContent = headers.findIndex((h) => h.includes('内容'))
  if (idxId < 0 || idxContent < 0) return []
  const out: Array<{ id: string; content: string }> = []
  for (const row of rows) {
    const id = row[idxId]?.trim() ?? ''
    const content = row[idxContent]?.trim() ?? ''
    if (!id || !content) continue
    out.push({ id, content })
  }
  return out
}

// ========== 序列化器 ==========

function serializeEntityDoc(
  name: string,
  fields: Record<string, string | string[]>,
  notes?: string
): string {
  const lines: string[] = []
  lines.push(`# ${name}`, '')
  if (notes) {
    lines.push('## 描述', '', notes, '')
  }
  const keys = Object.keys(fields)
  if (keys.length > 0) {
    lines.push('## 字段', '')
    for (const k of keys) {
      const v = fields[k]
      if (Array.isArray(v)) {
        lines.push(`- **${k}**：${v[0] ?? ''}`)
        for (const sub of v.slice(1)) lines.push(`  - ${sub}`)
      } else {
        lines.push(`- **${k}**：${v}`)
      }
    }
    lines.push('')
  }
  // 标记为 v4 迁移产物
  lines.push('<!-- migrated-from: 记忆系统/, generated by migrate-v3-to-v4 -->', '')
  return lines.join('\n')
}

function serializeRelationshipDoc(r: {
  a: string
  b: string
  before?: string
  after?: string
  chapter?: string
  trigger?: string
}): string {
  const lines: string[] = []
  lines.push(`# ${r.a} ↔ ${r.b}`, '')
  const tableRows: Array<[string, string]> = []
  if (r.after) tableRows.push(['当前关系', r.after])
  if (r.before && r.after) tableRows.push(['变更轨迹', `${r.before} → ${r.after}`])
  if (r.chapter) tableRows.push(['章节', r.chapter])
  if (r.trigger) tableRows.push(['触发事件', r.trigger])
  if (tableRows.length > 0) {
    lines.push('| 项目 | 内容 |', '|------|------|')
    for (const [k, v] of tableRows) lines.push(`| ${k} | ${v} |`)
    lines.push('')
  }
  lines.push('<!-- migrated-from: 记忆系统/角色卡.md[关系变更日志] -->', '')
  return lines.join('\n')
}

// ========== 伏笔合并 ==========

async function mergeForeshadowing(projectDir: string): Promise<void> {
  const legacyText = await readText(join(projectDir, '记忆系统', '伏笔追踪.md'))
  const trackingText = await readText(join(projectDir, '追踪', '伏笔.md'))

  const legacyRows = legacyText ? parseTable(legacyText).rows : []
  const trackingRows = trackingText ? parseTable(trackingText).rows : []

  if (legacyRows.length === 0 && trackingRows.length === 0) return

  // 合并：trackingRows 优先（同 ID 覆盖）
  const byId = new Map<string, string[]>()
  const header = legacyText
    ? parseTable(legacyText).headers
    : parseTable(trackingText).headers

  for (const row of legacyRows) byId.set(row[0], row)
  for (const row of trackingRows) byId.set(row[0], row)

  const mergedRows = Array.from(byId.values()).sort((a, b) => a[0].localeCompare(b[0]))

  const lines: string[] = ['# 伏笔追踪', '']
  lines.push('| ' + header.join(' | ') + ' |')
  lines.push('|' + header.map(() => '------').join('|') + '|')
  for (const row of mergedRows) lines.push('| ' + row.join(' | ') + ' |')
  lines.push('')
  lines.push('<!-- merged from 记忆系统/伏笔追踪.md (legacy) + 追踪/伏笔.md (tracking); tracking version wins on conflict -->', '')
  await writeTextAtomic(join(projectDir, '追踪', '伏笔.md'), lines.join('\n'))
}

// ========== 索引生成 ==========

async function writeMemoryIndex(projectDir: string): Promise<void> {
  const counts = await countMemoryEntities(projectDir)
  const lines: string[] = [
    '# 记忆索引',
    '',
    '> 此目录由 app 自动维护，来源于 设定/、追踪/、细纲/。',
    '> 建议在 app「记忆中心」操作；如需手改，编辑后请点 🔄 刷新。',
    '',
    `## 人物（${counts.characters}）`,
    `## 地点（${counts.locations}）`,
    `## 世界观（${counts.worldview}）`,
    `## 时间线（${counts.timeline}）`,
    `## 剧情点（${counts.plotPoints}）`,
    `## 关系（${counts.relationships}）`,
    `## 伏笔（${counts.foreshadowings}）`,
    `## 道具（${counts.items}）`,
    '',
    '## 最近更新',
    '',
    '- （暂无）',
    ''
  ]
  await writeTextAtomic(join(projectDir, '记忆', '索引.md'), lines.join('\n'))
}

async function countMemoryEntities(projectDir: string): Promise<{
  characters: number
  locations: number
  worldview: number
  timeline: number
  plotPoints: number
  relationships: number
  foreshadowings: number
  items: number
}> {
  const cnt = async (sub: string) => {
    try {
      const files = await fs.readdir(join(projectDir, '记忆', sub))
      return files.filter((f) => f.endsWith('.md')).length
    } catch {
      return 0
    }
  }
  return {
    characters: await cnt('人物'),
    locations: await cnt('地点'),
    worldview: await cnt('世界观'),
    timeline: await cnt('时间线'),
    plotPoints: await cnt('剧情点'),
    relationships: await cnt('关系'),
    foreshadowings: await cnt('伏笔'),
    items: await cnt('道具')
  }
}

// ========== 辅助 ==========

async function renameRefs(projectDir: string): Promise<void> {
  const oldDir = join(projectDir, '参考资料')
  const newDir = join(projectDir, '资料')
  // 旧目录不存在，无事可做
  try {
    await fs.access(oldDir)
  } catch {
    return
  }
  // 优先直接重命名（最快、最原子）
  try {
    await fs.rename(oldDir, newDir)
    return
  } catch {
    // 目标已存在或跨盘，降级为复制 + 删除
  }
  await fs.cp(oldDir, newDir, { recursive: true, force: false })
  await fs.rm(oldDir, { recursive: true })
}

async function safeRemoveDir(projectDir: string, name: string, report: MigrationReport): Promise<void> {
  const dir = join(projectDir, name)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    report.removedDirs.push(name)
  } catch {
    // ignore
  }
}