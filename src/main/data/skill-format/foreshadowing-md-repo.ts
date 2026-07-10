import { join } from 'path'
import { readText, parseDoc, parseTable } from './md-parser'
import { appendTableRow, deleteTableRow, replaceTableRow } from './md-writer'
import { writeTextAtomic } from '../atomic'
import type {
  Foreshadowing,
  ForeshadowingStatus,
  CreateForeshadowingInput,
  UpdateForeshadowingInput
} from '../../../shared/types'

/**
 * 读取伏笔追踪。真相源（双路径）：
 * 1. `追踪/伏笔.md`（opening-service 创建路径，多 H2 节多表格，表头一致）
 * 2. `记忆系统/伏笔追踪.md`（回退路径，老项目 / app 自身写入路径）
 *
 * 解析大表（伏笔编号|内容|类型|埋设|预计回收|实际回收|状态）→ Foreshadowing[]。
 * v3.2 状态文本（未回收/强化/部分回收/已回收/续篇）映射到 app 的 4 态枚举。
 *
 * 注意：写入仍固定到 `记忆系统/伏笔追踪.md`（保持与 opening-service 创建路径一致，
 * 避免 追踪/伏笔.md 与 记忆系统/伏笔追踪.md 双写分裂）。
 */
export class ForeshadowingMdRepo {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<Foreshadowing[]> {
    // 优先读 追踪/伏笔.md（opening-service 创建路径，更全）
    const trackingText = await readText(join(this.projectDir, '追踪', '伏笔.md'))
    if (trackingText) {
      const items = parseForeshadowingTable(trackingText)
      if (items.length > 0) return items
    }
    // 回退：记忆系统/伏笔追踪.md（老项目 / app 写入路径）
    const memoryText = await readText(join(this.projectDir, '记忆系统', '伏笔追踪.md'))
    if (!memoryText) return []
    return parseForeshadowingTable(memoryText)
  }

  // ===== Phase 3b 写入（表行增删改） =====

  private async file(): Promise<{ path: string; text: string }> {
    const path = join(this.projectDir, '记忆系统', '伏笔追踪.md')
    return { path, text: await readText(path) }
  }

