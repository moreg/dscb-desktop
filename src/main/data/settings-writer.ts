import { join, resolve, relative, isAbsolute, dirname } from 'path'
import { promises as fs } from 'fs'
import { writeTextAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { readText } from './skill-format/md-parser'
import { appendH2Section, appendTableRow } from './skill-format/md-writer'
import type {
  SettingsApplyDiffItem,
  SettingsApplyPreview,
  SettingsApplyResult,
  SettingsEvolutionEntry,
  SettingsPatch,
  SettingsSuggestion
} from '../../shared/types'

const MAX_CONTENT_LEN = 800
const BANNED_FILES = new Set(['题材定位', '核心设定'])

/**
 * 设定随书进化写入器（MVP：A 类增量 append）。
 * - 禁止自动改 题材定位 / 核心设定
 * - 补丁落盘 + 追踪/设定演进.md 日志
 */
export class SettingsWriter {
  constructor(private readonly projectDir: string) {}

  preview(
    patches: SettingsPatch[],
    suggestions: SettingsSuggestion[] = []
  ): SettingsApplyPreview {
    const diffs: SettingsApplyDiffItem[] = []
    for (const p of patches) {
      const normalized = normalizePatch(p)
      const ban = isBanned(normalized.fileName)
      const conf = normalized.confidence ?? 'medium'
      const note = ban
        ? '底稿文件禁止自动写入'
        : !normalized.content
          ? '内容为空'
          : undefined
      const autoEligible = !ban && Boolean(normalized.content) && conf === 'high'
      diffs.push({
        target: normalized.target,
        fileName: normalized.fileName,
        op: normalized.op,
        title: normalized.title || normalized.sectionTitle || normalized.fileName,
        content: normalized.content,
        reason: normalized.reason,
        confidence: conf,
        autoEligible,
        note
      })
    }
    return {
      diffs,
      autoCount: diffs.filter((d) => d.autoEligible).length,
      confirmCount: diffs.filter((d) => !d.autoEligible && !d.note).length,
      suggestionCount: suggestions.length
    }
  }

  /**
   * 应用补丁。
   * @param onlyAuto 为 true 时只应用 high 置信且非禁用项
   */
  async applyPatches(
    chapterNumber: number,
    patches: SettingsPatch[],
    opts: { onlyAuto?: boolean } = {}
  ): Promise<SettingsApplyResult> {
    const errors: string[] = []
    let applied = 0
    let skipped = 0
    const appliedDiffs: SettingsApplyDiffItem[] = []
    const preview = this.preview(patches)

    for (let i = 0; i < patches.length; i++) {
      const p = normalizePatch(patches[i])
      const d = preview.diffs[i]
      if (opts.onlyAuto && !d.autoEligible) {
        skipped++
        continue
      }
      if (d.note || !p.content) {
        skipped++
        continue
      }
      try {
        const ok = await this.applyOne(p, chapterNumber)
        if (ok) {
          applied++
          appliedDiffs.push({ ...d, autoEligible: true })
          await this.appendEvolutionLog(chapterNumber, p)
        } else {
          skipped++
        }
      } catch (e) {
        errors.push(`${p.fileName}: ${(e as Error).message}`)
      }
    }

    return { applied, skipped, errors, appliedDiffs }
  }

  /**
   * 撤销已应用设定补丁（best-effort：删正文中的 bullet/内容行，演进日志标「已撤销」）。
   */
  async revertPatches(
    chapterNumber: number,
    diffs: SettingsApplyDiffItem[]
  ): Promise<{ reverted: number; errors: string[] }> {
    const errors: string[] = []
    let reverted = 0
    for (const d of diffs) {
      try {
        const ok = await this.revertOne(d)
        if (ok) {
          reverted++
          await this.markEvolutionReverted(chapterNumber, d)
        }
      } catch (e) {
        errors.push(`${d.fileName}: ${(e as Error).message}`)
      }
    }
    return { reverted, errors }
  }

  /** 读近期设定演进（续写注入） */
  async readRecentEvolution(limit = 5): Promise<SettingsEvolutionEntry[]> {
    const file = join(this.projectDir, '追踪', '设定演进.md')
    const text = await readText(file)
    if (!text) return []
    const entries: SettingsEvolutionEntry[] = []
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('|') || t.includes('---') || t.includes('日期')) continue
      const cells = t
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
      if (cells.length < 5) continue
      if (!cells[0] || cells[0] === '日期') continue
      entries.push({
        date: cells[0],
        chapter: cells[1] ?? '',
        kind: cells[2] ?? '',
        file: cells[3] ?? '',
        summary: cells[4] ?? '',
        status: cells[5] ?? '已应用'
      })
    }
    return entries.slice(-limit)
  }

  private async applyOne(p: SettingsPatch, chapterNumber: number): Promise<boolean> {
    const abs = this.resolvePath(p)
    if (!abs) return false
    await fs.mkdir(dirname(abs), { recursive: true })

    return withFileLock(abs, async () => {
      let text = (await readText(abs)) ?? ''
      if (!text.trim()) {
        text = defaultSkeleton(p)
      }

      // 幂等：内容或地理地点名已存在则跳过
      if (p.content && text.includes(p.content)) {
        return false
      }
      const bulletLine = formatBullet(p.title, p.content).trim()
      if (bulletLine && text.includes(bulletLine)) {
        return false
      }
      if (
        (p.target === 'geography' || p.fileName === '地理') &&
        p.title &&
        tableHasPlace(text, p.title)
      ) {
        return false
      }

      let next = text
      if (p.target === 'geography' || (p.target === 'worldview' && p.fileName === '地理')) {
        const chLabel = `第 ${Math.max(1, chapterNumber || 1)} 章`
        next = appendTableRow(
          text,
          [p.title || p.content.slice(0, 20), p.content, chLabel],
          ['地点', '说明', '出现章节']
        )
      } else if (p.op === 'append_h2') {
        const title = (p.title || p.sectionTitle || '补充设定').trim()
        if (findTitleInText(text, title)) {
          // 已有同名 H2：内容已在上面 includes(content) 判过，仍无则补 bullet
          next = appendBulletToH2(
            text,
            title,
            p.content.startsWith('-') ? p.content : formatBullet(undefined, p.content)
          )
        } else {
          next = appendH2Section(text, title, p.content)
        }
      } else {
        // append_bullet
        const section = (p.sectionTitle || p.title || '').trim()
        if (section && findH2Exists(text, section)) {
          next = appendBulletToH2(text, section, formatBullet(p.title, p.content))
        } else if (section) {
          next = appendH2Section(text, section, formatBullet(p.title, p.content))
        } else {
          next = appendH2Section(
            text,
            p.title || '正文揭晓补充',
            formatBullet(undefined, p.content)
          )
        }
      }

      if (next === text) return false
      await writeTextAtomic(abs, next)
      return true
    })
  }

  private resolvePath(p: SettingsPatch): string | null {
    const safe = sanitizeFileName(p.fileName)
    if (!safe || isBanned(safe)) return null
    const base = join(this.projectDir, '设定')
    let rel: string
    switch (p.target) {
      case 'worldview':
        rel = join('世界观', `${safe}.md`)
        break
      case 'faction':
        rel = join('势力', `${safe}.md`)
        break
      case 'relation':
        rel = '关系.md'
        break
      case 'customRule':
        rel = `${safe}.md`
        break
      case 'geography':
        rel = join('世界观', '地理.md')
        break
      default:
        return null
    }
    const abs = resolve(base, rel)
    const root = resolve(base)
    if (relative(root, abs).startsWith('..') || isAbsolute(relative(root, abs))) {
      return null
    }
    return abs
  }

  private async revertOne(d: SettingsApplyDiffItem): Promise<boolean> {
    const patchLike: SettingsPatch = {
      target: d.target,
      fileName: d.fileName,
      op: d.op === 'append_h2' ? 'append_h2' : 'append_bullet',
      title: d.title,
      content: d.content
    }
    const abs = this.resolvePath(normalizePatch(patchLike))
    if (!abs) return false
    return withFileLock(abs, async () => {
      let text = (await readText(abs)) ?? ''
      if (!text) return false
      const before = text
      const content = (d.content || '').trim()
      if (!content) return false

      // 地理表：删含地点名的行
      if (d.target === 'geography' || d.fileName === '地理') {
        const title = (d.title || '').trim()
        const lines = text.split(/\r?\n/)
        const next = lines.filter((line) => {
          if (!line.trim().startsWith('|') || line.includes('---')) return true
          if (title && (line.includes(`| ${title} |`) || line.includes(`|${title}|`))) {
            return false
          }
          if (!title && content && line.includes(content.slice(0, 40))) return false
          return true
        })
        text = next.join('\n')
      } else {
        const bullet = formatBullet(d.title !== d.fileName ? d.title : undefined, content).trim()
        const lines = text.split(/\r?\n/)
        const next = lines.filter((line) => {
          const t = line.trim()
          if (bullet && (t === bullet || t.includes(bullet))) return false
          if (content.length >= 8 && t.includes(content)) return false
          if (d.title && t === `## ${d.title}`) return false
          return true
        })
        text = next.join('\n')
      }

      if (text === before) return false
      await writeTextAtomic(abs, text)
      return true
    })
  }

  private async markEvolutionReverted(
    chapter: number,
    d: SettingsApplyDiffItem
  ): Promise<void> {
    const file = join(this.projectDir, '追踪', '设定演进.md')
    await withFileLock(file, async () => {
      const text = await readText(file)
      if (!text) return
      const chapterMark = `第 ${chapter} 章`
      const fileHint = `${d.target}/${d.fileName.replace(/\.md$/i, '')}`
      const summaryHint = `${d.title || ''} ${d.content}`.trim().slice(0, 40)
      const lines = text.split(/\r?\n/)
      let changed = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim().startsWith('|') || line.includes('---')) continue
        if (!line.includes(chapterMark)) continue
        if (!line.includes(fileHint) && !line.includes(d.fileName)) continue
        if (summaryHint && !line.includes(summaryHint.slice(0, 20))) continue
        if (line.includes('已撤销')) continue
        lines[i] = line.replace(/\|\s*已应用\s*\|?\s*$/, '| 已撤销 |').replace(
          /\| 已应用 \|/,
          '| 已撤销 |'
        )
        if (lines[i] === line && line.includes('已应用')) {
          lines[i] = line.replace('已应用', '已撤销')
        }
        if (lines[i] !== line) changed = true
      }
      if (changed) await writeTextAtomic(file, lines.join('\n'))
    })
  }

  private async appendEvolutionLog(chapter: number, p: SettingsPatch): Promise<void> {
    const dir = join(this.projectDir, '追踪')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, '设定演进.md')
    await withFileLock(file, async () => {
      let text = (await readText(file)) ?? ''
      if (!text.trim()) {
        text =
          `# 设定演进\n\n| 日期 | 章节 | 类型 | 目标文件 | 摘要 | 状态 |\n|---|---|---|---|---|---|\n`
      }
      const today = new Date().toISOString().slice(0, 10)
      const summary = escapeCell(
        `${p.title || p.sectionTitle || ''} ${p.content}`.trim().slice(0, 80)
      )
      const fileLabel = escapeCell(`${p.target}/${p.fileName}`)
      const row = `| ${today} | 第 ${chapter} 章 | 增量 | ${fileLabel} | ${summary} | 已应用 |`
      // 同章同摘要不重复
      if (text.includes(summary) && text.includes(`第 ${chapter} 章`)) return
      const lines = text.split(/\r?\n/)
      let last = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('|') && !lines[i].includes('---')) last = i
      }
      if (last >= 0) lines.splice(last + 1, 0, row)
      else lines.push(row)
      await writeTextAtomic(file, lines.join('\n'))
    })
  }
}

