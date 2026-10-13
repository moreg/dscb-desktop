import type { ProseMemoryHit, ProseMemorySearchOptions } from './prose-memory-index'

interface SearchChapter {
  chapterNumber: number
  sourcePath: string
  sourceHash: string
  passages: Array<Pick<ProseMemoryHit, 'text' | 'startLine' | 'endLine' | 'startOffset' | 'endOffset'>>
}
interface SearchPassage {
  chapter: SearchChapter
  passage: SearchChapter['passages'][number]
  normalized: string
}
interface SearchCorpus {
  passages: SearchPassage[]
  grams: Map<string, number[]>
  bytes: number
}
interface RankedPassage {
  id: number
  hit: ProseMemoryHit
}
const corpora = new Map<SearchChapter[], SearchCorpus>()
const MAX_CACHE_BYTES = 32 * 1024 * 1024

function trimCorpora(): void {
  while (corpora.size > 4 || [...corpora.values()].reduce((sum, entry) => sum + entry.bytes, 0) > MAX_CACHE_BYTES) {
    corpora.delete(corpora.keys().next().value!)
  }
}

function corpusFor(chapters: SearchChapter[]): SearchCorpus {
  const cached = corpora.get(chapters)
  if (cached) {
    corpora.delete(chapters)
    corpora.set(chapters, cached)
    return cached
  }
  const corpus: SearchCorpus = { passages: [], grams: new Map(), bytes: 0 }
  for (const chapter of chapters) {
    for (const passage of chapter.passages) {
      const normalized = passage.text.toLocaleLowerCase()
      corpus.passages.push({ chapter, passage, normalized })
      corpus.bytes += normalized.length * 2 + 64
    }
  }
  if (corpus.bytes <= MAX_CACHE_BYTES) {
    corpora.set(chapters, corpus)
    trimCorpora()
  }
  return corpus
}

function postingsFor(corpus: SearchCorpus, gram: string): number[] {
  const cached = corpus.grams.get(gram)
  if (cached) {
    corpus.grams.delete(gram)
    corpus.grams.set(gram, cached)
    return cached
  }
  const postings: number[] = []
  for (let id = 0; id < corpus.passages.length; id++) {
    if (corpus.passages[id].normalized.includes(gram)) postings.push(id)
  }
  corpus.grams.set(gram, postings)
  corpus.bytes += gram.length * 2 + 64 + postings.length * 8
  while (corpus.grams.size > 256) {
    const oldest = corpus.grams.keys().next().value!
    corpus.bytes -= oldest.length * 2 + 64 + corpus.grams.get(oldest)!.length * 8
    corpus.grams.delete(oldest)
  }
  trimCorpora()
  return postings
}

function compare(first: RankedPassage, second: RankedPassage): number {
  return second.hit.score - first.hit.score || second.hit.chapterNumber - first.hit.chapterNumber ||
    first.hit.startOffset - second.hit.startOffset || first.id - second.id
}

function siftDown(heap: RankedPassage[], start: number): void {
  let parent = start
  for (;;) {
    const left = parent * 2 + 1
    if (left >= heap.length) return
    const right = left + 1
    const best = right < heap.length && compare(heap[right], heap[left]) < 0 ? right : left
    if (compare(heap[parent], heap[best]) <= 0) return
    const previous = heap[parent]
    heap[parent] = heap[best]
    heap[best] = previous
    parent = best
  }
}

export function searchProsePassages(
  chapters: SearchChapter[],
  chapterNumber: number,
  terms: Map<string, number>,
  options: ProseMemorySearchOptions,
  maxChars: number,
  maxResults: number
): ProseMemoryHit[] {
  const corpus = corpusFor(chapters)
  const excluded = new Set(options.excludeChapters ?? [])
  const eligible = (entry: SearchPassage) => entry.chapter.chapterNumber < chapterNumber && !excluded.has(entry.chapter.chapterNumber)
  const totalPassages = corpus.passages.reduce((count, passage) => count + Number(eligible(passage)), 0)
  const scores = new Map<number, number>()
  for (const [term, weight] of terms) {
    let postings = postingsFor(corpus, term.slice(0, 2))
    for (let offset = 1; offset + 1 < term.length; offset++) {
      const candidates = corpus.grams.get(term.slice(offset, offset + 2))
      if (candidates && candidates.length < postings.length) postings = candidates
    }
    const matches = postings.filter(id => eligible(corpus.passages[id]) && corpus.passages[id].normalized.includes(term))
    const score = weight * Math.log(1 + totalPassages / (matches.length || 1))
    for (const id of matches) scores.set(id, (scores.get(id) ?? 0) + score)
  }
  const ranked: RankedPassage[] = []
  for (const [id, score] of scores) {
    const { chapter, passage } = corpus.passages[id]
    const candidate: RankedPassage = {
      id,
      hit: { ...passage, chapterNumber: chapter.chapterNumber, sourcePath: chapter.sourcePath, sourceHash: chapter.sourceHash, score }
    }
    ranked.push(candidate)
  }
  for (let parent = Math.floor(ranked.length / 2) - 1; parent >= 0; parent--) siftDown(ranked, parent)
  const result: ProseMemoryHit[] = []
  const seen = new Set<string>()
  let remaining = maxChars
  while (ranked.length && result.length < maxResults && remaining > 0) {
    const { hit } = ranked[0]
    const last = ranked.pop()!
    if (ranked.length) {
      ranked[0] = last
      siftDown(ranked, 0)
    }
    if (hit.score <= 0) break
    const key = hit.text.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    const text = hit.text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
    if (!text) continue
    result.push({ ...hit, text, endOffset: hit.startOffset + text.length, endLine: hit.startLine + (text.match(/\n/g)?.length ?? 0) })
    remaining -= text.length
  }
  return result
}
