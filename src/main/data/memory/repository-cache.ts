import { promises as fs } from 'fs'
import { join, resolve, sep, dirname } from 'path'
import { readText, parseDoc, type ParsedDoc } from '../skill-format/md-parser'

const CONCURRENCY = 8
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 4096
const textCache = new Map<string, { fingerprint: string; text: string; doc?: ParsedDoc }>()
const pendingReads = new Map<string, Promise<string>>()
let textBytes = 0
const directories = new Map<string, { fingerprint: string; entries: import('fs').Dirent[]; checkedAt: number }>()
const DIRECTORY_RECHECK_MS = 5000

export async function mapMemoryFiles<Input, Output>(inputs: Input[], action: (input: Input) => Promise<Output>): Promise<Output[]> {
  const results: Output[] = []
  for (let offset = 0; offset < inputs.length; offset += CONCURRENCY) {
    results.push(...await Promise.all(inputs.slice(offset, offset + CONCURRENCY).map(action)))
  }
  return results
}

export async function memoryFileFingerprint(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file)
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export function invalidateMemoryFile(file: string): void {
  const key = resolve(file)
  directories.delete(key)
  directories.delete(dirname(key))
  forgetText(key)
}

function forgetText(key: string): void {
  const cached = textCache.get(key)
  if (cached) textBytes -= Buffer.byteLength(cached.text, 'utf8')
  textCache.delete(key)
}

export function memorySourcePath(projectDir: string, subdirectory: string, source?: string): string | undefined {
  if (!source) return undefined
  const root = resolve(projectDir, '记忆', subdirectory)
  const file = resolve(projectDir, source)
  return file.startsWith(root + sep) ? file : undefined
}

function retainText(file: string, fingerprint: string, text: string): void {
  forgetText(file)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BYTES) return
  textCache.set(file, { fingerprint, text })
  textBytes += bytes
  while (textCache.size > MAX_ENTRIES || textBytes > MAX_BYTES) {
    forgetText(textCache.keys().next().value!)
  }
}

export async function readMemoryText(file: string): Promise<string> {
  const key = resolve(file)
  const fingerprint = await memoryFileFingerprint(key)
  if (fingerprint === 'missing') {
    invalidateMemoryFile(key)
    return ''
  }
  const cached = textCache.get(key)
  if (cached?.fingerprint === fingerprint) {
    textCache.delete(key)
    textCache.set(key, cached)
    return cached.text
  }
  const pendingKey = `${key}\0${fingerprint}`
  const pending = pendingReads.get(pendingKey)
  if (pending) return pending
  const request = (async () => {
    const text = await readText(key)
    if (await memoryFileFingerprint(key) === fingerprint) retainText(key, fingerprint, text)
    return text
  })()
  pendingReads.set(pendingKey, request)
  try {
    return await request
  } finally {
    pendingReads.delete(pendingKey)
  }
}

export async function readMemoryDocuments(root: string, files: string[]): Promise<Array<{ path: string; text: string; doc: ParsedDoc }>> {
  return mapMemoryFiles(files, async path => {
    const file = resolve(root, path)
    const text = await readMemoryText(file)
    const cached = textCache.get(file)
    const doc = cached?.text === text ? cached.doc ?? (cached.doc = parseDoc(text)) : parseDoc(text)
    return { path, text, doc: structuredClone(doc) }
  })
}

type EntityKind = 'character' | 'location' | 'worldview' | 'item' | 'relationship' | 'timeline' | 'plot_point' | 'foreshadowing' | 'statistics'
interface IndexedEntity { id: string }
interface EntityIndex {
  fingerprint: string
  entities: IndexedEntity[]
  byId: Map<string, IndexedEntity>
  files: Map<string, string>
  bytes: number
}
const entityIndexes = new Map<string, EntityIndex>()
const sourcePaths: Record<EntityKind, string[]> = {
  character: ['记忆/人物', '设定/角色', '记忆系统/角色卡.md'],
  location: ['记忆/地点', '设定/世界观/地理.md', '记忆系统/地点档案.md'],
  worldview: ['记忆/世界观', '设定/世界观', '记忆系统/世界观设定.md'],
  item: ['记忆/道具'],
  relationship: ['记忆/关系', '设定/关系.md'],
  timeline: ['追踪/时间线.md'],
  plot_point: ['记忆/剧情点', '细纲'],
  foreshadowing: ['追踪/伏笔.md'],
  statistics: ['记忆', '设定', '追踪', '细纲', '记忆系统']
}