function normalizePatch(p: SettingsPatch): SettingsPatch {
  const content = String(p.content ?? '')
    .trim()
    .slice(0, MAX_CONTENT_LEN)
  // 去掉 .md / 路径噪音后再判禁写与拼路径
  let fileName = String(p.fileName ?? '')
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '背景设定'
  fileName = sanitizeFileName(fileName) || '背景设定'
  const target = normalizeTarget(p.target)
  if (target === 'geography') fileName = '地理'
  const conf = p.confidence === 'high' || p.confidence === 'low' ? p.confidence : 'medium'
  const op = p.op === 'append_h2' ? 'append_h2' : 'append_bullet'
  return {
    target,
    fileName,
    op,
    sectionTitle: p.sectionTitle?.trim(),
    title: p.title?.trim(),
    content,
    reason: p.reason?.trim().slice(0, 120),
    confidence: conf
  }
}

function normalizeTarget(t: string): SettingsPatch['target'] {
  if (t === 'faction' || t === '势力') return 'faction'
  if (t === 'relation' || t === '关系') return 'relation'
  if (t === 'customRule' || t === '规则') return 'customRule'
  if (t === 'geography' || t === '地理') return 'geography'
  return 'worldview'
}

function isBanned(fileName: string): boolean {
  return BANNED_FILES.has(fileName.trim())
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.\./g, '')
    .trim()
    .slice(0, 80)
}

