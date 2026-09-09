import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { readText } from './md-parser'
import { writeTextAtomic } from '../atomic'
import { withFileLock } from '../file-lock'
import type { Foreshadowing, ForeshadowingStatus, CreateForeshadowingInput, UpdateForeshadowingInput } from '../../../shared/types'

const HEADERS = ['伏笔编号', '伏笔内容', '伏笔类型', '埋设章节', '预计回收章节', '实际回收章节', '状态', '备注', '强化章节', '部分回收章节']
type Columns = { id: number; content: number; type: number; plant: number; expected: number; actual: number; status: number; note: number; reinforcement: number; partial: number }
type Table = { start: number; end: number; headers: string[]; columns: Columns; planned: boolean }
type Entry = { item: Foreshadowing; line: number; cells: string[]; table: Table; raw: string }
type CollectionRecord = { receiptId: string; id: string; chapter: number; before: string; beforeHash: string; afterHash: string; sourceHash?: string; evidence: string }
type CollectionOperation = { receiptId: string; id: string; chapter: number; before: string; beforeHash: string; afterHash: string; beforeCollection?: CollectionRecord; afterCollectionReceiptId?: string }
export interface ForeshadowCollectionChange { foreshadowingId: string; receiptId: string; action: 'collect' | 'uncollect' }
export interface AutomaticForeshadowCollection { foreshadowingId: string; evidence?: string }

/** All mutations read and write the single tracking source under one file lock. */
export class ForeshadowingMdRepo {
  constructor(private readonly projectDir: string) {}
  private get path(): string { return join(this.projectDir, '追踪', '伏笔.md') }
  async list(): Promise<Foreshadowing[]> { return parseForeshadowingMarkdown(await readText(this.path)) }

  async create(input: CreateForeshadowingInput): Promise<Foreshadowing> {
    const content = input.content.trim()
    if (!content) throw new Error('伏笔内容不能为空')
    if (input.expectedCollect != null) validChapter(input.expectedCollect)
    return withFileLock(this.path, async () => {
      const text = await readText(this.path)
      const entries = parseEntries(text, true)
      const nextNumber = entries.reduce((max, { item }) => Math.max(max, Number(item.id.match(/^FB-(\d+)$/i)?.[1] ?? 0)), 0) + 1
      const item: Foreshadowing = {
        id: `FB-${String(nextNumber).padStart(3, '0')}`, content, status: 'pending',
        expectedCollect: input.expectedCollect, note: input.note || undefined,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }
      const lines = text.split(/\r?\n/)
      const table = parseTables(lines).find((candidate) => !candidate.planned && candidate.columns.plant >= 0 && candidate.columns.actual >= 0)
      if (table) {
        const upgraded = input.note ? ensureColumns(lines, table, ['备注']) : table
        lines.splice(table.end + 1, 0, renderRow(item, upgraded))
      } else {
        lines.push('', '## 伏笔实际追踪', '', rowText(HEADERS), rowText(HEADERS.map(() => '---')), renderRow(item, { start: 0, end: 0, headers: HEADERS, columns: columnsFor(HEADERS), planned: false }))
      }
      await writeTextAtomic(this.path, lines.join('\n'))
      return item
    })
  }

  async update(id: string, patch: UpdateForeshadowingInput): Promise<Foreshadowing | null> {
    return this.change(id, (existing) => {
      const next = { ...existing }
      if (patch.content !== undefined) {
        if (!patch.content.trim()) throw new Error('伏笔内容不能为空')
        next.content = patch.content.trim()
      }
      if ('expectedCollect' in patch) next.expectedCollect = patch.expectedCollect ?? undefined
      if ('note' in patch) next.note = patch.note?.trim() || undefined
      if (patch.reinforcementChapters !== undefined) next.reinforcementChapters = uniqueChapters([...(patch.status === 'reinforced' ? existing.reinforcementChapters ?? [] : []), ...patch.reinforcementChapters])
      if (patch.partialCollectChapters !== undefined) next.partialCollectChapters = uniqueChapters([...(patch.status === 'partial' ? existing.partialCollectChapters ?? [] : []), ...patch.partialCollectChapters])
      if (patch.status !== undefined) {
        if (existing.status === 'collected') throw new Error('已完整回收的伏笔需先撤销回收，不能改为其他阶段')
        next.status = patch.status
        if (next.status === 'reinforced' && !next.reinforcementChapters?.length) throw new Error('强化状态必须填写实际强化章节')
        if (next.status === 'partial' && !next.partialCollectChapters?.length) throw new Error('部分回收必须填写实际发生章节')
      }
      if (next.status === 'partial' && !next.partialCollectChapters?.length && patch.partialCollectChapters !== undefined) next.status = next.reinforcementChapters?.length ? 'reinforced' : next.plantChapter ? 'planted' : 'pending'
      if (next.status === 'reinforced' && !next.reinforcementChapters?.length && patch.reinforcementChapters !== undefined) next.status = next.plantChapter ? 'planted' : 'pending'
      validateItem(next)
      return next
    })
  }

