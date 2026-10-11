import type { FanqieChartBase, FanqieChartBook } from '../../../shared/fanqie-chart'
import { fanqieChartPageUrl } from '../../../shared/fanqie-chart'

const DEFAULT_COVER_HASH = '5cb03bd354145bc7815a5e09d4b15cfc'
const PUA = /[\uE000-\uF8FF]/

export function localDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatReadCount(value: unknown): string {
  if (value == null || value === '') return ''
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
  }
  const matched = raw.match(/(\d+(?:\.\d+)?)/)
  if (!matched) return raw
  if (raw.includes('万') || matched[1].includes('.')) return `${matched[1]}万`
  const n = Number(matched[1])
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

export function fixCoverUrl(url: unknown): string {
  if (typeof url !== 'string') return ''
  let next = url.trim()
  if (next.startsWith('//')) next = `https:${next}`
  if (!next || next.includes(DEFAULT_COVER_HASH)) return ''
  return next
}

function asTags(raw: unknown, genre: unknown): string[] {
  const parts: string[] = []
  if (typeof genre === 'string' && genre.trim() && !/^\d+$/.test(genre.trim())) parts.push(genre.trim())
  const list = typeof raw === 'string' ? raw.split(/[,，、/|]/) : Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!tag || /^\d+$/.test(tag) || PUA.test(tag) || parts.includes(tag)) continue
    parts.push(tag)
  }
  return parts
}

function creationStatus(value: unknown): string {
  const text = value == null ? '' : String(value).trim()
  if (text === '0') return '完结'
  if (text === '1') return '连载'
  return text
}

export function parseRankBooks(payload: unknown, startRank = 1): FanqieChartBook[] {
  const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined
  const root = data && typeof data === 'object' ? (data as { book_list?: unknown; list?: unknown }) : {}
  const list = Array.isArray(root.book_list) ? root.book_list : Array.isArray(root.list) ? root.list : []
  const books: FanqieChartBook[] = []
  const seen = new Set<string>()
  let rank = startRank
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const bookId = String(row.bookId ?? row.book_id ?? '').trim()
    if (!bookId || seen.has(bookId)) continue
    seen.add(bookId)
    const title = String(row.bookName ?? row.title ?? '').trim()
    const intro = String(row.abstract ?? row.intro ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 500)
    books.push({
      rank,
      bookId,
      title,
      author: String(row.author ?? row.authorName ?? '').trim(),
      cover: fixCoverUrl(row.thumbUri ?? row.cover),
      genre: String(row.category ?? '').trim(),
      wordCount: row.wordNumber != null && String(row.wordNumber) !== '' ? String(row.wordNumber) : '',
      readCount: formatReadCount(row.read_count ?? row.readCount ?? row.readerCount ?? ''),
      intro,
      tags: asTags(row.tags, row.category),
      url: `https://fanqienovel.com/page/${bookId}`,
      status: creationStatus(row.creationStatus ?? row.status),
      garbled: false
    })
    rank += 1
  }
  return books
}

export function extractFontUrls(html: string): string[] {
  const found = html.match(/https?:\/\/[^"')\s]+?\.woff2?/g) ?? []
  const unique: string[] = []
  for (const url of found) {
    if (!unique.includes(url)) unique.push(url)
  }
  unique.sort((a, b) => Number(b.endsWith('.woff')) - Number(a.endsWith('.woff')))
  return unique
}

export function rankApiUrl(pageUrl: string, offset: number, limit = 10): string {
  const last = pageUrl.replace(/\/+$/, '').split('/').pop() ?? ''
  const [gender, rankMold, categoryId] = last.split('_')
  if (!gender || !rankMold || !categoryId) throw new Error('榜单地址无法解析')
  const params = new URLSearchParams({
    app_id: '2503',
    rank_list_type: '3',
    offset: String(offset),
    limit: String(limit),
    category_id: categoryId,
    rank_version: '',
    gender,
    rankMold
  })
  return `https://fanqienovel.com/api/rank/category/list?${params.toString()}`
}

export function pageUrlOf(base: FanqieChartBase, categoryId: string): string {
  return fanqieChartPageUrl(base, categoryId)
}

const TITLE_FIXES: Array<[string, string]> = [
  ['生角', '主角'],
  ['女生角', '女主角'],
  ['男生角', '男主角'],
  ['生人公', '主人公'],
  ['奶统', '系统'],
  ['好统', '系统']
]

export function correctTitle(title: string): string {
  let next = title
  for (const [from, to] of TITLE_FIXES) next = next.replaceAll(from, to)
  return next
}

function isPrivate(ch: string): boolean {
  const cp = ch.charCodeAt(0)
  return cp >= 0xe000 && cp <= 0xf8ff
}

/**
 * 用字体映射还原文本。映射不到的字，在允许丢弃的数量内删掉，超出的换成 □。
 * 书名不允许丢字，一个对不上就留 □，避免把书名改成另一个词。
 */
export function restoreText(
  text: string,
  map: ReadonlyMap<number, string>,
  maxDrop: number
): string {
  let dropped = 0
  let out = ''
  for (const ch of text) {
    if (!isPrivate(ch)) {
      out += ch
      continue
    }
    const replacement = map.get(ch.charCodeAt(0))
    if (replacement) {
      out += replacement
      continue
    }
    dropped += 1
    if (dropped > maxDrop) out += '□'
  }
  return out
}

export function hasPrivateOrBox(text: string): boolean {
  return /[\uE000-\uF8FF□]/.test(text)
}

export function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

export function restoreBook(book: FanqieChartBook, map: ReadonlyMap<number, string>): FanqieChartBook {
  const title = correctTitle(restoreText(book.title, map, 0)).trim()
  const author = restoreText(book.author, map, 1).trim()
  const intro = restoreText(book.intro, map, 4).trim()
  const genre = restoreText(book.genre, map, 0).trim()
  const tags = book.tags
    .map((tag) => restoreText(tag, map, 0).trim())
    .filter((tag) => tag && !hasPrivateOrBox(tag))
  const garbled = !hasCjk(title) || hasPrivateOrBox(title)
  return {
    ...book,
    title: garbled && !hasCjk(title) ? '（书名未还原）' : title,
    author: hasPrivateOrBox(author) ? '' : author,
    intro: hasPrivateOrBox(intro) ? '' : intro,
    genre: hasPrivateOrBox(genre) ? '' : genre,
    tags,
    garbled
  }
}

export function collectPrivateChars(books: FanqieChartBook[]): string[] {
  const seen = new Set<string>()
  for (const book of books) {
    const blob = `${book.title}${book.author}${book.intro}${book.genre}${book.tags.join('')}`
    for (const ch of blob) {
      if (isPrivate(ch)) seen.add(ch)
    }
  }
  return [...seen]
}