function defaultSkeleton(p: SettingsPatch): string {
  if (p.target === 'geography') {
    return `# 地理\n\n| 地点 | 说明 | 出现章节 |\n|---|---|---|\n`
  }
  if (p.target === 'relation') {
    return `# 角色关系\n\n`
  }
  if (p.target === 'faction') {
    return `# ${p.fileName}\n\n`
  }
  return `# ${p.fileName}\n\n`
}

function formatBullet(title: string | undefined, content: string): string {
  if (title) return `- **${title}**：${content}`
  return `- ${content}`
}

function findH2Exists(text: string, title: string): boolean {
  const re = new RegExp(`^## ${escapeRe(title)}\\s*$`, 'm')
  return re.test(text)
}

function findTitleInText(text: string, title: string): boolean {
  return findH2Exists(text, title) || text.includes(`## ${title}`)
}

function appendBulletToH2(text: string, h2Title: string, bullet: string): string {
  const lines = text.split(/\r?\n/)
  const re = new RegExp(`^## ${escapeRe(h2Title)}\\s*$`)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return appendH2Section(text, h2Title, bullet)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i
      break
    }
  }
  // 插入到节末尾（end 之前）
  const insert = [...lines.slice(0, end)]
  while (insert.length > start + 1 && insert[insert.length - 1].trim() === '') insert.pop()
  insert.push(bullet)
  insert.push('')
  return [...insert, ...lines.slice(end)].join('\n')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 地理表是否已有该地点名（避免确认地点 + 设定补丁双写重复） */
function tableHasPlace(text: string, placeName: string): boolean {
  const name = placeName.trim()
  if (!name) return false
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|') || t.includes('---') || t.includes('地点')) continue
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    if (cells[0] === name) return true
  }
  return false
}

/** 从 newLocations 生成地理设定补丁 */
export function patchesFromWorldLocations(
  locations: { name: string; notes: string; scope?: string }[]
): SettingsPatch[] {
  return locations
    .filter((l) => l.scope === 'world' && l.name?.trim())
    .map((l) => ({
      target: 'geography' as const,
      fileName: '地理',
      op: 'append_bullet' as const,
      title: l.name.trim(),
      content: (l.notes || l.name).trim(),
      reason: '正文出现的常驻地理',
      confidence: 'high' as const
    }))
}
