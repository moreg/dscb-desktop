import { promises as fs } from 'fs'
import path from 'path'
import { writeJsonAtomic } from '../atomic'
import type { FanqieChartBook } from '../../../shared/fanqie-chart'
import { parseFanqieChartType } from '../../../shared/fanqie-chart'
import { fixCoverUrl } from './parse'

const INDEX_FILENAME = '_index.json'
const INDEX_VERSION = 1
const MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_TARGET_PATH = 240
const CONCURRENCY = 4
const IMAGE_EXTS = ['.jpg', '.png', '.webp', '.gif'] as const
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ALLOWED_HOSTS = new Set(['fanqienovel.com', 'www.fanqienovel.com'])
const ALLOWED_SUFFIXES = [
  '.byteimg.com',
  '.bytedance.com',
  '.toutiaoimg.com',
  '.pstatp.com',
  '.snssdk.com',
  '.fanqiesdk.com',
  '.fanqienovel.com',
  '.fqnovelpic.com'
]

const INVALID_PATH = /[\\/:*?"<>|\u0000-\u001f]+/g
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])

export interface CoverSaveResult {
  saved: number
  skipped: number
  failed: number
  /** 这次榜单里，已经有本地文件的书。文件可能在别的分类目录。 */
  stored: number
  /** 有文件落在这个榜单目录时，给出该目录；否则是封面根目录。 */
  directory: string
}

interface CoverIndex {
  version: number
  books: Record<string, { title: string; paths: string[]; bytes?: number; savedAt?: string }>
  stems: Record<string, string>
}

interface DownloadJob {
  bookId: string
  title: string
  url: string
  stem: string
  key: string
}

export type CoverFetch = (url: string, init: RequestInit) => Promise<Response>

export function isAllowedCoverUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (ALLOWED_HOSTS.has(host)) return true
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

export function sanitizePathPart(name: string, fallback: string): string {
  const part = name.replace(INVALID_PATH, '_').trim().replace(/[. ]+$/g, '').slice(0, 80)
  if (!part || part === '.' || part === '..' || RESERVED.has(part.toUpperCase())) return fallback
  return part
}

export function sniffCoverImage(content: Buffer, contentType: string | null): string {
  if (content.length < 12) throw new Error('封面内容无效')
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return '.jpg'
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  const gif = content.subarray(0, 6).toString('ascii')
  if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif'
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  const head = content.subarray(0, 8).toString('utf8').trimStart()
  if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) throw new Error('封面不是有效图片')
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  const mapped: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  }
  const ext = mapped[type]
  if (!ext) throw new Error('封面不是有效图片')
  return ext
}

function emptyIndex(): CoverIndex {
  return { version: INDEX_VERSION, books: {}, stems: {} }
}

async function loadIndex(root: string): Promise<CoverIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, INDEX_FILENAME), 'utf-8')) as Partial<CoverIndex>
    const books = raw.books && typeof raw.books === 'object' ? raw.books : {}
    const stems = raw.stems && typeof raw.stems === 'object' ? raw.stems : {}
    return { version: INDEX_VERSION, books, stems }
  } catch {
    return emptyIndex()
  }
}

function fitStem(dir: string, stem: string): string {
  const budget = MAX_TARGET_PATH - dir.length - 1 - 5
  if (budget >= stem.length) return stem
  return stem.slice(0, Math.max(budget, 8))
}

async function existingFile(dir: string, stem: string): Promise<string | null> {
  for (const ext of IMAGE_EXTS) {
    const file = path.join(dir, `${stem}${ext}`)
    try {
      await fs.access(file)
      return file
    } catch {
      // 这个扩展名没有文件
    }
  }
  return null
}

async function writeNewFile(file: string, data: Buffer): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
  return true
}

function recordFile(index: CoverIndex, bookId: string, root: string, file: string, title: string, size: number): void {
  const rel = path.relative(root, file).split(path.sep).join('/')
  const entry = index.books[bookId] ?? { title, paths: [] }
  entry.title = title || entry.title
  if (!entry.paths.includes(rel)) entry.paths.push(rel)
  entry.bytes = size
  entry.savedAt = new Date().toISOString()
  index.books[bookId] = entry
}

