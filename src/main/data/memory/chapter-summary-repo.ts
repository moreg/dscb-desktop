import { join } from 'path'
import { readJson, writeJsonAtomic } from '../atomic'
import { hashProse } from './prose-memory-index'
import type { ChapterSummaryFact } from '../../../shared/types'

export interface ChapterSummary {
  schemaVersion: 1
  chapterNumber: number
  sourceHash: string
  generatedAt: string
  events: ChapterSummaryFact[]
  stateChanges: ChapterSummaryFact[]
  openThreads: ChapterSummaryFact[]
}

export function chapterSummaryText(summary: ChapterSummary): string {
  return [
    ...summary.events.map((item) => `事件：${item.text}`),
    ...summary.stateChanges.map((item) => `状态：${item.text}`),
    ...summary.openThreads.map((item) => `未结：${item.text}`)
  ].join('；')
}

export class ChapterSummaryRepo {
  constructor(private readonly projectDir: string) {}

  private path(chapterNumber: number): string {
    return join(this.projectDir, '记忆', '章节概要', `第${String(chapterNumber).padStart(3, '0')}章.json`)
  }

  async read(chapterNumber: number): Promise<ChapterSummary | null> {
    let value: ChapterSummary | null
    try { value = await readJson<ChapterSummary | null>(this.path(chapterNumber), null) }
    catch (err) { if (err instanceof SyntaxError) return null; throw err }
    if (!value || value.schemaVersion !== 1 || value.chapterNumber !== chapterNumber ||
      typeof value.sourceHash !== 'string' || !Array.isArray(value.events) ||
      !Array.isArray(value.stateChanges) || !Array.isArray(value.openThreads)) return null
    if (![...value.events, ...value.stateChanges, ...value.openThreads].every((item) =>
      item && typeof item.text === 'string' && typeof item.evidence === 'string')) return null
    return value
  }

  async readCurrent(chapterNumber: number, prose: string): Promise<ChapterSummary | null> {
    const value = await this.read(chapterNumber)
    return value && prose.trim() && value.sourceHash === hashProse(prose) ? value : null
  }

  async write(summary: ChapterSummary): Promise<void> {
    await writeJsonAtomic(this.path(summary.chapterNumber), summary)
  }
}
