import { deflateRawSync, inflateRawSync } from 'zlib'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join, resolve, sep } from 'path'
import { readAppProjectIdentity } from './skill-format/library-scanner'
import { parseDoc, readText } from './skill-format/md-parser'
import { extractBookName } from './skill-format/project-skill-repo'
import { toFolderName } from './folder-name'

const MAX_FILE_BYTES = 80 * 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 10_000

interface ZipEntry {
  name: string
  data: Buffer
}

/** 把一本小说目录打成 zip。压缩包里有一层以文件夹名命名的根目录。 */
export async function writeProjectPackage(projectDir: string, zipPath: string): Promise<void> {
  const rootName = basename(projectDir)
  const entries = await collectProjectFiles(projectDir, rootName)
  if (!entries.some((entry) => !entry.name.endsWith('/'))) {
    throw new Error('这本小说没有可以导出的文件')
  }
  const partial = `${zipPath}.${randomUUID()}.partial`
  await fs.mkdir(dirname(zipPath), { recursive: true })
  try {
    await fs.writeFile(partial, encodeZip(entries))
    await fs.rename(partial, zipPath)
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 把小说包解到作品目录下的新文件夹。
 * 已有同名文件夹时改用「书名-2」，不覆盖原来的书。
 */
export async function extractProjectPackage(zipPath: string, projectsRoot: string): Promise<string> {
  const zip = await fs.readFile(zipPath)
  const entries = stripSingleRoot(readZipEntries(zip))
  if (entries.length === 0) throw new Error('这不是大神持笔的小说包')
  await fs.mkdir(projectsRoot, { recursive: true })
  const staging = join(projectsRoot, `.import-${randomUUID()}`)
  await fs.mkdir(staging)
  try {
    let total = 0
    for (const entry of entries) {
      const relative = safeRelativeName(entry.name)
      if (!relative) throw new Error('小说包里的路径不安全')
      total += entry.data.length
      if (entry.data.length > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES) {
        throw new Error('小说包过大')
      }
      const target = resolve(staging, ...relative.split('/'))
      if (target !== staging && !target.startsWith(staging + sep)) {
        throw new Error('小说包里的路径不安全')
      }
      if (relative.endsWith('/')) {
        await fs.mkdir(target, { recursive: true })
        continue
      }
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, entry.data)
    }
    const bookName = await projectBookName(staging)
    const folder = toFolderName(bookName) || '导入的小说'
    const destination = await uniqueDirectory(projectsRoot, folder)
    await fs.rename(staging, destination)
    return destination
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function encodeZip(entries: ZipEntry[]): Buffer {
  const now = dosDateTime(new Date())
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    if (name.length > 0xffff) throw new Error('小说包里的文件名过长')
    const crc = crc32(entry.data)
    const { method, compressed } = compress(entry.data)
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(method),
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(compressed.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
      compressed
    ])
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(method),
      u16(now.time),
      u16(now.date),
      u32(crc),
      u32(compressed.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0)
  ])
  return Buffer.concat([...locals, centralDir, eocd])
}

export function readZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.length > MAX_PACKAGE_BYTES) throw new Error('小说包过大')
  const eocd = findEocd(zip)
  const count = zip.readUInt16LE(eocd + 10)
  const centralSize = zip.readUInt32LE(eocd + 12)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('小说包使用了不支持的压缩方式')
  }
  if (count > MAX_ENTRIES) throw new Error('小说包过大')
  const entries: ZipEntry[] = []
  let cursor = centralOffset
  const centralEnd = centralOffset + centralSize
  let total = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('小说包已损坏')
    }
    const flags = zip.readUInt16LE(cursor + 8)
    const method = zip.readUInt16LE(cursor + 10)
    const crc = zip.readUInt32LE(cursor + 16)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const size = zip.readUInt32LE(cursor + 24)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (cursor > centralEnd) throw new Error('小说包已损坏')
    if ((flags & 1) !== 0) throw new Error('小说包使用了不支持的压缩方式')
    if (!safeRelativeName(name)) throw new Error('小说包里的路径不安全')
    if (size > MAX_FILE_BYTES || compressedSize > MAX_PACKAGE_BYTES) throw new Error('小说包过大')
    total += size
    if (total > MAX_PACKAGE_BYTES) throw new Error('小说包过大')
    const data = readLocalEntry(zip, localOffset, method, compressedSize, size, crc)
    entries.push({ name, data })
  }
  return entries
}

