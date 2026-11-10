import { recallNearbyProse, searchProsePassages } from './prose-search'
import { readLongformReviewState, blockedLongformChapters } from '../longform-review-state'
import { isRecentMemoryFileFingerprint, mapMemoryFiles, memoryFileFingerprint } from './repository-cache'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from '../atomic'
import { readText } from '../skill-format/md-parser'
import { expandCharacterAliasTerms, type CharacterAliasGroup } from './character-memory-context'

/** A recalled passage is evidence from a saved chapter, never an outline or an LLM summary. */
export interface ProseMemoryHit {
  chapterNumber: number
  /** Project-relative path, with forward slashes. */
  sourcePath: string
  text: string
  /** One-based lines and zero-based UTF-16 offsets; endOffset is exclusive. */
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  sourceHash: string
  score: number
  /** A supplementary nearby hit, linked to the primary hit by shared query terms. */
  nearby?: { primaryIndex: number; anchors: string[] }
}

export interface ProseMemoryQuery {
  text?: string
  characters?: string[]
  /** Explicit, unambiguous aliases filtered to the requested chapter. Retrieval only. */
  characterAliases?: CharacterAliasGroup[]
  props?: string[]
  locations?: string[]
  foreshadowings?: string[]
}

export interface ProseMemorySearchOptions {
  maxChars?: number
  maxResults?: number
  excludeChapters?: number[]
  /** Preserve adjacent narration for attribution and evidence within maxChars. */
  includeAdjacentParagraphs?: boolean
  /** Optional small, separate budget for passages in the three immediately preceding chapters. */
  nearbyFocus?: string
}

export interface ProseSource {
  chapterNumber: number
  sourcePath: string
  title: string
}

type Passage = Pick<ProseMemoryHit, 'text' | 'startLine' | 'endLine' | 'startOffset' | 'endOffset'>
export interface IndexedChapter extends ProseSource {
  /** Null until the file has been verified after its metadata has aged. */
  fingerprint: string | null
  sourceHash: string
  passages: Passage[]
}
interface StoredIndex {
  version: typeof INDEX_VERSION
  chapters: IndexedChapter[]
}

const INDEX_VERSION = 2
const MAX_PASSAGE_CHARS = 600
const READ_CONCURRENCY = 4
const STOP_WORDS = new Set(['他们', '她们', '我们', '自己', '一个', '这个', '那个', '什么', '没有', '已经', '开始', '继续', '本章', '剧情', '角色', '场景', 'the', 'and', 'with', 'from', 'that'])
const refreshes = new Map<string, Promise<StoredIndex>>()

