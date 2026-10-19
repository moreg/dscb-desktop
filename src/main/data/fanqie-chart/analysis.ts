import { createHash } from 'crypto'
import type {
  FanqieChartBook,
  FanqieChartInsight,
  FanqieChapterContent,
  FanqieGoldenThreeSummary,
  FanqieGoldenThreeStage,
  FanqieTagStat
} from '../../../shared/fanqie-chart'
import { hasPrivateOrBox } from './parse'
import { chartBookTags, FANQIE_CHART_TAG_RULES_VERSION } from '../../../shared/fanqie-chart-tags'

export const INSIGHT_DIMENSIONS = [
  'genre_characteristics',
  'hot_elements',
  'cool_point_patterns',
  'intro_patterns',
  'ranking_reasons',
  'writing_suggestions',
  'target_audience',
  'opening_patterns',
  'golden_three_directions'
] as const

const MULTI_BOOK = new Set(['hot_elements', 'intro_patterns'])
const HYPOTHESIS = new Set(['ranking_reasons', 'writing_suggestions', 'target_audience', 'golden_three_directions'])
const NUMBER = '[0-9一二三四五六七八九十百千万两]+'
const RANK_PATTERN =
  `第\\s*${NUMBER}\\s*(?:名|位)|(?:前|后|TOP)\\s*${NUMBER}(?![0-9一二三四五六七八九十百千万两章节天回])` +
  `|(?:排名|榜位|排在)\\s*${NUMBER}|榜首|首位`
const RANK_CLAIM = new RegExp(RANK_PATTERN, 'i')
const METRIC_CLAIM = new RegExp(
  `${RANK_PATTERN}|\\d+(?:\\.\\d+)?\\s*(?:%|％|/|本|部|名|万|亿|人)|${NUMBER}\\s*(?:本|部|成)`,
  'i'
)

export interface EvidenceBook {
  id: string
  rank: number | null
  title: string
  tags: string[]
  intro: string
  readCount: string
  wordCount: string
  status: string
  url: string
}

export function bookTags(book: FanqieChartBook): string[] {
  return chartBookTags(book)
}

export function prepareBooks(books: FanqieChartBook[]): EvidenceBook[] {
  const result: EvidenceBook[] = []
  const seen = new Set<string>()
  const ordered = [...books].sort((a, b) => a.rank - b.rank || a.bookId.localeCompare(b.bookId))
  for (const book of ordered) {
    const title = book.title.trim()
    const tags = bookTags(book)
    const blob = title + book.intro + tags.join('')
    if (!title || book.garbled || hasPrivateOrBox(blob)) continue
    if (seen.has(book.bookId)) continue
    seen.add(book.bookId)
    result.push({
      id: book.bookId,
      rank: book.rank > 0 ? book.rank : null,
      title,
      tags,
      intro: book.intro.trim(),
      readCount: book.readCount.trim(),
      wordCount: book.wordCount.trim(),
      status: book.status.trim(),
      url: book.url
    })
  }
  return result
}

