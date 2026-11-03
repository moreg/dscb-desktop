/** 番茄分类榜单。渲染进程和主进程共用，不依赖 Node。 */

export type FanqieChartBase =
  | 'new_book_male'
  | 'new_book_female'
  | 'reading_male'
  | 'reading_female'

export interface FanqieChartTypeInfo {
  id: FanqieChartBase
  label: string
  /** 番茄 rank URL 的频段：1 男频，0 女频 */
  gender: '0' | '1'
  /** 1 新书榜，2 阅读榜 */
  rankMold: '1' | '2'
}

export const FANQIE_CHART_TYPES: FanqieChartTypeInfo[] = [
  { id: 'new_book_male', label: '男频新书榜', gender: '1', rankMold: '1' },
  { id: 'new_book_female', label: '女频新书榜', gender: '0', rankMold: '1' },
  { id: 'reading_male', label: '男频阅读榜', gender: '1', rankMold: '2' },
  { id: 'reading_female', label: '女频阅读榜', gender: '0', rankMold: '2' }
]

export const FANQIE_MALE_CATEGORIES: Record<string, string> = {
  '261': '都市日常',
  '1141': '西方奇幻',
  '1140': '东方仙侠',
  '8': '科幻末世',
  '124': '都市修真',
  '1014': '都市高武',
  '273': '历史古代',
  '27': '战神赘婿',
  '263': '都市种田',
  '258': '传统玄幻',
  '272': '历史脑洞',
  '539': '悬疑脑洞',
  '262': '都市脑洞',
  '257': '玄幻脑洞',
  '751': '悬疑灵异',
  '504': '抗战谍战',
  '746': '游戏体育',
  '718': '动漫衍生',
  '1016': '男频衍生'
}

export const FANQIE_FEMALE_CATEGORIES: Record<string, string> = {
  '1139': '古风世情',
  '8': '科幻末世',
  '746': '游戏体育',
  '1015': '女频衍生',
  '248': '玄幻言情',
  '23': '种田',
  '79': '年代',
  '267': '现言脑洞',
  '246': '宫斗宅斗',
  '253': '古言脑洞',
  '24': '快穿',
  '749': '青春甜宠',
  '745': '星光璀璨',
  '747': '女频悬疑',
  '750': '职场婚恋',
  '748': '豪门总裁',
  '1017': '民国言情'
}

export const FANQIE_TARGET_BOOKS = 30

export interface FanqieChartBook {
  rank: number
  bookId: string
  title: string
  author: string
  cover: string
  genre: string
  wordCount: string
  readCount: string
  intro: string
  tags: string[]
  url: string
  status: string
  garbled: boolean
}

export interface FanqieChartEvidence {
  bookId: string
  field: 'title' | 'intro' | 'tags' | 'chapter'
  chapterId?: string
  chapterTitle?: string
  quote: string
}

export interface FanqieChartInsight {
  dimension:
    | 'genre_characteristics'
    | 'hot_elements'
    | 'cool_point_patterns'
    | 'intro_patterns'
    | 'ranking_reasons'
    | 'writing_suggestions'
    | 'target_audience'
    | 'opening_patterns'
    | 'golden_three_directions'
  claim: string
  evidence: FanqieChartEvidence[]
  confidence: 'sample_supported' | 'hypothesis'
}

export interface FanqieTagStat {
  tag: string
  count: number
  share: number
  topCount: number
  topShare: number
  bookIds: string[]
}

export interface FanqieChartAnalysis {
  chartType: string
  category: string
  chartDate: string
  analyzedAt: string
  totalBooks: number
  analyzedBooks: number
  excludedBooks: number
  introCount: number
  readCountCount: number
  taggedCount: number
  isPartial: boolean
  targetCount: number
  topN: number
  limitations: string[]
  tagStatistics: FanqieTagStat[]
  insights: FanqieChartInsight[]
  sourceHash: string
  openingBookCount?: number
  openingChapterCount?: number
  goldenThreeSummary?: FanqieGoldenThreeSummary | null
  marketSourceHash?: string
  summarySourceHash?: string
  inProgress?: boolean
  retryRequired?: boolean
}

export type FanqieGoldenThreeStage = 'overall' | 'chapter_one' | 'chapter_two' | 'chapter_three' | 'alternatives' | 'pitfalls'

export interface FanqieGoldenThreeSummary {
  bookCount: number
  chapterCount: number
  directions: Array<{
    stage: FanqieGoldenThreeStage
    claim: string
    evidence: FanqieChartEvidence[]
  }>
}

export interface FanqieIdeaBasis {
  bookId: string
  title: string
  rank: number | null
  field: 'title' | 'intro' | 'tags'
  quote: string
  mechanism: string
}

export interface FanqieChartIdea {
  title: string
  titleCandidates: string[]
  strategy: string
  genre: string
  hookLine: string
  goldenFinger: string
  fusion: string
  coreConcept: string
  sellingPoint: string
  protagonist: string
  openingHook: string
  marketReasoning: string
  readerFit: string
  riskNotes: string
  trendBasis: FanqieIdeaBasis[]
  /** v14 新生成方案必填；兼容旧记录。 */
  worldSetting?: string
  powerSystem?: string
  supportingCharacters?: string
  coreConflict?: string
  targetAudience?: string
  pacingPlan?: string
  /** 旧脑洞记录可能没有此字段。新生成的方案包含完整三章方向。 */
  openingChapters?: FanqieIdeaOpeningChapter[]
}