  async create(input: CreateForeshadowingInput): Promise<Foreshadowing> {
    const { path, text } = await this.file()
    const existing = await this.list()
    const nextNum =
      existing.reduce((max, f) => {
        const m = f.id.match(/FB-(\d+)/)
        return m ? Math.max(max, parseInt(m[1], 10)) : max
      }, 0) + 1
    const id = `FB-${String(nextNum).padStart(3, '0')}`
    const row = [
      id,
      input.content,
      input.note ?? '设定',
      '未埋设',
      fmtChapter(input.expectedCollect),
      '未回收',
      '未回收'
    ]
    await writeTextAtomic(path, appendTableRow(text, row))
    const now = new Date().toISOString()
    return {
      id,
      content: input.content,
      status: 'pending',
      expectedCollect: input.expectedCollect,
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
  }

  async update(id: string, patch: UpdateForeshadowingInput): Promise<Foreshadowing | null> {
    const { path, text } = await this.file()
    const existing = (await this.list()).find((f) => f.id === id)
    if (!existing) return null
    const cells = [
      id,
      patch.content ?? existing.content,
      patch.note ?? existing.note ?? '设定',
      existing.plantChapter ? fmtChapter(existing.plantChapter, '未埋设') : '未埋设',
      fmtChapter(patch.expectedCollect ?? existing.expectedCollect),
      existing.actualCollect ? fmtChapter(existing.actualCollect, '未回收') : '未回收',
      unmapStatus(existing.status)
    ]
    const next = replaceTableRow(text, (row) => row[0]?.trim() === id, cells)
    if (next === text) return null
    await writeTextAtomic(path, next)
    return { ...existing, ...patch, updatedAt: new Date().toISOString() }
  }

  async delete(id: string): Promise<void> {
    const { path, text } = await this.file()
    const next = deleteTableRow(text, (row) => row[0]?.trim() === id)
    if (next === text) return
    await writeTextAtomic(path, next)
  }

  async plant(id: string, chapter: number): Promise<void> {
    await this.updateCell(id, { status: 'planted', plantChapter: chapter })
  }

  async collect(id: string, chapter: number): Promise<void> {
    await this.updateCell(id, { status: 'collected', actualCollect: chapter })
  }

  async markMissed(id: string): Promise<void> {
    await this.updateCell(id, { status: 'missed' })
  }

  private async updateCell(
    id: string,
    change: { status: ForeshadowingStatus; plantChapter?: number; actualCollect?: number }
  ): Promise<void> {
    const { path, text } = await this.file()
    const existing = (await this.list()).find((f) => f.id === id)
    if (!existing) return
    const plantChapter = change.plantChapter ?? existing.plantChapter
    const actualCollect = change.actualCollect ?? existing.actualCollect
    const cells = [
      id,
      existing.content,
      existing.note ?? '设定',
      plantChapter ? fmtChapter(plantChapter, '未埋设') : '未埋设',
      fmtChapter(existing.expectedCollect),
      actualCollect ? fmtChapter(actualCollect, '未回收') : '未回收',
      unmapStatus(change.status)
    ]
    const next = replaceTableRow(text, (row) => row[0]?.trim() === id, cells)
    if (next === text) return
    await writeTextAtomic(path, next)
  }
}

/** v3.2 伏笔状态文本 → app 枚举 */
function mapStatus(text: string): ForeshadowingStatus {
  if (!text) return 'pending'
  if (text.includes('已回收')) return 'collected'
  if (text.includes('已错过') || text.includes('遗漏')) return 'missed'
  if (text.includes('已埋设') || text.includes('部分回收') || text.includes('强化')) return 'planted'
  return 'pending'
}

/**
 * 解析伏笔大表（伏笔编号|内容|类型|埋设|预计回收|实际回收|状态）→ Foreshadowing[]。
 * 支持单表（记忆系统/伏笔追踪.md）和多 H2 节多表格（追踪/伏笔.md，表头一致）。
 * parseTable 会合并所有 | 开头的行，因表头相同能正确解析。
 */
function parseForeshadowingTable(text: string): Foreshadowing[] {
  const doc = parseDoc(text)
  const { headers, rows } = parseTable(doc.body)
  if (headers.length < 5) return []
  const now = new Date().toISOString()
  const items: Foreshadowing[] = []
  const idx = {
    id: headers.findIndex((h) => h.includes('编号')),
    content: headers.findIndex((h) => h.includes('内容')),
    type: headers.findIndex((h) => h.includes('类型')),
    plant: headers.findIndex((h) => h.includes('埋设')),
    expected: headers.findIndex((h) => h.includes('预计') && h.includes('回收')),
    actual: headers.findIndex((h) => h.includes('实际') && h.includes('回收')),
    status: headers.findIndex((h) => h.includes('状态'))
  }
  for (const row of rows) {
    const content = idx.content >= 0 ? row[idx.content] : ''
    if (!content) continue
    const id = idx.id >= 0 ? row[idx.id].trim() : ''
    const typeText = idx.type >= 0 ? row[idx.type] : ''
    const statusText = idx.status >= 0 ? row[idx.status] : ''
    items.push({
      id: id || `fb-${items.length + 1}`,
      content,
      status: mapStatus(statusText),
      plantChapter: parseChapterNum(idx.plant >= 0 ? row[idx.plant] : ''),
      expectedCollect: parseChapterNum(idx.expected >= 0 ? row[idx.expected] : ''),
      actualCollect: parseChapterNum(idx.actual >= 0 ? row[idx.actual] : ''),
      note: typeText || undefined,
      createdAt: now,
      updatedAt: now
    })
  }
  return items
}

/** app 枚举 → v3.2 状态文本（写回用） */
function unmapStatus(s: ForeshadowingStatus): string {
  switch (s) {
    case 'collected':
      return '已回收'
    case 'missed':
      return '已错过'
    case 'planted':
      return '已埋设'
    default:
      return '未回收'
  }
}

/** 「第 3 章」→ 3；「第 30/65 章」→ 30；「未回收」/「续篇」/「待定」→ undefined */
function parseChapterNum(text: string): number | undefined {
  if (!text) return undefined
  const m = text.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : undefined
}

function fmtChapter(n: number | undefined, fallback = '未定'): string {
  return n ? `第 ${n} 章` : fallback
}
