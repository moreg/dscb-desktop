import { promises as fs } from 'fs'
import { join, relative, resolve, sep } from 'path'
import {
  readText,
  parseDoc,
  parseTable,
  parseBoldFields,
  stripNumberPrefix,
  fieldToStr
} from '../skill-format/md-parser'
import { writeTextAtomic } from '../atomic'
import { listMdFilesDeep, safeFileName, charId } from './entity-helpers'
import { parseTimelineTable, indexTimelineColumns } from './timeline-repo'

export interface SyncReport {
  added: number
  updated: number
  removed: number
  conflicts: number
  errors: Array<{ source: string; message: string }>
  startedAt: string
  finishedAt: string
}

interface SyncIndexEntry {
  sourceMtime: number
  targetMtime: number
  /** 源文件相对项目根的路径（如 '设定/角色/苏铭.md'），用于检测源是否已被删除。 */
  sourceRel: string
}

interface SyncIndex {
  [targetPath: string]: SyncIndexEntry
}

const SYNC_META_FILE = '记忆/.sync-index.json'

/**
 * 路径遍历防御：确保目标绝对路径落在 `记忆/` 子树内。
 * 若 safeFileName 未能完全剥离 `..`（如某些边界输入），
 * 此检查作为第二道防线，阻止写/删操作逃逸出 记忆/ 目录。
 */
function assertWithinMemory(absTgt: string, projectDir: string): void {
  const memoryRoot = resolve(projectDir, '记忆')
  const rel = relative(memoryRoot, absTgt)
  if (rel.startsWith('..') || resolve(absTgt) === memoryRoot) {
    throw new Error(`路径遍历被拦截：目标 ${absTgt} 逃逸出 记忆/ 目录`)
  }
}

/** 原子写入 + 路径校验：先校验落在 记忆/ 内，再用 writeTextAtomic 落盘（防半截文件）。 */
async function safeWrite(absTgt: string, content: string, projectDir: string): Promise<void> {
  assertWithinMemory(absTgt, projectDir)
  await writeTextAtomic(absTgt, content)
}

/** 删除 + 路径校验：先校验落在 记忆/ 内，再 unlink。 */
async function safeUnlink(absTgt: string, projectDir: string): Promise<void> {
  assertWithinMemory(absTgt, projectDir)
  await fs.unlink(absTgt)
}

/**
 * MemorySyncService — 把 设定/ + 追踪/ + 细纲/ 增量同步到 记忆/。
 *
 * 同步规则（每类一行）：
 * - 设定/角色/<name>.md → 记忆/人物/<name>.md
 * - 设定/世界观/地理.md（H2 节） → 记忆/地点/<name>.md
 * - 设定/世界观/*.md（除 地理.md） → 记忆/世界观/<name>.md
 * - 细纲/细纲_第NNN章_*.md → 记忆/剧情点/第NNN章 <title>.md
 * - 追踪/时间线.md（对照表） → 记忆/时间线/<event>.md
 * - 设定/关系.md（关系变更日志） → 记忆/关系/<A>__<B>.md
 * - 追踪/伏笔.md（大表） → 记忆/伏笔/<FB-NNN>.md
 *
 * 增量策略：用 .sync-index.json 记录每个目标文件的源 mtime。
 * 源未变 → skip；源变化 → 重新写目标。
 */
export class MemorySyncService {
  constructor(private readonly projectDir: string) {}

