import { join } from 'path'
import { promises as fs } from 'fs'
import { contentRevision } from './chapter-revision'
import { writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { ProseRepo } from './skill-format/prose-repo'
import { recordChapterStage } from './chapter-execution'

const VERSION = 1
interface Projection { identity: string; value: unknown }
interface Snapshot { version: number; sourceRevision: string; evidence: string[]; projections: Record<string, Projection> }

/** One immutable prose revision backs summaries, ending state and memory candidates.
 * Shared quotes are location hints, never an alternate source of story truth. */
export class ChapterFactSnapshot {
  private file: string
  readonly revision: string
  constructor(private dir: string, private chapter: number, private content: string) {
    this.revision = contentRevision(content)
    this.file = join(dir, '.cache', 'chapter-facts', `${chapter}.json`)
  }
  private async load(): Promise<Snapshot> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as Snapshot
      if (value.version === VERSION && value.sourceRevision === this.revision && Array.isArray(value.evidence) &&
          value.evidence.every(quote => typeof quote === 'string' && this.content.includes(quote)) &&
          value.projections && typeof value.projections === 'object') return value
    } catch { /* Missing, corrupt or old-source snapshots cannot authorize reuse. */ }
    return { version: VERSION, sourceRevision: this.revision, evidence: [], projections: {} }
  }
  async read<T>(kind: string, identity: string | null | undefined, valid: (value: T) => boolean): Promise<T | undefined> {
    if (!identity || await new ProseRepo(this.dir).read(this.chapter) !== this.content) return undefined
    const record = (await this.load()).projections[kind]
    if (record?.identity === identity && valid(record.value as T)) {
      recordChapterStage({ stage: `facts:${kind}`, verdict: 'cached', inputRevision: this.revision })
      return structuredClone(record.value as T)
    }
    return undefined
  }
  async remember(kind: string, identity: string | null | undefined, value: unknown, quotes: string[] = []): Promise<void> {
    await withFileLock(this.file, async () => {
      if (await new ProseRepo(this.dir).read(this.chapter) !== this.content) return
      const snapshot = await this.load()
      snapshot.evidence = [...new Set([...snapshot.evidence, ...quotes.filter(quote => quote.trim().length >= 6 && this.content.includes(quote))])].slice(0, 96)
      if (identity) snapshot.projections[kind] = { identity, value }
      await writeJsonAtomic(this.file, snapshot)
    }).catch(() => { console.warn('[chapter-facts] 证据快照未保存，下次重新提取') })
  }
  async context(): Promise<string> {
    const quotes = (await this.load()).evidence.filter(quote => quote.length <= 200).slice(0, 16)
    return quotes.length ? `本章原文证据定位索引（不完整，仅帮助定位；不表示已确认事实，不得忽略未列出的正文）：\n${JSON.stringify(quotes)}` : ''
  }
}
