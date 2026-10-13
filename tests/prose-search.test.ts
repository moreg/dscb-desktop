import { describe, expect, it } from 'vitest'
import { searchProsePassages } from '../src/main/data/memory/prose-search'
import { splitProsePassages, hashProse, type ProseMemoryHit } from '../src/main/data/memory/prose-memory-index'

function chapter(number: number, text: string) {
  return { chapterNumber: number, sourcePath: '正文/' + number + '.md', sourceHash: hashProse(text), passages: splitProsePassages(text) }
}

function reference(chapters: ReturnType<typeof chapter>[], before: number, terms: Map<string, number>, maxChars: number, maxResults: number, excludeChapters: number[]): ProseMemoryHit[] {
  const candidates = chapters.filter(entry => entry.chapterNumber < before && !excludeChapters.includes(entry.chapterNumber))
    .flatMap(entry => entry.passages.map(passage => ({ ...passage, chapterNumber: entry.chapterNumber, sourcePath: entry.sourcePath, sourceHash: entry.sourceHash, score: 0 })))
  const frequencies = new Map<string, number>()
  for (const candidate of candidates) {
    for (const term of terms.keys()) {
      if (candidate.text.toLocaleLowerCase().includes(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    }
  }
  for (const candidate of candidates) {
    for (const [term, weight] of terms) {
      if (candidate.text.toLocaleLowerCase().includes(term)) candidate.score += weight * Math.log(1 + candidates.length / (frequencies.get(term) ?? 1))
    }
  }
  candidates.sort((first, second) => second.score - first.score || second.chapterNumber - first.chapterNumber || first.startOffset - second.startOffset)
  const results: ProseMemoryHit[] = []
  const seen = new Set<string>()
  let remaining = maxChars
  for (const candidate of candidates) {
    if (candidate.score <= 0 || results.length >= maxResults || remaining <= 0) break
    const key = candidate.text.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    const text = candidate.text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
    if (!text) continue
    results.push({ ...candidate, text, endOffset: candidate.startOffset + text.length, endLine: candidate.startLine + (text.match(/\n/g)?.length ?? 0) })
    remaining -= text.length
  }
  return results
}

describe('indexed prose ranking', () => {
  it('matches exhaustive ranking, deduplication, exclusions and UTF-16 truncation', () => {
    const text = ['😀阿宁收起令牌。', '阿宁将信封交给沈清秋。', '秘令与牌匾分放两处。', 'MAGIC令牌仍在桥下。\n细雨未停。', '阿宁 将信封交给沈清秋。']
    const chapters = Array.from({ length: 30 }, (_, index) => chapter(index + 1, [text[index % text.length], text[(index * 3 + 1) % text.length]].join('\n\n')))
    const queries = [
      new Map([['阿宁', 3], ['令牌', 4], ['沈清秋', 3]]),
      new Map([['magic', 4], ['令牌', 1]]),
      new Map([['秘令', 2], ['牌匾', 2]]),
      new Map([['😀', 3], ['阿宁', 1]])
    ]
    for (const terms of queries) {
      for (const before of [2, 10, 31]) {
        for (const maxChars of [1, 2, 7, 20, 70, 2400]) {
          for (const maxResults of [1, 3, 20]) {
            const excludeChapters = [3, 7, 9, 25]
            expect(searchProsePassages(chapters, before, terms, { excludeChapters }, maxChars, maxResults))
              .toEqual(reference(chapters, before, terms, maxChars, maxResults, excludeChapters))
          }
        }
      }
    }
  })

  it('does not treat separated gram matches as a phrase occurrence', () => {
    const chapters = [chapter(1, '甲乙在桥边，乙丙在村口。'), chapter(2, '甲乙丙在桥下。')]
    const hits = searchProsePassages(chapters, 3, new Map([['甲乙丙', 4]]), {}, 2400, 6)
    expect(hits.map(hit => hit.chapterNumber)).toEqual([2])
  })

  it('continues past duplicate and unrepresentable high-score passages', () => {
    const chapters = [
      chapter(1, '令牌。'), chapter(2, '😀令牌。'), chapter(3, '😀令牌。'), chapter(4, '😀令牌。')
    ]
    const hits = searchProsePassages(chapters, 5, new Map([['令牌', 4], ['😀', 3]]), {}, 1, 1)
    expect(hits).toHaveLength(1)
    expect(hits[0].chapterNumber).toBe(1)
    expect(hits[0].text).toBe('令')
  })
})
