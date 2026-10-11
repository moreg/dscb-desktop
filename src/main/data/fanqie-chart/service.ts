import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { findJsonObject } from '../../../shared/json-extract'
import type {
  FanqieChartAnalysis,
  FanqieChartBook,
  FanqieChartIdea,
  FanqieChartIdeas,
  FanqieChartInsight,
  FanqieChartRecord,
  FanqieIdeaBasis,
  FanqieMultiBookItem,
  FanqieMultiBookProgress,
  FanqieGoldenThreeSummary,
  FanqieIdeaOpeningChapter
} from '../../../shared/fanqie-chart'
import {
  FANQIE_TARGET_BOOKS,
  fanqieChartKey,
  parseFanqieChartType
} from '../../../shared/fanqie-chart'
import { readJson, writeJsonAtomic } from '../atomic'
import type { LlmService } from '../llm-service'
import { prepareBooks, sourceHash, tagStatistics, validateInsights, validateGoldenThreeSummary } from './analysis'
import { decryptPrivateChars } from './glyph-match'
import {
  collectPrivateChars,
  extractFontUrls,
  hasCjk,
  localDateString,
  pageUrlOf,
  parseRankBooks,
  rankApiUrl,
  restoreBook
} from './parse'
import {
  FanqieBatchFetchProgress,
  FanqieBookDetail,
  FanqieChapterContent,
  FanqieExportTxtResult
} from '../../../shared/fanqie-chart'
import { FanqieChapterScraper } from './chapters'
import { saveChartCovers } from './covers'
import { buildAnalysisPrompt, buildIdeasPrompt, buildOpeningAnalysisPrompt, buildGoldenThreeSummaryPrompt } from './prompts'

const MIN_BOOKS = 8
const PAGE_SIZE = 10
const PAGES = 3
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface ChartProgress {
  (message: string, analysis?: FanqieChartAnalysis): void
}

export class FanqieChartService {
  private tail: Promise<unknown> = Promise.resolve()
  readonly chapterScraper: FanqieChapterScraper

  constructor(
    private readonly userData: string,
    private readonly llm: LlmService,
    private readonly getCoversRoot: () => Promise<string> = async () => path.join(userData, 'covers')
  ) {
    this.chapterScraper = new FanqieChapterScraper(userData)
  }

  getBookDetail(
    bookId: string,
    knownBook?: Partial<FanqieChartBook>,
    force = false,
    signal?: AbortSignal
  ): Promise<FanqieBookDetail> {
    return this.chapterScraper.getBookDetail(bookId, knownBook, force, signal)
  }

  getChapterContent(
    bookId: string,
    chapterId: string,
    knownChapterTitle?: string,
    knownBookTitle?: string,
    force = false,
    signal?: AbortSignal
  ): Promise<FanqieChapterContent> {
    return this.chapterScraper.getChapterContent(bookId, chapterId, knownChapterTitle, knownBookTitle, force, signal)
  }

  fetchChaptersBatch(
    bookId: string,
    limit = 10,
    chapterIds?: string[],
    onProgress?: (progress: FanqieBatchFetchProgress) => void,
    signal?: AbortSignal
  ): Promise<FanqieChapterContent[]> {
    return this.chapterScraper.fetchChaptersBatch(bookId, limit, chapterIds, onProgress, signal)
  }

  exportBookTxt(bookId: string): Promise<FanqieExportTxtResult> {
    return this.chapterScraper.exportBookTxt(bookId)
  }

  deleteBookCache(bookId: string): Promise<void> {
    return this.chapterScraper.deleteBookCache(bookId)
  }

  listCachedBooksSummary(): Promise<Record<string, number>> {
    return this.chapterScraper.listCachedBooksSummary()
  }

  fetchMultipleBooksChapters(
    books: FanqieMultiBookItem[],
    chapterLimit = 3,
    onProgress?: (progress: FanqieMultiBookProgress) => void,
    signal?: AbortSignal
  ): Promise<Record<string, number>> {
    return this.chapterScraper.fetchMultipleBooksChapters(books, chapterLimit, onProgress, signal)
  }