async function downloadCover(url: string, fetchImpl: CoverFetch): Promise<{ bytes: Buffer; ext: string }> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedCoverUrl(current)) throw new Error('封面来源域名不被允许')
    const response = await fetchImpl(current, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://fanqienovel.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('封面重定向无效')
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) throw new Error(`封面下载失败: HTTP ${response.status}`)
    const finalUrl = response.url || current
    if (!isAllowedCoverUrl(finalUrl)) throw new Error('封面来源域名不被允许')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('封面文件过大')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_BYTES) throw new Error('封面文件过大')
    return { bytes, ext: sniffCoverImage(bytes, response.headers.get('content-type')) }
  }
  throw new Error('封面重定向次数过多')
}

async function mapPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await work(item)
    }
  })
  await Promise.all(workers)
}

export async function saveChartCovers(input: {
  root: string
  chartType: string
  books: FanqieChartBook[]
  fetchImpl?: CoverFetch
  onProgress?: (message: string) => void
}): Promise<CoverSaveResult> {
  const root = path.resolve(input.root)
  const parsed = parseFanqieChartType(input.chartType)
  const chartName = sanitizePathPart(parsed.chartLabel, '未知榜单')
  const categoryName = sanitizePathPart(parsed.categoryLabel, '未分类')
  const directory = path.resolve(root, chartName, categoryName)
  const relative = path.relative(root, directory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('封面目录越出了保存根目录')
  }

  const result: CoverSaveResult = { saved: 0, skipped: 0, failed: 0, stored: 0, directory: root }
  const index = await loadIndex(root)
  const reserved = new Set<string>()
  const jobs: DownloadJob[] = []
  let dirty = false

  const remember = (bookId: string, title: string, file: string, size: number, key: string): void => {
    recordFile(index, bookId, root, file, title, size)
    index.stems[key] = bookId
    dirty = true
    result.stored += 1
    if (path.dirname(file) === directory) result.directory = directory
  }

  for (const book of input.books) {
    const bookId = book.bookId.trim()
    const cover = fixCoverUrl(book.cover)
    if (!bookId || !cover) {
      result.skipped += 1
      continue
    }
    const recorded = index.books[bookId]?.paths ?? []
    const alive: string[] = []
    for (const rel of recorded) {
      const file = path.resolve(root, ...rel.split('/'))
      const fromRoot = path.relative(root, file)
      if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) continue
      try {
        await fs.access(file)
        alive.push(file)
      } catch {
        // 索引还在，文件已经不在
      }
    }
    if (alive.length > 0) {
      result.skipped += 1
      result.stored += 1
      if (alive.some((file) => path.dirname(file) === directory)) result.directory = directory
      continue
    }

    let stem = fitStem(directory, sanitizePathPart(book.title, `book_${bookId}`))
    let key = stem
    const owner = index.stems[key]
    if (owner && owner !== bookId) {
      stem = fitStem(directory, sanitizePathPart(`${stem}_${bookId}`, `book_${bookId}`))
      key = stem
      if (index.stems[key] && index.stems[key] !== bookId) {
        result.skipped += 1
        continue
      }
    }
    if (reserved.has(key)) {
      result.skipped += 1
      continue
    }
    const found = await existingFile(directory, stem)
    if (found) {
      const stat = await fs.stat(found)
      remember(bookId, book.title, found, stat.size, key)
      result.skipped += 1
      continue
    }
    reserved.add(key)
    jobs.push({ bookId, title: book.title, url: cover, stem, key })
  }

  if (jobs.length > 0) input.onProgress?.('正在保存封面')
  const fetchImpl = input.fetchImpl ?? fetch
  await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      const image = await downloadCover(job.url, fetchImpl)
      const file = path.join(directory, `${job.stem}${image.ext}`)
      const written = await writeNewFile(file, image.bytes)
      const stat = await fs.stat(file)
      remember(job.bookId, job.title, file, stat.size, job.key)
      if (written) result.saved += 1
      else result.skipped += 1
    } catch (err) {
      result.failed += 1
      console.warn(`封面保存失败 bookId=${job.bookId}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      reserved.delete(job.key)
    }
  })

  if (dirty) await writeJsonAtomic(path.join(root, INDEX_FILENAME), index)
  if (result.saved > 0 || result.failed > 0) {
    const failed = result.failed > 0 ? `，${result.failed} 张失败` : ''
    input.onProgress?.(`封面保存 ${result.saved} 张${failed}`)
  }
  return result
}