export interface FanqieIdeaOpeningChapter {
  chapter: 1 | 2 | 3
  openingEvent: string
  protagonistAction: string
  conflict: string
  payoff: string
  endHook: string
  summaryApplication: string
}

export interface FanqieChartIdeas {
  promptVersion?: string
  ideas: FanqieChartIdea[]
  chartDate: string
  sampleCount: number
  generatedAt: string
  focusTags: string[]
  sourceHash: string
  /** 本次脑洞使用的正文分析与分类汇总版本。 */
  analysisSourceHash?: string
}

export interface FanqieChartRecord {
  id: string
  chartType: string
  chartDate: string
  books: FanqieChartBook[]
  analysis: FanqieChartAnalysis | null
  ideas: FanqieChartIdeas | null
  status: 'fetched' | 'analyzed'
  targetCount: number
  actualCount: number
  isPartial: boolean
  partialReason: string
  sourceHash: string
  fetchedAt: string
  updatedAt: string
  /** 这期封面图片所在目录。还没存过封面时没有这个字段。 */
  coverDirectory?: string
  /** 本期榜单书籍前3章正文的抓取结果。正文保存在书籍缓存中。 */
  chapterFetchNote?: string
}

export interface FanqieChartProgress {
  chartType: string
  message: string
  analysis?: FanqieChartAnalysis
}

export interface FanqieChapterItem {
  id: string
  title: string
  index: number
  needPay: boolean
  isLocked: boolean
  volumeName?: string
}

export interface FanqieChapterContent {
  id: string
  bookId: string
  title: string
  bookTitle: string
  content: string
  url: string
  hasGarbled: boolean
  wordCount: number
  fetchedAt: string
}

export interface FanqieBookDetail {
  bookId: string
  title: string
  author: string
  cover: string
  intro: string
  genre: string
  wordCount: string
  readCount: string
  status: string
  tags: string[]
  chapters: FanqieChapterItem[]
  cachedChapterIds: string[]
  updatedAt: string
}

export interface FanqieBatchFetchProgress {
  bookId: string
  current: number
  total: number
  chapterTitle: string
  message: string
  status: 'running' | 'completed' | 'failed'
}

export interface FanqieExportTxtResult {
  title: string
  content: string
  chapterCount: number
  wordCount: number
}

export interface FanqieMultiBookItem {
  bookId: string
  title?: string
}

export interface FanqieMultiBookProgress {
  bookIndex: number
  totalBooks: number
  bookTitle: string
  bookId: string
  chapterIndex: number
  totalChapters: number
  chapterTitle: string
  message: string
  status: 'running' | 'completed' | 'failed'
}

export interface FanqieChartIdeasInput {
  chartType: string
  ideaCount?: number
  tags?: string[]
}

const BASES = new Set<string>(FANQIE_CHART_TYPES.map((item) => item.id))

export function fanqieCategoriesFor(base: string): Record<string, string> {
  return base.includes('female') ? FANQIE_FEMALE_CATEGORIES : FANQIE_MALE_CATEGORIES
}

export function fanqieChartLabel(base: string): string {
  return FANQIE_CHART_TYPES.find((item) => item.id === base)?.label ?? base
}

export function parseFanqieChartType(chartType: string): {
  base: FanqieChartBase
  categoryId: string
  chartLabel: string
  categoryLabel: string
} {
  const [base, categoryId] = chartType.split(':')
  if (!base || !categoryId || !BASES.has(base)) {
    throw new Error('不认识的榜单类型')
  }
  const categories = fanqieCategoriesFor(base)
  const categoryLabel = categories[categoryId]
  if (!categoryLabel) throw new Error('这个分类不在当前榜单里')
  return {
    base: base as FanqieChartBase,
    categoryId,
    chartLabel: fanqieChartLabel(base),
    categoryLabel
  }
}

export function fanqieChartPageUrl(base: FanqieChartBase, categoryId: string): string {
  const info = FANQIE_CHART_TYPES.find((item) => item.id === base)
  if (!info) throw new Error('不认识的榜单类型')
  return `https://fanqienovel.com/rank/${info.gender}_${info.rankMold}_${categoryId}`
}

export function fanqieChartKey(chartType: string): string {
  parseFanqieChartType(chartType)
  return chartType.replace(':', '__')
}

/** 规范化番茄字数展示，如 145196 -> 14.5万字 */
export function formatFanqieWordCount(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return ''
  const str = String(val).trim()
  if (!str) return ''
  if (str.includes('万') || str.includes('亿')) {
    return str.endsWith('字') ? str : `${str}字`
  }
  const num = parseInt(str, 10)
  if (isNaN(num)) return str.endsWith('字') ? str : `${str}字`
  if (num >= 100000000) {
    return `${(num / 100000000).toFixed(1)}亿字`
  }
  if (num >= 10000) {
    return `${(num / 10000).toFixed(1)}万字`
  }
  return `${num}字`
}

/** 规范化番茄在读人数展示，如 22.2万 -> 22.2万在读 */
export function formatFanqieReadCount(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return ''
  const str = String(val).trim()
  if (!str) return ''
  if (str.endsWith('在读')) return str
  return `${str}在读`
}