  private root(): string {
    return path.join(this.userData, 'fanqie-charts')
  }

  private fileOf(chartType: string): string {
    return path.join(this.root(), `${fanqieChartKey(chartType)}.json`)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  list(): Promise<FanqieChartRecord[]> {
    return this.enqueue(() => this.readAll())
  }

  async readAll(): Promise<FanqieChartRecord[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root())
    } catch {
      return []
    }
    const records: FanqieChartRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('standard-glyphs')) continue
      const record = await readJson<FanqieChartRecord | null>(path.join(this.root(), name), null)
      if (record?.chartType && Array.isArray(record.books)) {
        if ((record.chapterFetchNote?.includes('失败，可重试补抓') && !record.chapterFetchNote.includes('\n'))
          || record.chapterFetchNote?.startsWith('当前前3章缓存检查：')) {
          const note = await this.chapterScraper.inspectOpeningCache(record.books)
          if (note !== record.chapterFetchNote) {
            record.chapterFetchNote = note
            await writeJsonAtomic(path.join(this.root(), name), record)
          }
        }
        records.push(record)
      }
    }
    return records.sort((a, b) => a.chartType.localeCompare(b.chartType))
  }

  delete(chartType: string): Promise<void> {
    parseFanqieChartType(chartType)
    return this.enqueue(async () => {
      await fs.rm(this.fileOf(chartType), { force: true })
    })
  }

  fetch(chartType: string, force: boolean, onProgress?: ChartProgress): Promise<FanqieChartRecord> {
    return this.enqueue(async () => {
      const record = await this.fetchUnqueued(chartType, force, onProgress)
      let chapterFetchNote = ''
      try {
        await this.fetchMultipleBooksChapters(record.books, 3, (progress) => {
          onProgress?.(progress.message)
          if (progress.status !== 'running') chapterFetchNote = progress.message
        })
      } catch (err) {
        chapterFetchNote = `前3章抓取未完成：${err instanceof Error ? err.message : String(err)}`
        onProgress?.(chapterFetchNote)
      }
      const updated = { ...record, chapterFetchNote }
      await writeJsonAtomic(this.fileOf(chartType), updated)
      return updated
    })
  }

  private async fetchUnqueued(
    chartType: string,
    force: boolean,
    onProgress?: ChartProgress
  ): Promise<FanqieChartRecord> {
    const parsed = parseFanqieChartType(chartType)
    const existing = await readJson<FanqieChartRecord | null>(this.fileOf(chartType), null)
    const today = localDateString()
    if (!force && existing?.chartDate === today && existing.books.some((book) => !book.garbled)) {
      return this.rememberCovers(existing, await this.saveCovers(chartType, existing.books, onProgress))
    }
    onProgress?.('正在抓取榜单')
    const pageUrl = pageUrlOf(parsed.base, parsed.categoryId)
    const rawBooks = await fetchRankPages(pageUrl)
    if (rawBooks.length < MIN_BOOKS) {
      throw new Error(`只抓到 ${rawBooks.length} 本，这期榜单不可用`)
    }
    onProgress?.('正在下载字体')
    const html = await requestText(pageUrl, pageUrl)
    const fontUrl = extractFontUrls(html).find((url) => url.endsWith('.woff')) ?? extractFontUrls(html)[0]
    if (!fontUrl) throw new Error('页面上没有字体，书名无法还原')
    const fontBytes = await requestBytes(fontUrl)
    if (fontBytes.length < 1000) throw new Error('字体下载不完整，书名无法还原')
    const privateChars = collectPrivateChars(rawBooks)
    const map = privateChars.length
      ? await decryptPrivateChars(fontBytes, privateChars, this.root(), onProgress)
      : new Map<number, string>()
    const books = rawBooks.map((book) => restoreBook(book, map))
    const readable = books.filter((book) => !book.garbled && hasCjk(book.title))
    if (readable.length < MIN_BOOKS) {
      throw new Error(`只还原出 ${readable.length} 本书名，这次抓取不可用`)
    }
    const garbledCount = books.length - readable.length
    const short = books.length < FANQIE_TARGET_BOOKS
    const partialReason = [
      short ? `这期抓到 ${books.length} 本，少于 ${FANQIE_TARGET_BOOKS} 本` : '',
      garbledCount ? `${garbledCount} 本书名没能还原` : ''
    ]
      .filter(Boolean)
      .join('；')
    const hash = sourceHash(books)
    const keepDerived = existing?.sourceHash === hash
    const now = new Date().toISOString()
    const record: FanqieChartRecord = {
      id: chartType,
      chartType,
      chartDate: today,
      books,
      analysis: keepDerived ? existing?.analysis ?? null : null,
      ideas: keepDerived ? existing?.ideas ?? null : null,
      status: keepDerived && existing?.analysis ? 'analyzed' : 'fetched',
      targetCount: FANQIE_TARGET_BOOKS,
      actualCount: readable.length,
      isPartial: short || garbledCount > 0,
      partialReason,
      sourceHash: hash,
      fetchedAt: now,
      updatedAt: now
    }
    await writeJsonAtomic(this.fileOf(chartType), record)
    return this.rememberCovers(record, await this.saveCovers(chartType, books, onProgress))
  }

  private async saveCovers(chartType: string, books: FanqieChartBook[], onProgress?: ChartProgress) {
    try {
      return await saveChartCovers({
        root: await this.getCoversRoot(),
        chartType,
        books,
        onProgress
      })
    } catch (err) {
      console.warn(`封面保存失败: ${err instanceof Error ? err.message : String(err)}`)
      return { saved: 0, skipped: 0, failed: books.length, stored: 0, directory: '' }
    }
  }

  private async rememberCovers(
    record: FanqieChartRecord,
    result: Awaited<ReturnType<typeof saveChartCovers>>
  ): Promise<FanqieChartRecord> {
    if (result.stored === 0 || record.coverDirectory === result.directory) return record
    const next: FanqieChartRecord = { ...record, coverDirectory: result.directory }
    await writeJsonAtomic(this.fileOf(record.chartType), next)
    return next
  }

  analyze(
    chartType: string,
    force: boolean,
    onProgress?: ChartProgress,
    signal?: AbortSignal
  ): Promise<FanqieChartRecord> {
    return this.enqueue(() => this.analyzeUnqueued(chartType, force, onProgress, signal))
  }

  private async analyzeUnqueued(
    chartType: string,
    force: boolean,
    onProgress?: ChartProgress,
    signal?: AbortSignal
  ): Promise<FanqieChartRecord> {
    const record = await this.requireRecord(chartType)
    const openingChapters: FanqieChapterContent[] = []
    for (const book of prepareBooks(record.books)) {
      if (signal?.aborted) throw new Error('分析已取消')
      openingChapters.push(...await this.chapterScraper.readCachedOpening(book.id))
    }
    const hash = createHash('sha256').update(JSON.stringify({
      version: 'opening-parallel-v3', books: sourceHash(record.books),
      chapters: openingChapters.map(ch => ({ bookId: ch.bookId, id: ch.id, title: ch.title, content: ch.content }))
    })).digest('hex')
    const legacyHash = createHash('sha256').update(JSON.stringify({
      version: 'opening-summary-v2', books: sourceHash(record.books),
      chapters: openingChapters.map(ch => ({ bookId: ch.bookId, id: ch.id, title: ch.title, content: ch.content }))
    })).digest('hex')
    const legacyCurrent = record.analysis?.sourceHash === legacyHash
    if (!force && record.analysis && record.analysis.sourceHash === hash && !record.analysis.inProgress && !record.analysis.retryRequired) return record
    const evidence = prepareBooks(record.books)
    if (evidence.length < 2) throw new Error('可读的书不足两本，无法分析')
    const parsed = parseFanqieChartType(chartType)
    const limitations = buildLimitations(record, evidence.length)
    const openingBookCount = new Set(openingChapters.map(ch => ch.bookId)).size
    limitations.push(`正文样本：${openingBookCount} 本书、${openingChapters.length} 章，只包含各书目录前三章的有效缓存。`)
    if (openingBookCount < evidence.length) limitations.push(`${evidence.length - openingBookCount} 本没有有效正文，未进行开篇分析；可先补抓前3章。`)
    const marketHash = sourceHash(record.books)
    const perBook = new Map<string, FanqieChartInsight[]>()
    let retryRequired = false
    let notes: string[] | undefined
    let insights: FanqieChartInsight[] = record.analysis && (record.analysis.marketSourceHash === marketHash || legacyCurrent)
      ? record.analysis.insights.filter(item => item.dimension !== 'opening_patterns' && item.dimension !== 'golden_three_directions')
      : []
    if (!insights.length) {
      onProgress?.('正在分析这期榜单的书目资料')
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await this.llm.generateStream(buildAnalysisPrompt({
          chartLabel: parsed.chartLabel, category: parsed.categoryLabel, chartDate: record.chartDate,
          limitations, books: record.books, repairNotes: notes
        }), {
          systemPrompt: '只输出 JSON 对象，不要解释。', maxTokens: 8192,
          meta: { feature: 'fanqieChart' }, signal, strengthOverride: { temperature: 0.2 }
        })
        const checked = validateInsights(findJsonObject(text), record.books)
        insights = checked.insights
        if (insights.length >= 4 && checked.issues.length === 0) break
        notes = checked.issues.length ? checked.issues : ['没有解析出带原文依据的结论']
        if (insights.length >= 4) break
      }
    } else onProgress?.('书目资料未变化，复用市场分析')
    if (!insights.length) throw new Error(notes?.[0] ?? '分析没有得到可用结论')
    const marketInsights = insights
    const combineInsights = () => [...marketInsights, ...record.books.flatMap(book => perBook.get(book.bookId) ?? [])]
    const makeAnalysis = (summary: FanqieGoldenThreeSummary | null, inProgress: boolean, summarySourceHash?: string): FanqieChartAnalysis => ({
      chartType, category: parsed.categoryLabel, chartDate: record.chartDate, analyzedAt: new Date().toISOString(),
      totalBooks: record.books.length, analyzedBooks: evidence.length, excludedBooks: record.books.length - evidence.length,
      introCount: evidence.filter(book => book.intro).length, readCountCount: evidence.filter(book => /\d/.test(book.readCount)).length,
      taggedCount: evidence.filter(book => book.tags.length).length, isPartial: record.isPartial,
      targetCount: record.targetCount, topN: evidence.filter(book => book.rank != null && book.rank <= 10).length,
      limitations: [...limitations], tagStatistics: tagStatistics(record.books), insights: combineInsights(),
      sourceHash: hash, marketSourceHash: marketHash, openingBookCount, openingChapterCount: openingChapters.length,
      goldenThreeSummary: summary, summarySourceHash, inProgress, retryRequired
    })
    // 每本完成就保存一份快照；串行写入避免并发完成时旧快照覆盖新结果。
    let persistTail = Promise.resolve()
    const publish = (message: string) => {
      const analysis = makeAnalysis(null, true)
      const partial: FanqieChartRecord = { ...record, analysis, status: 'analyzed', sourceHash: marketHash, updatedAt: analysis.analyzedAt }
      persistTail = persistTail.then(() => writeJsonAtomic(this.fileOf(chartType), partial))
      onProgress?.(message, analysis)
      return persistTail
    }
    await publish('开始逐本分析，最多同时处理2本书')
    const targets = record.books.filter(book => openingChapters.some(ch => ch.bookId === book.bookId))
    let nextBook = 0
    let completed = 0
    const worker = async () => {
      while (nextBook < targets.length && !signal?.aborted) {
        const book = targets[nextBook++]
        const chapters = openingChapters.filter(ch => ch.bookId === book.bookId)
        if (chapters.length < 3) limitations.push(`《${book.title}》仅有${chapters.length}章有效正文，三章建议依据不完整。`)
        const bookHash = createHash('sha256').update(JSON.stringify({ version: 'book-opening-v1',
          title: book.title, genre: book.genre, tags: book.tags,
          chapters: chapters.map(ch => ({ id: ch.id, title: ch.title, content: ch.content }))
        })).digest('hex')
        const cacheFile = path.join(this.root(), 'book-analysis', `${createHash('sha256').update(book.bookId).digest('hex')}.json`)
        const cached = await readJson<{ sourceHash: string; insights: FanqieChartInsight[] } | null>(cacheFile, null)
        let reused = false
        try {
          let accepted: FanqieChartInsight[] = []
          let openingNotes: string[] | undefined
          const candidate = cached?.sourceHash === bookHash ? cached.insights : legacyCurrent
            ? record.analysis?.insights.filter(item => (item.dimension === 'opening_patterns' || item.dimension === 'golden_three_directions') && item.evidence.every(ref => ref.bookId === book.bookId))
            : undefined
          if (candidate) {
            const checked = validateInsights({ insights: candidate }, [book], chapters)
            if (!checked.issues.length && hasCompleteOpening(checked.insights)) {
              accepted = checked.insights
              reused = true
              if (cached?.sourceHash !== bookHash) await writeJsonAtomic(cacheFile, { sourceHash: bookHash, insights: accepted })
            }
          }
          if (!reused) {
            onProgress?.(`正在分析《${book.title}》开篇正文（已完成${completed}/${targets.length}）`)
            for (let attempt = 0; attempt < 2; attempt++) {
              if (signal?.aborted) throw new Error('分析已取消')
              const text = await this.llm.generateStream(buildOpeningAnalysisPrompt(book, chapters, openingNotes), {
                systemPrompt: '只输出 JSON 对象，不要解释。', maxTokens: 6000,
                meta: { feature: 'fanqieChart' }, signal, strengthOverride: { temperature: 0.2 }
              })
              const checked = validateInsights(findJsonObject(text), [book], chapters)
              accepted = checked.insights.filter(item => item.dimension === 'opening_patterns' || item.dimension === 'golden_three_directions')
              if (hasCompleteOpening(accepted) && !checked.issues.length) { openingNotes = undefined; break }
              openingNotes = [...checked.issues, ...(!hasCompleteOpening(accepted) ? ['需要正文分析及分别覆盖第一、第二、第三章的写作方向'] : [])]
            }
            if (!openingNotes?.length) await writeJsonAtomic(cacheFile, { sourceHash: bookHash, insights: accepted })
          }
          perBook.set(book.bookId, accepted)
          if (openingNotes?.length) {
            retryRequired = true
            limitations.push(`《${book.title}》部分正文结论或三章建议未通过原文核验，已省略未通过的条目。`)
          }
        } catch (err) {
          if (signal?.aborted) return
          retryRequired = true
          limitations.push(`《${book.title}》正文分析失败：${err instanceof Error ? err.message : String(err)}，可重新分析。`)
        }
        completed += 1
        await publish(`${reused ? '复用缓存' : '分析完成'}：《${book.title}》（${completed}/${targets.length}）`)
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(2, targets.length) }, () => worker()))
    await persistTail
    if (signal?.aborted) throw new Error('分析已取消')
    const failedWorker = workers.find(result => result.status === 'rejected')
    if (failedWorker?.status === 'rejected') throw failedWorker.reason
    insights = combineInsights()
    let goldenThreeSummary: FanqieGoldenThreeSummary | null = null
    const openingInsights = insights.filter(item => item.dimension === 'opening_patterns' || item.dimension === 'golden_three_directions')
    const summaryBookIds = new Set(openingInsights.flatMap(item => item.evidence.map(ref => ref.bookId)))
    const summaryBooks = record.books.filter(book => summaryBookIds.has(book.bookId))
    const summaryHash = createHash('sha256').update(JSON.stringify({ version: 'summary-v1',
      category: parsed.categoryLabel, chartLabel: parsed.chartLabel, books: summaryBooks.map(book => ({ bookId: book.bookId, title: book.title })),
      insights: openingInsights, chapterHash: openingChapters.filter(ch => summaryBookIds.has(ch.bookId)).map(ch => ({ bookId: ch.bookId, id: ch.id, content: ch.content }))
    })).digest('hex')
    if (record.analysis?.goldenThreeSummary && (record.analysis.summarySourceHash === summaryHash || legacyCurrent)
      && !validateGoldenThreeSummary(record.analysis.goldenThreeSummary, summaryBooks, openingChapters, openingInsights).issues.length) {
      goldenThreeSummary = record.analysis.goldenThreeSummary
      onProgress?.('开篇分析未变化，复用分类黄金三章汇总')
    } else if (summaryBooks.length >= 2) {
      onProgress?.('正在综合本分类全部有效开篇分析，生成总体黄金三章方向')
      try {
        let repairNotes: string[] | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted) throw new Error('分析已取消')
          const text = await this.llm.generateStream(buildGoldenThreeSummaryPrompt({
            category: parsed.categoryLabel, chartLabel: parsed.chartLabel, books: summaryBooks,
            insights: openingInsights, limitations, repairNotes
          }), {
            systemPrompt: '只输出 JSON 对象，不要解释。', maxTokens: 6000,
            meta: { feature: 'fanqieChart' }, signal, strengthOverride: { temperature: 0.2 }
          })
          const checked = validateGoldenThreeSummary(findJsonObject(text), summaryBooks, openingChapters, openingInsights)
          if (!checked.issues.length) {
            goldenThreeSummary = { bookCount: summaryBooks.length,
              chapterCount: openingChapters.filter(ch => summaryBookIds.has(ch.bookId)).length,
              directions: checked.directions }
            break
          }
          repairNotes = checked.issues
        }
        if (!goldenThreeSummary) {
          retryRequired = true
          limitations.push(`分类黄金三章汇总未通过核验：${repairNotes?.[0] ?? '依据不足'}；逐本分析已保留，可重新分析重试。`)
        }
      } catch (err) {
        if (signal?.aborted) throw err
        retryRequired = true
        limitations.push(`分类黄金三章汇总失败：${err instanceof Error ? err.message : String(err)}；逐本分析已保留，可重新分析重试。`)
      }
    } else {
      limitations.push('至少需要两本书的有效正文分析才能生成分类黄金三章汇总；逐本分析已保留。')
    }
    const analysis = makeAnalysis(goldenThreeSummary, false, summaryHash)
    const next: FanqieChartRecord = {
      ...record,
      analysis,
      status: 'analyzed',
      sourceHash: sourceHash(record.books),
      updatedAt: new Date().toISOString()
    }
    await writeJsonAtomic(this.fileOf(chartType), next)
    onProgress?.('分析完成，分类汇总已更新', analysis)
    return next
  }

  generateIdeas(
    chartType: string,
    ideaCount: number,
    focusTags: string[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    onProgress?: ChartProgress
  ): Promise<FanqieChartRecord> {
    return this.enqueue(() => this.generateIdeasUnqueued(chartType, ideaCount, focusTags, onToken, signal, onProgress))
  }

  private async generateIdeasUnqueued(
    chartType: string,
    ideaCount: number,
    focusTags: string[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    onProgress?: ChartProgress
  ): Promise<FanqieChartRecord> {
    const record = await this.analyzeUnqueued(chartType, false, onProgress, signal)
    const summary = record.analysis?.goldenThreeSummary
    if (!summary) throw new Error('本分类还没有可用的黄金三章汇总，请补抓至少两本书的前三章正文并重新分析后再生成脑洞')
    const evidence = prepareBooks(record.books)
    if (evidence.length < 2) throw new Error('可读的书不足两本，无法出脑洞')
    const parsed = parseFanqieChartType(chartType)
    const count = Math.min(5, Math.max(1, ideaCount))
    const tags = focusTags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8)
    let ideas: FanqieChartIdea[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.llm.generateStream(
        buildIdeasPrompt({
          chartLabel: parsed.chartLabel,
          category: parsed.categoryLabel,
          chartDate: record.chartDate,
          books: record.books,
          ideaCount: count,
          focusTags: tags,
          goldenThreeSummary: summary,
          repairNotes: attempt ? ['每个脑洞必须包含完整的第一、第二、第三章方向及各章全部六个字段，数量必须满足请求'] : undefined
        }),
        {
          systemPrompt: '只输出 JSON 对象，不要解释。',
          maxTokens: 14000,
          meta: { feature: 'fanqieChart:ideas' },
          onToken,
          signal,
          strengthOverride: { temperature: 0.7 }
        }
      )
      ideas = coerceIdeas(findJsonObject(text), record.books, count)
      if (ideas.length === count) break
    }
    if (ideas.length !== count) throw new Error('脑洞结果缺少完整的前三章写作方向或数量不足，请再生成一次')
    const payload: FanqieChartIdeas = {
      ideas,
      chartDate: record.chartDate,
      sampleCount: evidence.length,
      generatedAt: new Date().toISOString(),
      focusTags: tags,
      sourceHash: sourceHash(record.books),
      analysisSourceHash: record.analysis?.sourceHash
    }
    const next: FanqieChartRecord = { ...record, ideas: payload, updatedAt: payload.generatedAt }
    await writeJsonAtomic(this.fileOf(chartType), next)
    return next
  }

  private async requireRecord(chartType: string): Promise<FanqieChartRecord> {
    parseFanqieChartType(chartType)
    const record = await readJson<FanqieChartRecord | null>(this.fileOf(chartType), null)
    if (!record?.books?.length) throw new Error('还没有这期榜单，请先抓取')
    return record
  }
}