  async delete(id: string): Promise<void> {
    await withFileLock(this.path, async () => {
      const text = await readText(this.path)
      const entry = uniqueEntry(parseEntries(text), id)
      if (!entry) return
      const lines = text.split(/\r?\n/)
      lines.splice(entry.line, 1)
      await writeTextAtomic(this.path, lines.join('\n'))
    })
  }

  async plant(id: string, chapter: number): Promise<void> {
    validChapter(chapter)
    await this.change(id, (existing) => {
      if (existing.status === 'collected') throw new Error('已回收伏笔不能重新埋设，请先撤销回收')
      const next = { ...existing, status: 'planted' as ForeshadowingStatus, plantChapter: chapter, actualCollect: undefined }
      validateItem(next)
      return next
    })
  }
  async collect(id: string, chapter: number): Promise<void> {
    validChapter(chapter)
    await this.change(id, (existing) => collectionState(existing, chapter))
  }
  async uncollect(id: string): Promise<void> {
    await this.change(id, (existing) => ({ ...existing, actualCollect: undefined,
      status: existing.partialCollectChapters?.length ? 'partial' : existing.reinforcementChapters?.length ? 'reinforced' : existing.plantChapter ? 'planted' : 'pending' }))
  }
  async markMissed(id: string): Promise<void> {
    await this.change(id, (existing) => {
      if (existing.status === 'collected') throw new Error('已回收的伏笔不能标记为错过')
      return { ...existing, status: 'missed', actualCollect: undefined }
    })
  }

  /** Receipts belong to a chapter and an exact post-write row; manual edits stop automatic undo. */
  async reconcileAutomaticCollections(chapter: number, collections: AutomaticForeshadowCollection[], sourceContent?: string): Promise<{ collectedIds: string[]; revertedIds: string[]; warnings: string[]; changes: ForeshadowCollectionChange[] }> {
    validChapter(chapter)
    return withFileLock(this.path, async () => {
      let text = await readText(this.path)
      const originalEntries = parseEntries(text)
      const records = readCollectionRecords(text)
      const operations = readCollectionOperations(text)
      const warnings: string[] = []
      const collectedIds: string[] = []
      const revertedIds: string[] = []
      const changes: ForeshadowCollectionChange[] = []
      const requested = new Map(collections.map((collection) => [collection.foreshadowingId, collection]))
      const keepRecords: CollectionRecord[] = []
      // A malformed proposal is not an empty, successful extraction and cannot erase previous receipts.
      for (const collection of requested.values()) {
        const entry = uniqueEntry(parseEntries(text), collection.foreshadowingId)
        const evidence = collection.evidence?.trim() || ''
        if (!entry || (sourceContent !== undefined && (!evidence || !sourceContent.includes(evidence)))) {
          warnings.push(`伏笔 ${collection.foreshadowingId} 缺少唯一记录或本章原文回收证据，未应用或撤销`)
          return { collectedIds, revertedIds, warnings, changes }
        }
        if (!entry.item.plantChapter || chapter < entry.item.plantChapter) {
          warnings.push(`伏笔 ${collection.foreshadowingId} 缺少有效埋设章或回收时间倒置，未应用或撤销`)
          return { collectedIds, revertedIds, warnings, changes }
        }
      }
      for (const record of records) {
        if (record.chapter !== chapter) { keepRecords.push(record); continue }
        const entry = uniqueEntry(parseEntries(text), record.id)
        if (!entry || digest(entry.raw) !== record.afterHash) {
          keepRecords.push(record)
          warnings.push(`伏笔 ${record.id} 已被编辑，保留现状，未自动撤销`)
          requested.delete(record.id)
          continue
        }
        const lines = text.split(/\r?\n/)
        lines[entry.line] = record.before
        text = lines.join('\n')
        if (!requested.has(record.id)) revertedIds.push(record.id)
      }
      for (const collection of requested.values()) {
        try {
          const entry = uniqueEntry(parseEntries(text), collection.foreshadowingId)
          if (!entry) { warnings.push(`未找到唯一伏笔 ${collection.foreshadowingId}`); continue }
          if (entry.table.planned) { warnings.push(`伏笔 ${entry.item.id} 仍是规划记录，不能自动回收`); continue }
          if (entry.item.status === 'collected') continue
          const evidence = collection.evidence?.trim() || ''
          if (sourceContent !== undefined && (!evidence || !sourceContent.includes(evidence))) {
            warnings.push(`伏笔 ${entry.item.id} 缺少本章原文回收证据，未应用`)
            continue
          }
          const next = collectionState(entry.item, chapter)
          const after = renderRow(next, entry.table, entry.cells)
          const lines = text.split(/\r?\n/)
          lines[entry.line] = after
          text = lines.join('\n')
          keepRecords.push({ receiptId: randomUUID(), id: entry.item.id, chapter, before: entry.raw, beforeHash: digest(entry.raw), afterHash: digest(after), evidence, ...(sourceContent !== undefined ? { sourceHash: digest(sourceContent) } : {}) })
          collectedIds.push(entry.item.id)
        } catch (error) { warnings.push((error as Error).message) }
      }
      for (const id of new Set([...collectedIds, ...revertedIds])) {
        const before = uniqueEntry(originalEntries, id)
        const after = uniqueEntry(parseEntries(text), id)
        if (!before || !after) continue
        const afterCollection = keepRecords.find((record) => record.id === id)
        const receiptId = randomUUID()
        operations.push({ receiptId, id, chapter, before: before.raw, beforeHash: digest(before.raw), afterHash: digest(after.raw),
          beforeCollection: records.find((record) => record.id === id), afterCollectionReceiptId: afterCollection?.receiptId })
        changes.push({ foreshadowingId: id, receiptId, action: afterCollection ? 'collect' : 'uncollect' })
      }
      text = writeCollectionMetadata(text, keepRecords, operations)
      if (text || records.length) await writeTextAtomic(this.path, text)
      return { collectedIds, revertedIds, warnings, changes }
    })
  }