/** Enumerate once and select one canonical prose file per chapter. */
export async function listProseSources(projectDir: string): Promise<ProseSource[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(join(projectDir, '正文'), { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const chosen = new Map<number, ProseSource & { rank: number }>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const skill = entry.name.match(/^第0*(\d+)章(.*)\.md$/)
    const legacy = entry.name.match(/^(\d+)\.md$/)
    if (!skill && !legacy) continue
    const chapterNumber = Number((skill ?? legacy)![1])
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) continue
    const paddedNumber = String(chapterNumber).padStart(3, '0')
    const prefix = `第${paddedNumber}章`
    // Match the editor's skill-file priority and its padded legacy fallback.
    // Imported nonstandard filenames can still supply evidence when there is no editor-readable copy.
    const rank = entry.name.startsWith(`${prefix} `) ? 0 : entry.name.startsWith(`${prefix}_`) ? 1
      : entry.name.startsWith(prefix) ? 2 : entry.name === `${paddedNumber}.md` ? 3 : skill ? 4 : 5
    if ((chosen.get(chapterNumber)?.rank ?? Infinity) <= rank) continue
    chosen.set(chapterNumber, { chapterNumber, sourcePath: `正文/${entry.name}`, title: skill?.[2].replace(/^[ _]/, '') ?? '', rank })
  }
  return [...chosen.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map(({ rank: _rank, ...source }) => source)
}

export function hashProse(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Exact excerpts, including their locations. Long paragraphs are split near a sentence boundary. */
export function splitProsePassages(text: string): Passage[] {
  const result: Passage[] = []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineAt = (offset: number): number => {
    let lo = 0
    let hi = lineStarts.length
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid
    }
    return lo + 1
  }
  for (const match of text.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g)) {
    const paragraph = match[0].trimEnd()
    if (!paragraph || /^#{1,6}\s+[^\r\n]+$/.test(paragraph)) continue
    let local = 0
    while (local < paragraph.length) {
      while (/\s/.test(paragraph[local] ?? '') && local < paragraph.length) local++
      if (local >= paragraph.length) break
      let end = Math.min(local + MAX_PASSAGE_CHARS, paragraph.length)
      if (end < paragraph.length) {
        const candidate = paragraph.slice(local, end)
        const boundary = Math.max(...['。', '！', '？', '；', '\n'].map((c) => candidate.lastIndexOf(c)))
        if (boundary >= MAX_PASSAGE_CHARS / 2) end = local + boundary + 1
        // Do not bisect an emoji/supplementary character.
        if (/[\uD800-\uDBFF]/.test(paragraph[end - 1])) end--
      }
      const exact = paragraph.slice(local, end).trimEnd()
      const startOffset = match.index! + local
      const endOffset = startOffset + exact.length
      if (exact) result.push({ text: exact, startOffset, endOffset, startLine: lineAt(startOffset), endLine: lineAt(endOffset - 1) })
      local = end
    }
  }
  return result
}

/** Incremental local index: every query checks the source directory and file metadata. */
export class ProseMemoryIndex {
  constructor(private readonly projectDir: string) {}

  async searchBefore(
    chapterNumber: number,
    query: string | ProseMemoryQuery,
    opts: ProseMemorySearchOptions = {}
  ): Promise<ProseMemoryHit[]> {
    const maxChars = Math.max(0, Math.min(12_000, Math.floor(opts.maxChars ?? 2400)))
    const maxResults = Math.max(0, Math.min(20, Math.floor(opts.maxResults ?? 6)))
    const request = typeof query === 'string' ? { text: query } : query
    const terms = queryTerms(request)
    if (chapterNumber <= 1 || !maxChars || !maxResults || terms.size === 0) return []
    const index = await this.readBefore(chapterNumber)
    const primaryHits = searchProsePassages(index, chapterNumber, terms, opts, maxChars, maxResults)
    const remaining = maxChars - primaryHits.reduce((total, hit) => total + hit.text.length, 0)
    const hits = opts.includeAdjacentParagraphs
      ? await this.addAdjacentParagraphs(index, primaryHits, Math.min(600, remaining)) : primaryHits
    if (opts.nearbyFocus === undefined || !hits.length) return hits
    const names = new Set([...(request.characters ?? []), ...expandCharacterAliasTerms(
      request.characters ?? [], request.text ?? '', request.characterAliases ?? []
    )].map(name => name.trim().toLocaleLowerCase()))
    const primaryTerms = hits.map(hit => new Set([...queryTerms({ text: hit.text }).keys()].filter(term => !names.has(term))))
    const focus = queryTerms({ text: opts.nearbyFocus })
    return [...hits, ...recallNearbyProse(index, chapterNumber, opts.excludeChapters ?? [], hits, primaryTerms, focus)]
  }

  private async addAdjacentParagraphs(index: IndexedChapter[], hits: ProseMemoryHit[], budget: number): Promise<ProseMemoryHit[]> {
    const sources = new Map(await mapMemoryFiles([...new Set(hits.map(hit => hit.sourcePath))], async path => {
      const source = await readText(join(this.projectDir, path))
      return [path, { source, hash: hashProse(source) }] as const
    }))
    const valid = hits.filter(hit => {
      const current = sources.get(hit.sourcePath)
      return current?.hash === hit.sourceHash && current.source.slice(hit.startOffset, hit.endOffset) === hit.text
    })
    const excerpts = [...valid]
    for (const [indexInHits, hit] of valid.entries()) {
      const { source } = sources.get(hit.sourcePath)!
      const passages = index.find(chapter => chapter.sourcePath === hit.sourcePath)!.passages
      const position = passages.findIndex(passage => passage.startOffset === hit.startOffset)
      if (position < 0) continue
      let { startOffset, endOffset, startLine, endLine } = hit
      for (const neighbor of [passages[position - 1], passages[position + 1]]) {
        if (!neighbor || /^(?:[*_—·-]\s*){3,}$/.test(neighbor.text)) continue
        const before = neighbor.endOffset <= startOffset
        const gap = before ? source.slice(neighbor.endOffset, startOffset) : source.slice(endOffset, neighbor.startOffset)
        const added = neighbor.text.length + gap.length
        if (added > budget || /\S/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 2) continue
        if (excerpts.some((other, positionInHits) => positionInHits !== indexInHits && other.sourcePath === hit.sourcePath &&
          other.startOffset < neighbor.endOffset && other.endOffset > neighbor.startOffset)) continue
        if (before) ({ startOffset, startLine } = neighbor)
        else ({ endOffset, endLine } = neighbor)
        budget -= added
      }
      excerpts[indexInHits] = { ...hit, startOffset, endOffset, startLine, endLine, text: source.slice(startOffset, endOffset) }
    }
    return excerpts
  }

  /** Validated saved prose, also used by long-term continuity recall without another full read. */
  async readBefore(chapterNumber: number, includePending = false): Promise<IndexedChapter[]> {
    // Share only an in-flight refresh. A later query always rechecks source metadata.
    const refreshKey = `${this.projectDir}|before:${chapterNumber}`
    let pending = refreshes.get(refreshKey)
    if (!pending) {
      pending = this.refresh(chapterNumber)
      refreshes.set(refreshKey, pending)
    }
    let index: StoredIndex
    try { index = await pending } finally {
      if (refreshes.get(refreshKey) === pending) refreshes.delete(refreshKey)
    }
    // Preserve identity for the search corpus cache in the common forward-writing case.
    const pendingReviews = includePending ? {} : blockedLongformChapters(await readLongformReviewState(this.projectDir))
    return index.chapters.some(chapter => chapter.chapterNumber >= chapterNumber || pendingReviews[String(chapter.chapterNumber)])
      ? index.chapters.filter(chapter => chapter.chapterNumber < chapterNumber && !pendingReviews[String(chapter.chapterNumber)]) : index.chapters
  }

  private async refresh(chapterNumber: number): Promise<StoredIndex> {
    const cachePath = join(this.projectDir, '.cache', 'prose-memory-index.json')
    const previous = await readStoredIndex(cachePath)
    const old = new Map(previous.chapters.map((c) => [c.sourcePath, c]))
    const allSources = await listProseSources(this.projectDir)
    const currentPaths = new Set(allSources.map((s) => s.sourcePath))
    const sources = allSources.filter((s) => s.chapterNumber < chapterNumber)
    // Preserve cached later chapters without reading them during an earlier-chapter request.
    // They are never searched here and will be revalidated when a later request needs them.
    const chapters: IndexedChapter[] = previous.chapters.filter((c) => c.chapterNumber >= chapterNumber && currentPaths.has(c.sourcePath))
    let changed = sources.length !== previous.chapters.filter((c) => c.chapterNumber < chapterNumber).length ||
      previous.chapters.some((c) => !currentPaths.has(c.sourcePath))
    // Bounded concurrency, deterministic chapter order, no LLM or remote index.
    for (let i = 0; i < sources.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(sources.slice(i, i + READ_CONCURRENCY).map(async (source) => {
        const file = join(this.projectDir, source.sourcePath)
        try {
          const fingerprint = await memoryFileFingerprint(file)
          if (fingerprint === 'missing') { changed = true; return null }
          const cached = old.get(source.sourcePath)
          const reusable = isRecentMemoryFileFingerprint(fingerprint) ? null : fingerprint
          if (reusable && cached?.fingerprint === reusable) return cached
          const text = await fs.readFile(file, 'utf8')
          // Source changed while reading: leave uncached and retry on the next query.
          if (fingerprint !== await memoryFileFingerprint(file)) { changed = true; return null }
          const sourceHash = hashProse(text)
          if (cached?.sourceHash === sourceHash && cached.fingerprint === reusable) return cached
          changed = true
          return { ...source, fingerprint: reusable, sourceHash,
            passages: cached?.sourceHash === sourceHash ? cached.passages : splitProsePassages(text) }
        } catch (err) {
          changed = true
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw err
        }
      }))
      chapters.push(...batch.filter((c): c is IndexedChapter => c !== null))
    }
    const result: StoredIndex = { version: INDEX_VERSION, chapters: chapters.sort((a, b) => a.chapterNumber - b.chapterNumber) }
    if (changed) {
      try { await writeJsonAtomic(cachePath, result) } catch { /* Read-only projects can still recall from this in-memory refresh. */ }
    }
    if (!changed && result.chapters.length === previous.chapters.length &&
        result.chapters.every((chapter, index) => chapter === previous.chapters[index])) return previous
    return result
  }
}

const storedIndexes = new Map<string, { fingerprint: string; index: StoredIndex; bytes: number }>()

async function readStoredIndex(file: string): Promise<StoredIndex> {
  try {
    const before = await memoryFileFingerprint(file)
    const cached = storedIndexes.get(file)
    if (cached?.fingerprint === before) {
      storedIndexes.delete(file)
      storedIndexes.set(file, cached)
      return cached.index
    }
    const text = await fs.readFile(file, 'utf8')
    const stored = JSON.parse(text) as StoredIndex
    const index: StoredIndex = { version: INDEX_VERSION, chapters: stored.version === INDEX_VERSION && Array.isArray(stored.chapters)
      ? stored.chapters.filter(validIndexedChapter) : [] }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (await memoryFileFingerprint(file) === before && bytes <= 16 * 1024 * 1024) {
      storedIndexes.set(file, { fingerprint: before, index, bytes })
      while (storedIndexes.size > 4 || [...storedIndexes.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 16 * 1024 * 1024) {
        storedIndexes.delete(storedIndexes.keys().next().value!)
      }
    }
    return index
  } catch {
    storedIndexes.delete(file)
    return { version: INDEX_VERSION, chapters: [] }
  }
}

function validIndexedChapter(c: IndexedChapter): boolean {
  return Boolean(c && Number.isSafeInteger(c.chapterNumber) && typeof c.sourcePath === 'string' &&
    typeof c.sourceHash === 'string' && (c.fingerprint === null || typeof c.fingerprint === 'string') && Array.isArray(c.passages) &&
    c.passages.every((p) => p && typeof p.text === 'string' && Number.isSafeInteger(p.startOffset) && Number.isSafeInteger(p.endOffset) && Number.isSafeInteger(p.startLine) && Number.isSafeInteger(p.endLine)))
}

function queryTerms(query: ProseMemoryQuery): Map<string, number> {
  const terms = new Map<string, number>()
  const add = (raw: string, weight: number) => {
    const term = raw.trim().toLocaleLowerCase()
    if (term.length < 2 || term.length > 40 || STOP_WORDS.has(term)) return
    if (terms.size >= 200 && !terms.has(term)) return
    terms.set(term, Math.max(terms.get(term) ?? 0, weight))
  }
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const tokenize = (raw: string, weight: number) => {
    for (const part of segmenter.segment(raw.slice(0, 8000))) {
      if (part.isWordLike) add(part.segment, weight)
      if (terms.size >= 200) break
    }
  }
  // Entity/prop phrases get priority before the longer outline text consumes the token budget.
  for (const [values, weight] of [[query.props, 4], [query.locations, 4], [query.characters, 3], [query.foreshadowings, 2]] as const) {
    for (const value of (values ?? []).slice(0, 30)) { add(value, weight); tokenize(value, weight) }
  }
  // Use a label as a whole; splitting an alias into a surname/title would merge unrelated people.
  for (const label of expandCharacterAliasTerms(query.characters ?? [], query.text ?? '', query.characterAliases ?? [])) {
    add(label, 3)
  }
  tokenize(query.text ?? '', 1)
  return terms
}