function buildLimitations(record: FanqieChartRecord, analyzed: number): string[] {
  const notes = [
    '只分析这次抓到的样本，不代表平台全榜。',
    '只有这一期，不能判断热度涨跌，排名也不能证明上榜原因。',
    '没有留存和读者画像；正文仅代表开篇样本，不能证明后续质量或上榜原因。受众和创作建议都是推测。'
  ]
  if (record.chartDate !== localDateString()) notes.push(`榜单日期是 ${record.chartDate}，不是今天。`)
  if (record.isPartial && record.partialReason) notes.push(record.partialReason)
  if (analyzed < record.books.length) notes.push(`有 ${record.books.length - analyzed} 本因书名残缺或重复，没有进入分析。`)
  return notes
}

async function fetchRankPages(pageUrl: string): Promise<FanqieChartBook[]> {
  const books: FanqieChartBook[] = []
  const seen = new Set<string>()
  for (let page = 0; page < PAGES; page++) {
    if (page > 0) await delay(350)
    const url = rankApiUrl(pageUrl, page * PAGE_SIZE, PAGE_SIZE)
    const body = await requestText(url, pageUrl, true)
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error('番茄返回的榜单不是有效数据')
    }
    const batch = parseRankBooks(payload, books.length + 1)
    if (batch.length === 0) break
    for (const book of batch) {
      if (seen.has(book.bookId)) continue
      seen.add(book.bookId)
      books.push({ ...book, rank: books.length + 1 })
    }
    if (batch.length < PAGE_SIZE) break
  }
  return books
}