  /** Undo exactly one submitted operation, never a newer receipt for the same chapter and id. */
  async undoAutomaticCollections(chapter: number, receipts: { foreshadowingId: string; receiptId: string }[]): Promise<{ reverted: number; warnings: string[] }> {
    return withFileLock(this.path, async () => {
      let text = await readText(this.path)
      let records = readCollectionRecords(text)
      let operations = readCollectionOperations(text)
      let reverted = 0
      const warnings: string[] = []
      for (const receipt of receipts) {
        const operation = operations.find((item) => item.receiptId === receipt.receiptId && item.id === receipt.foreshadowingId && item.chapter === chapter)
        if (!operation) continue
        const entry = uniqueEntry(parseEntries(text), operation.id)
        const active = records.find((item) => item.id === operation.id)
        const laterOperation = operations.slice(operations.indexOf(operation) + 1).some((item) => item.id === operation.id)
        if (!entry || digest(entry.raw) !== operation.afterHash || active?.receiptId !== operation.afterCollectionReceiptId || laterOperation) {
          warnings.push(`伏笔 ${operation.id} 已被编辑或产生更新提交，未撤销旧提交`)
          continue
        }
        const lines = text.split(/\r?\n/)
        lines[entry.line] = operation.before
        text = lines.join('\n')
        records = records.filter((item) => item.id !== operation.id)
        if (operation.beforeCollection) records.push(operation.beforeCollection)
        operations = operations.filter((item) => item.receiptId !== operation.receiptId)
        reverted++
      }
      if (reverted) await writeTextAtomic(this.path, writeCollectionMetadata(text, records, operations))
      return { reverted, warnings }
    })
  }