  async syncAll(): Promise<SyncReport> {
    const startedAt = new Date().toISOString()
    const report: SyncReport = {
      added: 0,
      updated: 0,
      removed: 0,
      conflicts: 0,
      errors: [],
      startedAt,
      finishedAt: ''
    }

    const index = await this.loadIndex()

    // 7 个 sync 之间无数据依赖（各自读写不同的 记忆/<sub>/ 目录），并发执行
    const syncFns = [
      () => this.syncCharacters(report, index),
      () => this.syncLocations(report, index),
      () => this.syncWorldview(report, index),
      () => this.syncPlotPoints(report, index),
      () => this.syncTimeline(report, index),
      () => this.syncRelationships(report, index),
      () => this.syncForeshadowings(report, index)
    ]
    const results = await Promise.allSettled(syncFns.map((fn) => fn()))
    // 收集 rejected 的原因到 errors（单个 sync 失败不影响其他类型）
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason)
        report.errors.push({ source: `sync#${i}`, message })
      }
    }

    try {
      await this.writeMemoryIndex(report)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report.errors.push({ source: 'writeMemoryIndex', message })
    }

    await this.saveIndex(index)
    report.finishedAt = new Date().toISOString()
    return report
  }

  // ===== 各类型同步 =====

  private async syncCharacters(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcDir = join(this.projectDir, '设定', '角色')
    const tgtDir = join(this.projectDir, '记忆', '人物')
    await fs.mkdir(tgtDir, { recursive: true })

    const sources = await this.listMdSafe(srcDir)
    const seen = new Set<string>()

    for (const src of sources) {
      const name = src.replace(/\.md$/, '')
      const tgtRel = `人物/${name}.md`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const srcAbs = join(srcDir, src)
      const srcStat = await fs.stat(srcAbs)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(tgtRel)

      const needWrite =
        !prev ||
        prev.sourceMtime !== srcStat.mtimeMs ||
        !(await this.exists(tgtAbs))

      if (needWrite) {
        const text = await readText(srcAbs)
        if (!text) continue
        // 复制源文件到目标，作为派生视图（用户可在 app 里编辑，会覆盖源）
        const srcRel = srcRelPath('设定/角色', src)
        await safeWrite(tgtAbs, this.injectSyncHeader(text, srcRel), this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }

    // 清理：索引里有但本轮源文件已不存在的派生目标
    await this.pruneStale(report, index, tgtDir, '人物', seen)
  }

  private async syncLocations(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcAbs = join(this.projectDir, '设定', '世界观', '地理.md')
    const text = await readText(srcAbs)
    const tgtDir = join(this.projectDir, '记忆', '地点')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()
    const srcRel = '设定/世界观/地理.md'
    if (!text) {
      // 源文件不存在：清理所有派生地点后直接返回
      await this.pruneStale(report, index, tgtDir, '地点', seen)
      return
    }

    const srcStat = await fs.stat(srcAbs)
    const doc = parseDoc(text)

    for (const sec of doc.sections) {
      const raw = stripNumberPrefix(sec.title)
      if (!raw) continue
      const name = safeFileName(raw)
      const tgtRel = `地点/${name}.md`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const { fields, order } = parseBoldFields(sec.body)
        const body = this.serializeLocation(name, fields, order, sec.body.trim())
        await safeWrite(tgtAbs, body, this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '地点', seen)
  }

  private async syncWorldview(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcDir = join(this.projectDir, '设定', '世界观')
    const tgtDir = join(this.projectDir, '记忆', '世界观')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()

    const sources = await this.listMdSafe(srcDir)
    for (const src of sources) {
      if (src === '地理.md') continue
      const name = src.replace(/\.md$/, '')
      const tgtRel = `世界观/${name}.md`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const srcAbs = join(srcDir, src)
      const srcStat = await fs.stat(srcAbs)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const text = await readText(srcAbs)
        if (!text) continue
        const srcRel = srcRelPath('设定/世界观', src)
        await safeWrite(tgtAbs, this.injectSyncHeader(text, srcRel), this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '世界观', seen)
  }

  private async syncPlotPoints(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcDir = join(this.projectDir, '细纲')
    const tgtDir = join(this.projectDir, '记忆', '剧情点')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()

    const sources = await this.listMdSafe(srcDir)
    for (const src of sources) {
      const m = src.match(/^细纲_第(\d+)章_(.+)\.md$/)
      if (!m) continue
      const num = parseInt(m[1], 10)
      const title = m[2]
      const fileName = `第${String(num).padStart(3, '0')}章 ${title}.md`
      const tgtRel = `剧情点/${fileName}`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const srcAbs = join(srcDir, src)
      const srcStat = await fs.stat(srcAbs)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const text = await readText(srcAbs)
        if (!text) continue
        const srcRel = srcRelPath('细纲', src)
        const body = this.injectSyncHeader(text, srcRel)
        await safeWrite(tgtAbs, body, this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '剧情点', seen)
  }

  private async syncTimeline(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcAbs = join(this.projectDir, '追踪', '时间线.md')
    const text = await readText(srcAbs)
    const tgtDir = join(this.projectDir, '记忆', '时间线')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()
    const srcRel = '追踪/时间线.md'
    if (!text) {
      await this.pruneStale(report, index, tgtDir, '时间线', seen)
      return
    }

    const srcStat = await fs.stat(srcAbs)
    const { headers, rows } = parseTimelineTable(text)
    if (headers.length < 3) {
      await this.pruneStale(report, index, tgtDir, '时间线', seen)
      return
    }

    const { idxTime, idxHistory, idxEvent, idxChapter, idxVolume } = indexTimelineColumns(headers)

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const event = idxEvent >= 0 ? row[idxEvent]?.trim() : ''
      if (!event) continue
      const fileName = safeFileName(event) + '.md'
      const tgtRel = `时间线/${fileName}`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const lines = [
          `# ${event}`,
          '',
          '## 描述',
          '',
          idxHistory >= 0 ? row[idxHistory]?.trim() ?? '' : '',
          '',
          '## 来源字段',
          '',
          ...(idxTime >= 0 ? [`- **时间**：${row[idxTime]?.trim() ?? ''}`] : []),
          ...(idxChapter >= 0 ? [`- **对应章节**：${row[idxChapter]?.trim() ?? ''}`] : []),
          ...(idxVolume >= 0 ? [`- **对应卷**：${row[idxVolume]?.trim() ?? ''}`] : []),
          '',
          `<!-- synced from 追踪/时间线.md row ${i + 1} -->`,
          ''
        ]
        await safeWrite(tgtAbs, lines.join('\n'), this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '时间线', seen)
  }

  private async syncRelationships(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcAbs = join(this.projectDir, '设定', '关系.md')
    const text = await readText(srcAbs)
    const tgtDir = join(this.projectDir, '记忆', '关系')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()
    const srcRel = '设定/关系.md'
    if (!text) {
      await this.pruneStale(report, index, tgtDir, '关系', seen)
      return
    }

    const srcStat = await fs.stat(srcAbs)
    const doc = parseDoc(text)
    const sec = doc.sections.find((s) => s.title.includes('关系变更日志'))
    const body = sec?.body ?? text
    const { headers, rows } = parseTable(body)
    if (headers.length < 5) {
      await this.pruneStale(report, index, tgtDir, '关系', seen)
      return
    }

    const idx = {
      chapter: headers.findIndex((h) => h.includes('章节')),
      a: headers.findIndex((h) => h.includes('角色A') || h === '角色A'),
      b: headers.findIndex((h) => h.includes('角色B') || h === '角色B'),
      before: headers.findIndex((h) => h.includes('变更前')),
      after: headers.findIndex((h) => h.includes('变更后')),
      trigger: headers.findIndex((h) => h.includes('触发'))
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const a = idx.a >= 0 ? row[idx.a]?.trim() : ''
      const b = idx.b >= 0 ? row[idx.b]?.trim() : ''
      if (!a || !b) continue
      const fileName = `${a}__${b}.md`
      const tgtRel = `关系/${fileName}`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const after = idx.after >= 0 ? row[idx.after]?.trim() : ''
        const before = idx.before >= 0 ? row[idx.before]?.trim() : ''
        const ch = idx.chapter >= 0 ? row[idx.chapter]?.trim() : ''
        const trigger = idx.trigger >= 0 ? row[idx.trigger]?.trim() : ''
        const lines = [
          `# ${a} ↔ ${b}`,
          '',
          '| 项目 | 内容 |',
          '|------|------|',
          `| 当前关系 | ${after} |`,
          before && after ? `| 变更轨迹 | ${before} -> ${after} |` : null,
          ch ? `| 章节 | ${ch} |` : null,
          trigger ? `| 触发事件 | ${trigger} |` : null,
          '',
          `<!-- synced from 设定/关系.md row ${i + 1} -->`,
          ''
        ].filter((l): l is string => l !== null)
        await safeWrite(tgtAbs, lines.join('\n'), this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '关系', seen)
  }

  private async syncForeshadowings(report: SyncReport, index: SyncIndex): Promise<void> {
    const srcAbs = join(this.projectDir, '追踪', '伏笔.md')
    const text = await readText(srcAbs)
    const tgtDir = join(this.projectDir, '记忆', '伏笔')
    await fs.mkdir(tgtDir, { recursive: true })
    const seen = new Set<string>()
    const srcRel = '追踪/伏笔.md'
    if (!text) {
      await this.pruneStale(report, index, tgtDir, '伏笔', seen)
      return
    }

    const srcStat = await fs.stat(srcAbs)
    const { headers, rows } = parseTable(text)
    if (headers.length < 2) {
      await this.pruneStale(report, index, tgtDir, '伏笔', seen)
      return
    }
    const idxId = headers.findIndex((h) => h.includes('编号'))
    const idxContent = headers.findIndex((h) => h.includes('内容'))
    const idxStatus = headers.findIndex((h) => h.includes('状态'))
    if (idxId < 0 || idxContent < 0) {
      await this.pruneStale(report, index, tgtDir, '伏笔', seen)
      return
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const id = row[idxId]?.trim() ?? ''
      const content = row[idxContent]?.trim() ?? ''
      const status = idxStatus >= 0 ? row[idxStatus]?.trim() ?? '' : ''
      if (!id || !content) continue
      const fileName = `${id}.md`
      const tgtRel = `伏笔/${fileName}`
      const tgtAbs = join(this.projectDir, '记忆', tgtRel)
      const key = this.indexKey(tgtRel)
      const prev = index[key]

      seen.add(key)
      const needWrite = !prev || prev.sourceMtime !== srcStat.mtimeMs || !(await this.exists(tgtAbs))
      if (needWrite) {
        const lines = [
          `# ${id}`,
          '',
          '## 内容',
          '',
          content,
          '',
          '## 字段',
          '',
          `- **状态**：${status}`,
          '',
          `<!-- synced from 追踪/伏笔.md row ${i + 1} -->`,
          ''
        ]
        await safeWrite(tgtAbs, lines.join('\n'), this.projectDir)
        this.recordSync(index, key, srcStat, srcRel)
        if (prev) report.updated++
        else report.added++
      }
    }
    await this.pruneStale(report, index, tgtDir, '伏笔', seen)
  }

  // ===== 索引文件 =====

  private async writeMemoryIndex(report: SyncReport): Promise<void> {
    const counts = await this.countEntities()
    const lines = [
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
      '## 最近同步',
      '',
      `- ${report.finishedAt || new Date().toISOString()}：新增 ${report.added}，更新 ${report.updated}，删除 ${report.removed}，冲突 ${report.conflicts}`,
      ''
    ]
    await safeWrite(join(this.projectDir, '记忆', '索引.md'), lines.join('\n'), this.projectDir)
  }

  private async countEntities(): Promise<{
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
        const files = await listMdFilesDeep(join(this.projectDir, '记忆', sub))
        return files.length
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

  // ===== helpers =====

  private async listMdSafe(dir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dir)
      return files.filter((f) => f.endsWith('.md')).sort()
    } catch {
      return []
    }
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true } catch { return false }
  }

  private indexKey(tgtRel: string): string {
    return tgtRel.replace(/\\/g, '/')
  }

  /** 记录一次同步写入，统一 index entry 形状（含 sourceRel 供 prune 用）。 */
  private recordSync(
    index: SyncIndex,
    key: string,
    srcStat: { mtimeMs: number },
    sourceRel: string
  ): void {
    index[key] = { sourceMtime: srcStat.mtimeMs, targetMtime: Date.now(), sourceRel }
  }

  /**
   * 清理失效派生目标：遍历索引中前缀为 `<sub>/` 的条目，
   * 若其 target 不在本轮 seen 集合中（说明源文件已删除/改名），则删除目标文件 + 索引条目。
   * 仅清理索引中记录过的派生文件，不碰用户手动创建的文件（未进索引）。
   */
  private async pruneStale(
    report: SyncReport,
    index: SyncIndex,
    _tgtDir: string,
    sub: string,
    seen: Set<string>
  ): Promise<void> {
    const prefix = `${sub}/`
    const toDelete: string[] = []
    for (const key of Object.keys(index)) {
      if (!key.startsWith(prefix)) continue
      if (seen.has(key)) continue
      toDelete.push(key)
    }
    for (const key of toDelete) {
      const tgtAbs = join(this.projectDir, '记忆', key)
      try {
        await safeUnlink(tgtAbs, this.projectDir)
      } catch {
        /* 文件已不存在，忽略 */
      }
      delete index[key]
      report.removed++
    }
  }

  private async loadIndex(): Promise<SyncIndex> {
    try {
      const text = await readText(join(this.projectDir, SYNC_META_FILE))
      if (!text) return {}
      return JSON.parse(text) as SyncIndex
    } catch {
      return {}
    }
  }

  private async saveIndex(index: SyncIndex): Promise<void> {
    await safeWrite(
      join(this.projectDir, SYNC_META_FILE),
      JSON.stringify(index, null, 2),
      this.projectDir
    )
  }

  private injectSyncHeader(text: string, source: string): string {
    if (text.includes('<!-- synced from')) return text
    return text.trimEnd() + `\n\n<!-- synced from ${source} -->\n`
  }

  private serializeLocation(
    name: string,
    fields: Map<string, import('../skill-format/md-parser').FieldValue>,
    order: string[],
    fallbackNotes: string
  ): string {
    const lines: string[] = [`# ${name}`, '']
    const notes = fieldToStr(fields.get('特征描述')) ?? fieldToStr(fields.get('当前状态'))
    if (notes) lines.push('## 描述', '', notes, '')
    else if (fallbackNotes) lines.push('## 描述', '', fallbackNotes, '')
    lines.push('## 字段', '')
    if (fieldToStr(fields.get('类型'))) lines.push(`- **类型**：${fieldToStr(fields.get('类型'))}`)
    const reserved = new Set(['类型', '特征描述', '当前状态'])
    for (const k of order) {
      if (reserved.has(k)) continue
      const v = fields.get(k)
      if (v == null) continue
      if (Array.isArray(v)) {
        lines.push(`- **${k}**：${v[0] ?? ''}`)
        for (const sub of v.slice(1)) lines.push(`  - ${sub}`)
      } else {
        lines.push(`- **${k}**：${v}`)
      }
    }
    lines.push('')
    return lines.join('\n')
  }
}

function srcRelPath(prefix: string, file: string): string {
  return `${prefix}/${file}`
}