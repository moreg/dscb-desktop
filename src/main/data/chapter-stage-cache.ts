import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { join, resolve } from 'path'
import { writeJsonAtomic } from './atomic'
import { mapMemoryFiles, memoryFileFingerprint } from './memory/repository-cache'

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
// Bump when stage prompts, parsers or acceptance rules change.
const REVISION = 'batch-stages-2-boundary'
const excluded = new Set(['.cache', '.git', '.versions', '.longform-review.json', '.chapter-status.json'])
const fileDigests = new Map<string, { fingerprint: string; digest: string }>()
const pendingDigests = new Map<string, Promise<string>>()
const MAX_DIGEST_ENTRIES = 8192

async function fileDigest(file: string): Promise<string> {
  const key = resolve(file)
  const fingerprint = await memoryFileFingerprint(key)
  if (fingerprint === 'missing') { fileDigests.delete(key); throw new Error('Dependency disappeared') }
  const cached = fileDigests.get(key)
  if (cached?.fingerprint === fingerprint) {
    fileDigests.delete(key); fileDigests.set(key, cached)
    return cached.digest
  }
  const pendingKey = `${key}\0${fingerprint}`
  const pending = pendingDigests.get(pendingKey)
  if (pending) return pending
  const request = (async () => {
    let value: string
    if (Number(fingerprint.split(':', 1)[0]) <= 1024 * 1024) value = digest(await fs.readFile(key))
    else {
      // 封面、导出包等大文件分块读取，避免一次把整个文件装进内存。
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(key)) hash.update(chunk)
      value = hash.digest('hex')
    }
    if (await memoryFileFingerprint(key) !== fingerprint) throw new Error('Dependency changed during hashing')
    fileDigests.delete(key)
    fileDigests.set(key, { fingerprint, digest: value })
    while (fileDigests.size > MAX_DIGEST_ENTRIES) fileDigests.delete(fileDigests.keys().next().value!)
    return value
  })()
  pendingDigests.set(pendingKey, request)
  try { return await request } finally { pendingDigests.delete(pendingKey) }
}

/** Conservative content fingerprint: edits, additions and removals all invalidate receipts. */
export async function chapterDependencyHash(dir: string, config: unknown, ignore?: (relative: string) => boolean): Promise<string | null> {
  const paths: string[] = []
  async function walk(relative: string): Promise<void> {
    const entries = await fs.readdir(join(dir, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name.endsWith('.tmp')) continue
      const path = join(relative, entry.name)
      if (ignore?.(path.replace(/\\/g, '/'))) continue
      if (entry.isSymbolicLink()) throw new Error('External dependency')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  try {
    await walk('')
    const files = await mapMemoryFiles(paths, async path => [path, await fileDigest(join(dir, path))])
    return digest(JSON.stringify([REVISION, config, files]))
  }
  catch { return null } // Unreadable or externally linked context must not authorize reuse.
}

export class ChapterStageCache {
  constructor(private dir: string, private chapter: number, private fingerprint: () => Promise<string | null>) {}
  private file(stage: string): string { return join(this.dir, '.cache', 'chapter-stages', `${this.chapter}-${stage}.json`) }
  async read<T>(stage: string, valid: (value: T) => boolean): Promise<T | undefined> {
    const key = await this.fingerprint()
    return this.readWithKey(stage, key, valid)
  }
  private async readWithKey<T>(stage: string, key: string | null, valid: (value: T) => boolean): Promise<T | undefined> {
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
  /** Bind a receipt to the input fingerprint, never to a later edited dependency. */
  async rememberIfUnchanged<T>(stage: string, expectedKey: string, value: T): Promise<void> {
    if (await this.fingerprint() === expectedKey) await this.write(stage, expectedKey, value, 0)
  }
  private async write<T>(stage: string, key: string, value: T, durationMs: number): Promise<void> {
    try { await writeJsonAtomic(this.file(stage), { version: REVISION, key, value, durationMs, completedAt: new Date().toISOString() }) }
    catch { console.warn('[chapter-stages] 无法保存阶段记录，下次将重新检查') }
  }
  async run<T>(stage: string, action: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
    const key = await this.fingerprint()
    const cached = await this.readWithKey(stage, key, valid)
    if (cached !== undefined) return cached
    const start = Date.now()
    const value = await action()
    if (key && valid(value) && key === await this.fingerprint()) await this.write(stage, key, value, Date.now() - start)
    return value
  }
}