export function tagStatistics(books: FanqieChartBook[]): FanqieTagStat[] {
  const usable = prepareBooks(books)
  if (usable.length === 0) return []
  const head = usable.filter((book) => book.rank != null && book.rank <= 10)
  const counts = new Map<string, number>()
  const headCounts = new Map<string, number>()
  const owners = new Map<string, string[]>()
  for (const book of usable) {
    for (const tag of book.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
      const ids = owners.get(tag) ?? []
      ids.push(book.id)
      owners.set(tag, ids)
    }
  }
  for (const book of head) {
    for (const tag of book.tags) headCounts.set(tag, (headCounts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([tag, count]) => ({
      tag,
      count,
      share: round1((count * 100) / usable.length),
      topCount: headCounts.get(tag) ?? 0,
      topShare: head.length ? round1(((headCounts.get(tag) ?? 0) * 100) / head.length) : 0,
      bookIds: owners.get(tag) ?? []
    }))
}

export function sourceHash(books: FanqieChartBook[]): string {
  const payload = [...books]
    .sort((a, b) => a.rank - b.rank || a.bookId.localeCompare(b.bookId))
    .map((book) => ({
      id: book.bookId,
      rank: book.rank,
      title: book.title,
      author: book.author,
      intro: book.intro,
      tags: bookTags(book),
      readCount: book.readCount,
      garbled: book.garbled
    }))
  return createHash('sha256').update(JSON.stringify({ tagRules: FANQIE_CHART_TAG_RULES_VERSION, books: payload })).digest('hex')
}

export function validateInsights(
  parsed: unknown,
  books: FanqieChartBook[],
  chapters: FanqieChapterContent[] = []
): { insights: FanqieChartInsight[]; issues: string[] } {
  const sources = new Map(prepareBooks(books).map((book) => [book.id, book]))
  const raw =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { insights?: unknown }).insights)
      ? (parsed as { insights: unknown[] }).insights
      : null
  if (!raw?.length) return { insights: [], issues: ['缺少带书籍原文依据的 insights 数组'] }
  const accepted: FanqieChartInsight[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const label = `第 ${index + 1} 条结论`
    if (!item || typeof item !== 'object') {
      issues.push(`${label}格式错误`)
      return
    }
    const row = item as { dimension?: unknown; claim?: unknown; evidence?: unknown; confidence?: unknown }
    const dimension = row.dimension
    const claim = typeof row.claim === 'string' ? row.claim.trim() : ''
    if (!INSIGHT_DIMENSIONS.includes(dimension as (typeof INSIGHT_DIMENSIONS)[number]) || !claim) {
      issues.push(`${label}缺少合法维度或结论`)
      return
    }
    const metricRule = dimension === 'writing_suggestions' || dimension === 'golden_three_directions' || dimension === 'opening_patterns' ? RANK_CLAIM : METRIC_CLAIM
    if (metricRule.test(claim)) {
      issues.push(`${label}含未经本地统计的数量或排名，请只写定性判断`)
      return
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      issues.push(`${label}没有书籍依据`)
      return
    }
    const verified: FanqieChartInsight['evidence'] = []
    for (const ref of row.evidence) {
      if (!ref || typeof ref !== 'object') {
        issues.push(`${label}引用了榜单以外的文字`)
        return
      }
      const evidence = ref as { bookId?: unknown; book_id?: unknown; field?: unknown; quote?: unknown; chapterId?: unknown }
      const bookId =
        typeof evidence.bookId === 'string'
          ? evidence.bookId
          : typeof evidence.book_id === 'string'
            ? evidence.book_id
            : ''
      const field = evidence.field
      const quote = typeof evidence.quote === 'string' ? evidence.quote.trim() : ''
      const source = bookId ? sources.get(bookId) : undefined
      if (!source || (field !== 'title' && field !== 'intro' && field !== 'tags' && field !== 'chapter') || !quote) {
        issues.push(`${label}引用了榜单以外的文字`)
        return
      }
      const chapter = field === 'chapter' ? chapters.find((ch) => ch.bookId === bookId && ch.id === evidence.chapterId && !ch.hasGarbled) : undefined
      const matches = field === 'chapter' ? chapter?.content.includes(quote) : field === 'tags' ? source.tags.includes(quote) : source[field].includes(quote)
      if (!matches || (field !== 'tags' && quote.length < 2)) {
        issues.push(`${label}引用了榜单以外的文字`)
        return
      }
      if (!verified.some((item) => item.bookId === bookId && item.field === field && item.quote === quote && item.chapterId === chapter?.id)) {
        verified.push({ bookId, field, quote, ...(chapter ? { chapterId: chapter.id, chapterTitle: chapter.title } : {}) })
      }
    }
    if (dimension === 'intro_patterns' && verified.some((ref) => ref.field !== 'intro')) {
      issues.push(`${label}的简介写法只能摘引简介`)
      return
    }
    if ((dimension === 'opening_patterns' || dimension === 'golden_three_directions') && verified.some((ref) => ref.field !== 'chapter')) {
      issues.push(`${label}必须引用章节正文`)
      return
    }
    if (MULTI_BOOK.has(String(dimension)) && new Set(verified.map((ref) => ref.bookId)).size < 2) {
      issues.push(`${label}至少需要两本不同的书`)
      return
    }
    const key = `${dimension}\n${claim}`
    if (seen.has(key)) return
    seen.add(key)
    const confidence =
      HYPOTHESIS.has(String(dimension)) || row.confidence !== 'sample_supported'
        ? 'hypothesis'
        : 'sample_supported'
    accepted.push({
      dimension: dimension as FanqieChartInsight['dimension'],
      claim,
      evidence: verified,
      confidence
    })
  })
  return { insights: accepted, issues }
}

export const GOLDEN_THREE_STAGES: FanqieGoldenThreeStage[] = ['overall', 'chapter_one', 'chapter_two', 'chapter_three', 'alternatives', 'pitfalls']

export function validateGoldenThreeSummary(
  parsed: unknown, books: FanqieChartBook[], chapters: FanqieChapterContent[], openingInsights: FanqieChartInsight[]
): { directions: FanqieGoldenThreeSummary['directions']; issues: string[] } {
  const raw = parsed && typeof parsed === 'object' ? (parsed as { directions?: unknown }).directions : undefined
  if (!Array.isArray(raw)) return { directions: [], issues: ['缺少 directions 数组'] }
  const directions: FanqieGoldenThreeSummary['directions'] = []
  const issues: string[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') { issues.push('汇总条目格式错误'); continue }
    const row = item as { stage?: unknown; claim?: unknown; evidence?: unknown }
    if (!GOLDEN_THREE_STAGES.includes(row.stage as FanqieGoldenThreeStage) || directions.some(d => d.stage === row.stage)) {
      issues.push('汇总阶段无效或重复'); continue
    }
    const checked = validateInsights({ insights: [{ ...row, dimension: 'golden_three_directions', confidence: 'hypothesis' }] }, books, chapters)
    const insight = checked.insights[0]
    if (!insight) { issues.push(...checked.issues); continue }
    if (new Set(insight.evidence.map(ref => ref.bookId)).size < 2) {
      issues.push(`${row.stage}至少需要两本不同书籍的正文依据`); continue
    }
    if (insight.evidence.some(ref => !openingInsights.some(source => source.evidence.some(e =>
      e.bookId === ref.bookId && e.chapterId === ref.chapterId && e.field === 'chapter' && e.quote === ref.quote)))) {
      issues.push(`${row.stage}引用未包含在已核验逐本分析中`); continue
    }
    directions.push({ stage: row.stage as FanqieGoldenThreeStage, claim: insight.claim, evidence: insight.evidence })
  }
  for (const stage of GOLDEN_THREE_STAGES) if (!directions.some(d => d.stage === stage)) issues.push(`缺少${stage}的有效写作方向`)
  return { directions, issues }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
