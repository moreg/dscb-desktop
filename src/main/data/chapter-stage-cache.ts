import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from './atomic'

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
// Bump when stage prompts, parsers or acceptance rules change.
const REVISION = 'batch-stages-2-boundary'
const excluded = new Set(['.cache', '.git', '.versions', '.longform-review.json', '.chapter-status.json'])

/** Conservative content fingerprint: edits, additions and removals all invalidate receipts. */
export async function chapterDependencyHash(dir: string, config: unknown, ignore?: (relative: string) => boolean): Promise<string | null> {
  const files: [string, string][] = []
  async function walk(relative: string): Promise<void> {
    const entries = await fs.readdir(join(dir, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name.endsWith('.tmp')) continue
      const path = join(relative, entry.name)
      if (ignore?.(path.replace(/\\/g, '/'))) continue
      if (entry.isSymbolicLink()) throw new Error('External dependency')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push([path, digest(await fs.readFile(join(dir, path)))])
    }
  }
  try { await walk(''); return digest(JSON.stringify([REVISION, config, files])) }
  catch { return null } // Unreadable or externally linked context must not authorize reuse.
}

export class ChapterStageCache {
  constructor(private dir: string, private chapter: number, private fingerprint: () => Promise<string | null>) {}
  private file(stage: string): string { return join(this.dir, '.cache', 'chapter-stages', `${this.chapter}-${stage}.json`) }
  async read<T>(stage: string, valid: (value: T) => boolean): Promise<T | undefined> {
    const key = await this.fingerprint()
    if (!key) return undefined
    try {
      const receipt = JSON.parse(await fs.readFile(this.file(stage), 'utf8'))
      if (receipt.version === REVISION && receipt.key === key && valid(receipt.value)) return receipt.value as T
    } catch { /* Missing, corrupt or obsolete receipts are cache misses. */ }
    return undefined
  }
  async remember<T>(stage: string, value: T): Promise<void> {
    const key = await this.fingerprint()
    if (key) await this.write(stage, key, value, 0)
  }
  private async write<T>(stage: string, key: string, value: T, durationMs: number): Promise<void> {
    try { await writeJsonAtomic(this.file(stage), { version: REVISION, key, value, durationMs, completedAt: new Date().toISOString() }) }
    catch { console.warn('[chapter-stages] 无法保存阶段记录，下次将重新检查') }
  }
  async run<T>(stage: string, action: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
    const key = await this.fingerprint()
    const cached = await this.read(stage, valid)
    if (cached !== undefined) return cached
    const start = Date.now()
    const value = await action()
    if (key && valid(value) && key === await this.fingerprint()) await this.write(stage, key, value, Date.now() - start)
    return value
  }
}