async function readDirectory(file: string, fingerprint: string): Promise<import('fs').Dirent[]> {
  const cached = directories.get(file)
  if (cached?.fingerprint === fingerprint && Date.now() - cached.checkedAt < DIRECTORY_RECHECK_MS) {
    directories.delete(file)
    directories.set(file, cached)
    return cached.entries.slice()
  }
  try {
    const entries = await fs.readdir(file, { withFileTypes: true })
    if (entries.length <= 20_000 && await memoryFileFingerprint(file) === fingerprint) {
      directories.set(file, { fingerprint, entries, checkedAt: Date.now() })
      while (directories.size > 1024 || [...directories.values()].reduce((total, entry) => total + entry.entries.length, 0) > 20_000) {
        directories.delete(directories.keys().next().value!)
      }
    }
    return entries.slice()
  } catch (error) {
    directories.delete(file)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function sourceFingerprint(projectDir: string, kind: EntityKind): Promise<{ fingerprint: string; files: Map<string, string> }> {
  const paths: string[] = []
  const fingerprints = new Map<string, string>()
  const visit = async (file: string): Promise<void> => {
    const fingerprint = await memoryFileFingerprint(file)
    fingerprints.set(resolve(file), fingerprint)
    paths.push(`${file}\0${fingerprint}`)
    if (fingerprint === 'missing' || file.endsWith('.md')) return
    const entries = await readDirectory(file, fingerprint)
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.isDirectory()) await visit(join(file, entry.name))
    }
    const files = entries.filter(entry => !entry.isDirectory() && entry.name.endsWith('.md')).map(entry => join(file, entry.name))
    paths.push(...await mapMemoryFiles(files, async source => {
      const signature = await memoryFileFingerprint(source)
      fingerprints.set(resolve(source), signature)
      return `${source}\0${signature}`
    }))
  }
  for (const source of sourcePaths[kind]) await visit(join(projectDir, source))
  return { fingerprint: JSON.stringify(paths), files: fingerprints }
}

async function loadIndex<Entity extends IndexedEntity>(projectDir: string, kind: EntityKind, load: () => Promise<Entity[]>): Promise<EntityIndex> {
  const key = `${resolve(projectDir)}\0${kind}`
  const { fingerprint, files } = await sourceFingerprint(projectDir, kind)
  const cached = entityIndexes.get(key)
  if (cached?.fingerprint === fingerprint) {
    entityIndexes.delete(key)
    entityIndexes.set(key, cached)
    return cached
  }
  const entities = await load()
  const index = { fingerprint, entities: structuredClone(entities), byId: new Map(entities.map(entity => [entity.id, entity])), files, bytes: Buffer.byteLength(JSON.stringify(entities), 'utf8') }
  if ((await sourceFingerprint(projectDir, kind)).fingerprint === fingerprint && index.bytes <= MAX_BYTES) {
    entityIndexes.set(key, index)
    while (entityIndexes.size > 64 || [...entityIndexes.values()].reduce((total, entry) => total + entry.bytes, 0) > MAX_BYTES) {
      entityIndexes.delete(entityIndexes.keys().next().value!)
    }
  }
  return index
}

export async function cachedMemoryList<Entity extends IndexedEntity>(projectDir: string, kind: EntityKind, load: () => Promise<Entity[]>): Promise<Entity[]> {
  return structuredClone((await loadIndex(projectDir, kind, load)).entities) as Entity[]
}

export async function memorySnapshot<Entity extends IndexedEntity>(projectDir: string, kind: EntityKind, load: () => Promise<Entity[]>): Promise<{ entities: Entity[]; fingerprints: Map<string, string> }> {
  const index = await loadIndex(projectDir, kind, load)
  return { entities: structuredClone(index.entities) as Entity[], fingerprints: new Map(index.files) }
}

export async function findMemoryEntity<Entity extends IndexedEntity>(projectDir: string, kind: EntityKind, load: () => Promise<Entity[]>, id: string): Promise<Entity | null> {
  return structuredClone((await loadIndex(projectDir, kind, load)).byId.get(id) ?? null) as Entity | null
}

export function invalidateMemoryProject(projectDir: string): void {
  const root = resolve(projectDir)
  for (const file of textCache.keys()) {
    if (file.startsWith(root + sep)) invalidateMemoryFile(file)
  }
  for (const key of entityIndexes.keys()) {
    if (key.startsWith(root + '\0')) entityIndexes.delete(key)
  }
  for (const directory of directories.keys()) {
    if (directory === root || directory.startsWith(root + sep)) directories.delete(directory)
  }
}