  private async change(id: string, transform: (existing: Foreshadowing) => Foreshadowing): Promise<Foreshadowing | null> {
    return withFileLock(this.path, async () => {
      const text = await readText(this.path)
      const entry = uniqueEntry(parseEntries(text), id)
      if (!entry) return null
      if (entry.table.planned) throw new Error('规划表不能直接登记实际进度，请先移入伏笔实际追踪表')
      const next = transform(entry.item)
      validateItem(next)
      const lines = text.split(/\r?\n/)
      const required = [...(next.note !== entry.item.note ? ['备注'] : []), ...(next.reinforcementChapters?.length || entry.item.reinforcementChapters?.length ? ['强化章节'] : []), ...(next.partialCollectChapters?.length || entry.item.partialCollectChapters?.length ? ['部分回收章节'] : [])]
      const table = ensureColumns(lines, entry.table, required)
      lines[entry.line] = renderRow(next, table, entry.cells)
      // An explicit author mutation takes ownership even when the visible value was reaffirmed.
      const records = readCollectionRecords(text).filter((record) => record.id !== id)
      await writeTextAtomic(this.path, writeCollectionMetadata(lines.join('\n'), records, readCollectionOperations(text)))
      return { ...next, updatedAt: new Date().toISOString() }
    })
  }
}

export function parseForeshadowingMarkdown(text: string): Foreshadowing[] { return parseEntries(text).map((entry) => entry.item) }