async function collectProjectFiles(projectDir: string, rootName: string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  let total = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const children = await fs.readdir(dir, { withFileTypes: true })
    for (const child of children) {
      if (child.isSymbolicLink()) continue
      const name = `${prefix}/${child.name}`
      const full = join(dir, child.name)
      if (child.isDirectory()) {
        entries.push({ name: `${name}/`, data: Buffer.alloc(0) })
        await walk(full, name)
        continue
      }
      if (!child.isFile()) continue
      const data = await fs.readFile(full)
      total += data.length
      if (data.length > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES || entries.length >= MAX_ENTRIES) {
        throw new Error('小说包过大')
      }
      entries.push({ name, data })
    }
  }
  await walk(projectDir, rootName)
  return entries
}

async function projectBookName(dir: string): Promise<string> {
  const identity = await readAppProjectIdentity(dir)
  if (identity) return identity.name
  const outline = await readText(join(dir, '大纲', '大纲.md'))
  if (!outline?.trim()) throw new Error('这不是大神持笔的小说包')
  return extractBookName(parseDoc(outline).h1Title) || '导入的小说'
}

async function uniqueDirectory(parent: string, base: string): Promise<string> {
  for (let index = 1; index < 1000; index++) {
    const name = index === 1 ? base : `${base}-${index}`
    const dir = join(parent, name)
    try {
      await fs.access(dir)
    } catch {
      return dir
    }
  }
  throw new Error('无法确定导入目录')
}

function stripSingleRoot(entries: ZipEntry[]): ZipEntry[] {
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]).filter(Boolean))
  if (tops.size !== 1) return entries
  const root = [...tops][0]
  const prefix = `${root}/`
  if (!entries.every((entry) => entry.name === root || entry.name.startsWith(prefix))) return entries
  return entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }))
    .filter((entry) => entry.name.length > 0)
}

function safeRelativeName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const directory = normalized.endsWith('/')
  const parts = normalized.split('/').filter((part) => part.length > 0)
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) return null
  return `${parts.join('/')}${directory ? '/' : ''}`
}

function readLocalEntry(
  zip: Buffer,
  offset: number,
  method: number,
  compressedSize: number,
  size: number,
  expectedCrc: number
): Buffer {
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error('小说包已损坏')
  }
  const nameLength = zip.readUInt16LE(offset + 26)
  const extraLength = zip.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + compressedSize
  if (end > zip.length) throw new Error('小说包已损坏')
  const compressed = zip.subarray(start, end)
  let data: Buffer
  if (method === 0) {
    data = Buffer.from(compressed)
  } else if (method === 8) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: size })
    } catch {
      throw new Error('小说包已损坏')
    }
  } else {
    throw new Error('小说包使用了不支持的压缩方式')
  }
  if (data.length !== size || crc32(data) !== expectedCrc) throw new Error('小说包已损坏')
  return data
}

function compress(data: Buffer): { method: number; compressed: Buffer } {
  if (data.length === 0) return { method: 0, compressed: data }
  const deflated = deflateRawSync(data, { level: 9 })
  if (deflated.length < data.length) return { method: 8, compressed: deflated }
  return { method: 0, compressed: data }
}

function findEocd(zip: Buffer): number {
  const min = Math.max(0, zip.length - 22 - 0xffff)
  for (let offset = zip.length - 22; offset >= min; offset--) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = zip.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === zip.length) return offset
  }
  throw new Error('小说包已损坏')
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index++) {
    value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff)
  return buffer
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}