async function requestText(url: string, referer: string, json = false): Promise<string> {
  const response = await request(url, {
    'User-Agent': USER_AGENT,
    Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: referer
  })
  return response.text()
}

async function requestBytes(url: string): Promise<Buffer> {
  const response = await request(url, { 'User-Agent': USER_AGENT, Accept: '*/*' })
  return Buffer.from(await response.arrayBuffer())
}

async function request(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(25_000) })
    if (response.status === 403 || response.status === 429) {
      throw new Error('番茄暂时限制访问，请过几分钟再试')
    }
    if (!response.ok) throw new Error(`番茄返回 ${response.status}`)
    return response
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('番茄')) throw err
    if (err instanceof Error && (err.name === 'TimeoutError' || /timeout/i.test(err.message))) {
      throw new Error('连接番茄超时，请稍后再试', { cause: err })
    }
    throw new Error('连接番茄失败，请检查网络后重试', { cause: err })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const text = asText(item)
        return text ? `${key}：${text}` : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function coerceIdeas(payload: unknown, books: FanqieChartBook[], limit: number): FanqieChartIdea[] {
  const raw = payload && typeof payload === 'object' ? (payload as { ideas?: unknown }).ideas : undefined
  if (!Array.isArray(raw)) return []
  const evidence = new Map(prepareBooks(books).map((book) => [book.id, book]))
  const ideas: FanqieChartIdea[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const titleCandidates = (Array.isArray(row.titleCandidates) ? row.titleCandidates : Array.isArray(row.title_candidates) ? row.title_candidates : [])
      .map(asText)
      .filter(Boolean)
      .slice(0, 3)
    const title = asText(row.title) || titleCandidates[0] || ''
    const coreConcept = asText(row.coreConcept ?? row.core_concept)
    const hookLine = asText(row.hookLine ?? row.hook_line)
    const openingChapters = coerceIdeaOpeningChapters(row.openingChapters)
    if (!title || !coreConcept || !openingChapters) continue
    ideas.push({
      title,
      titleCandidates: titleCandidates.length ? titleCandidates : [title],
      strategy: asText(row.strategy) || 'fusion',
      genre: asText(row.genre),
      hookLine,
      goldenFinger: asText(row.goldenFinger ?? row.golden_finger),
      fusion: asText(row.fusion),
      coreConcept,
      sellingPoint: asText(row.sellingPoint ?? row.selling_point),
      protagonist: asText(row.protagonist),
      openingHook: asText(row.openingHook ?? row.opening_hook),
      marketReasoning: asText(row.marketReasoning ?? row.market_reasoning),
      readerFit: asText(row.readerFit ?? row.reader_fit),
      riskNotes: asText(row.riskNotes ?? row.risk_notes),
      trendBasis: coerceBasis(row.trendBasis ?? row.trend_basis, evidence),
      openingChapters
    })
    if (ideas.length >= limit) break
  }
  return ideas
}