function columnsFor(headers: string[]): Columns {
  const find = (match: (header: string) => boolean) => headers.findIndex((header) => match(header.replace(/\*|`/g, '').trim()))
  return {
    id: find((h) => /编号|^ID$|伏笔ID/i.test(h)), content: find((h) => /内容|描述|名称/.test(h) || h === '伏笔'),
    type: find((h) => h.includes('类型')),
    plant: find((h) => /埋设|埋入|铺设/.test(h) && !/预计|计划/.test(h)),
    expected: find((h) => /预计|计划|预定/.test(h) && /回收|收回|揭晓/.test(h)),
    actual: find((h) => /实际|完成/.test(h) && /回收|收回|揭晓/.test(h)),
    status: find((h) => /状态|阶段/.test(h)), note: find((h) => /备注|注释|说明/.test(h)),
    reinforcement: find((h) => /强化.*章|强化.*进度/.test(h)), partial: find((h) => /部分.*章|部分.*进度/.test(h))
  }
}

function parseTables(lines: string[]): Table[] {
  const tables: Table[] = []
  const headings: string[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue }
    if (fenced) continue
    const heading = lines[i].match(/^(#{1,6})\s+(.*)/)
    if (heading) { headings.length = heading[1].length; headings[heading[1].length - 1] = heading[2] }
    if (!lines[i].trim().startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue
    const headers = splitRow(lines[i])
    const columns = columnsFor(headers)
    let end = i + 1
    while (lines[end + 1]?.trim().startsWith('|') && !isSeparator(lines[end + 2] ?? '')) end++
    if (columns.id >= 0 && columns.content >= 0 && columns.status >= 0 && (columns.plant >= 0 || columns.expected >= 0 || columns.actual >= 0)) tables.push({ start: i, end, headers, columns, planned: headings.some((title) => /计划|规划|细纲|预设|拟定|预计/.test(title)) && !headings.some((title) => /实际追踪|实际记录/.test(title)) })
    i = end
  }
  return tables
}

function parseEntries(text: string, includePlanned = false): Entry[] {
  const lines = text.split(/\r?\n/)
  const entries: Entry[] = []
  for (const table of parseTables(lines)) {
    if (table.planned && !includePlanned) continue
    const c = table.columns
    for (let line = table.start + 2; line <= table.end; line++) {
      const cells = splitRow(lines[line])
      const get = (column: number) => column >= 0 ? cells[column]?.trim() || '' : ''
      const id = get(c.id)
      const content = get(c.content)
      if (!id || !content || /编号|^ID$/i.test(id) || isSeparator(lines[line])) continue
      const plantChapter = table.planned ? undefined : parseActualChapter(get(c.plant))
      const recordedActual = table.planned ? undefined : parseActualChapter(get(c.actual))
      let status = table.planned ? 'pending' as ForeshadowingStatus : mapStatus(get(c.status), plantChapter)
      if (status === 'collected' && (!recordedActual || !plantChapter || recordedActual < plantChapter)) status = plantChapter ? 'planted' : 'pending'
      const now = new Date().toISOString()
      entries.push({ item: {
        id, content, status, plantChapter, expectedCollect: parseChapterNum(get(c.expected)), actualCollect: status === 'collected' ? recordedActual : undefined,
        note: get(c.note) || (c.note < 0 ? get(c.type) : '') || undefined,
        reinforcementChapters: [...new Set([...chapterList(get(c.reinforcement)), ...(status === 'reinforced' && recordedActual ? [recordedActual] : [])])],
        partialCollectChapters: [...new Set([...chapterList(get(c.partial)), ...(status === 'partial' && recordedActual ? [recordedActual] : [])])], createdAt: now, updatedAt: now
      }, line, cells, table, raw: lines[line] })
    }
  }
  return entries
}

function mapStatus(text: string, plantChapter?: number): ForeshadowingStatus {
  const value = text.replace(/[*`\s]/g, '').replace(/^[\p{S}\uFE0F]+/u, '')
  if (/^(暂缓|延后|搁置|续篇|延期)/.test(value)) return 'deferred'
  if (/^(已?部分回收|已?部分收回|已?部分缓解|回收了一部分)/.test(value)) return 'partial'
  if (/^(强化|已强化|加深|推进)/.test(value)) return 'reinforced'
  if (/未回收|未收回|未完成|尚未|待回收|计划|预计|拟回收|未兑现/.test(value)) return plantChapter ? 'planted' : 'pending'
  if (/^(已回收|已收回|已兑现|回收完成|collected)(?:$|[（(：:，,。·✓✅])/.test(value)) return 'collected'
  if (/^(已错过|遗漏|missed)/.test(value)) return 'missed'
  if (/^(已埋设|已铺设|planted)/.test(value)) return 'planted'
  return 'pending'
}

function uniqueEntry(entries: Entry[], id: string): Entry | undefined {
  if (!id.trim()) throw new Error('伏笔编号不能为空')
  const hits = entries.filter((entry) => entry.item.id === id)
  if (hits.length > 1) throw new Error(`伏笔编号 ${id} 存在重复，请先消除歧义`)
  return hits[0]
}
function collectionState(existing: Foreshadowing, chapter: number): Foreshadowing {
  if (!existing.plantChapter) throw new Error(`伏笔 ${existing.id} 尚未登记实际埋设章节，不能回收`)
  if (existing.status === 'collected' && existing.actualCollect !== chapter) throw new Error(`伏笔 ${existing.id} 已在第 ${existing.actualCollect} 章回收，请先撤销后修正`)
  const next = { ...existing, status: 'collected' as ForeshadowingStatus, actualCollect: chapter }
  validateItem(next)
  return next
}
function validateItem(item: Foreshadowing): void {
  for (const value of [item.plantChapter, item.expectedCollect, item.actualCollect, ...(item.reinforcementChapters ?? []), ...(item.partialCollectChapters ?? [])]) if (value != null) validChapter(value)
  if (item.actualCollect && (!item.plantChapter || item.actualCollect < item.plantChapter)) throw new Error('实际回收章节不能早于实际埋设章节')
  const stages = [...(item.reinforcementChapters ?? []), ...(item.partialCollectChapters ?? [])]
  if (stages.some((chapter) => !item.plantChapter || chapter < item.plantChapter! || Boolean(item.actualCollect && chapter > item.actualCollect))) throw new Error('强化或部分回收章节必须位于埋设之后、完整回收之前')
}
function validChapter(chapter: number): void { if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error('章节必须是大于零的整数') }

function ensureColumns(lines: string[], table: Table, names: string[]): Table {
  const missing = names.filter((name) => !table.headers.includes(name))
  if (!missing.length) return table
  const headers = [...table.headers, ...missing]
  lines[table.start] = rowText(headers)
  lines[table.start + 1] = rowText(headers.map(() => '---'))
  for (let i = table.start + 2; i <= table.end; i++) {
    const cells = splitRow(lines[i])
    // Existing rows may omit trailing empty cells. Keeping their bytes preserves other rows' provenance.
    if (cells.length > headers.length) lines[i] = rowText(cells)
  }
  return { ...table, headers, columns: columnsFor(headers) }
}
function renderRow(item: Foreshadowing, table: Table, previous: string[] = []): string {
  const cells = [...previous]
  while (cells.length < table.headers.length) cells.push('')
  const c = table.columns
  const set = (index: number, value: string) => { if (index >= 0) cells[index] = value }
  set(c.id, item.id); set(c.content, item.content)
  if (c.type >= 0 && !cells[c.type]) cells[c.type] = '设定'
  set(c.plant, fmtChapter(item.plantChapter, '未埋设')); set(c.expected, fmtChapter(item.expectedCollect, '未定')); set(c.actual, fmtChapter(item.actualCollect, '未回收'))
  set(c.status, unmapStatus(item.status)); set(c.note, item.note || '')
  set(c.reinforcement, (item.reinforcementChapters ?? []).map((n) => fmtChapter(n)).join('；')); set(c.partial, (item.partialCollectChapters ?? []).map((n) => fmtChapter(n)).join('；'))
  return rowText(cells)
}
function splitRow(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|')) }
function rowText(cells: string[]): string { return `| ${cells.map((cell) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |` }
function isSeparator(line: string): boolean { return line.trim().startsWith('|') && splitRow(line).every((cell) => /^:?-+:?$/.test(cell)) }
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function uniqueChapters(chapters: number[]): number[] { chapters.forEach(validChapter); return [...new Set(chapters)].sort((a, b) => a - b) }
function chapterList(text: string): number[] { return [...new Set([...text.matchAll(/第\s*(\d+)\s*章/g)].map((m) => Number(m[1])).filter((n) => n > 0))] }
function readCollectionRecords(text: string): CollectionRecord[] {
  const records: CollectionRecord[] = []
  for (const match of text.matchAll(/<!-- writer-foreshadow-collection:([A-Za-z0-9+/=]+) -->/g)) {
    try {
      const record: CollectionRecord = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
      if (record.id && Number.isSafeInteger(record.chapter) && typeof record.before === 'string' && !/[\r\n]/.test(record.before) && digest(record.before) === record.beforeHash && /^[a-f0-9]{64}$/.test(record.afterHash)) records.push({ ...record, receiptId: record.receiptId || digest(match[1]) })
    } catch { /* Invalid provenance is never trusted for undo. */ }
  }
  return records
}
function stripCollectionRecords(text: string): string { return text.replace(/<!-- writer-foreshadow-collection:[A-Za-z0-9+/=]+ -->\r?\n?/g, '') }

function readCollectionOperations(text: string): CollectionOperation[] {
  const operations: CollectionOperation[] = []
  for (const match of text.matchAll(/<!-- writer-foreshadow-operation:([A-Za-z0-9+/=]+) -->/g)) {
    try {
      const operation: CollectionOperation = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
      if (operation.receiptId && operation.id && Number.isSafeInteger(operation.chapter) && typeof operation.before === 'string' && !/[\r\n]/.test(operation.before) && digest(operation.before) === operation.beforeHash && /^[a-f0-9]{64}$/.test(operation.afterHash)) operations.push(operation)
    } catch { /* An incomplete operation is not an undo permission. */ }
  }
  return operations
}

function writeCollectionMetadata(text: string, records: CollectionRecord[], operations: CollectionOperation[]): string {
  const clean = stripCollectionRecords(text).replace(/<!-- writer-foreshadow-operation:[A-Za-z0-9+/=]+ -->\r?\n?/g, '').trimEnd()
  const metadata = [
    ...records.map((record) => `<!-- writer-foreshadow-collection:${Buffer.from(JSON.stringify(record), 'utf8').toString('base64')} -->`),
    ...operations.map((operation) => `<!-- writer-foreshadow-operation:${Buffer.from(JSON.stringify(operation), 'utf8').toString('base64')} -->`)
  ]
  return clean + (metadata.length ? '\n\n' + metadata.join('\n') : '') + '\n'
}
function unmapStatus(status: ForeshadowingStatus): string { return ({ collected: '已回收', missed: '已错过', planted: '已埋设', pending: '未回收', reinforced: '强化', partial: '部分回收', deferred: '暂缓' })[status] }

export function parseChapterNum(text: string): number | undefined {
  const value = text?.trim()
  if (!value || /^(未回收|未定|未埋设|续篇|待定|—|－|-|\/)$/.test(value)) return undefined
  const match = value.match(/第\s*(\d+)\s*(?:章|[/／-]\s*\d+\s*章)/)
  const number = match ? Number(match[1]) : /^\d+(?:[-/／]\d+)?$/.test(value) ? Number(value.match(/^\d+/)![0]) : undefined
  return number && Number.isSafeInteger(number) ? number : undefined
}
function parseActualChapter(text: string): number | undefined {
  if (/未回收|未埋设|尚未|待定|预计|计划|拟于|预定|待回收/.test(text)) return undefined
  const mentions = [...text.matchAll(/第\s*(\d+)\s*(?:章|[/／-]\s*(\d+)\s*章)/g)].map((match) => Number(match[2] || match[1]))
  return mentions.length ? Math.max(...mentions) : parseChapterNum(text)
}
function fmtChapter(chapter?: number, fallback = '未定'): string { return chapter ? `第 ${chapter} 章` : fallback }