function coerceIdeaOpeningChapters(value: unknown): FanqieIdeaOpeningChapter[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const chapters: FanqieIdeaOpeningChapter[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const chapter = row.chapter
    if (chapter !== 1 && chapter !== 2 && chapter !== 3) return null
    if (chapters.some(item => item.chapter === chapter)) return null
    const direction: FanqieIdeaOpeningChapter = { chapter, openingEvent: asText(row.openingEvent), protagonistAction: asText(row.protagonistAction),
      conflict: asText(row.conflict), payoff: asText(row.payoff), endHook: asText(row.endHook), summaryApplication: asText(row.summaryApplication) }
    if (Object.values(direction).some(value => value === '')) return null
    chapters.push(direction)
  }
  return chapters.sort((a, b) => a.chapter - b.chapter)
}

function coerceBasis(
  value: unknown,
  books: Map<string, { id: string; title: string; rank: number | null; intro: string; tags: string[] }>
): FanqieIdeaBasis[] {
  if (!Array.isArray(value)) return []
  const basis: FanqieIdeaBasis[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const bookId = asText(row.bookId ?? row.book_id)
    const book = books.get(bookId)
    const field = row.field
    const quote = asText(row.quote)
    if (!book || (field !== 'title' && field !== 'intro' && field !== 'tags') || !quote) continue
    const source = field === 'tags' ? book.tags : field === 'title' ? [book.title] : [book.intro]
    const matches = field === 'tags' ? book.tags.includes(quote) : source.some((text) => text.includes(quote))
    if (!matches) continue
    basis.push({
      bookId,
      title: book.title,
      rank: book.rank,
      field,
      quote,
      mechanism: asText(row.mechanism)
    })
  }
  return basis
}

function hasCompleteOpening(insights: FanqieChartInsight[]): boolean {
  return insights.some(item => item.dimension === 'opening_patterns') && insights.filter(item => item.dimension === 'golden_three_directions').length >= 3
}
