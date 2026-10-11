import { promises as fs } from 'fs'
import path from 'path'
import type {
  FanqieBatchFetchProgress,
  FanqieBookDetail,
  FanqieChapterContent,
  FanqieChapterItem,
  FanqieChartBook,
  FanqieExportTxtResult,
  FanqieMultiBookItem,
  FanqieMultiBookProgress
} from '../../../shared/fanqie-chart'
import { readJson, writeJsonAtomic } from '../atomic'
import { decryptPrivateChars } from './glyph-match'
import { correctTitle, extractFontUrls, fixCoverUrl, formatReadCount, restoreText } from './parse'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unescapeHtml(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function isPuaChar(ch: string): boolean {
  const cp = ch.charCodeAt(0)
  return cp >= 0xe000 && cp <= 0xf8ff
}

function countWords(text: string): number {
  return (text.match(/[\u4e00-\u9fa5\w]/g) ?? []).length
}

async function request(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(25_000)
    })
    if (response.status === 403 || response.status === 429) {
      throw new Error('番茄小说暂时限制访问或触发风控，请过几分钟再试')
    }
    if (!response.ok) {
      throw new Error(`番茄请求失败，状态码: ${response.status}`)
    }
    return response
  } catch (err) {
    if (signal?.aborted) throw new Error('操作已取消', { cause: err })
    throw err
  }
}

async function requestText(url: string, referer: string, isJson = false, signal?: AbortSignal): Promise<string> {
  const response = await request(
    url,
    {
      'User-Agent': USER_AGENT,
      Accept: isJson ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: referer
    },
    signal
  )
  return response.text()
}

async function requestBytes(url: string, referer?: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await request(
    url,
    {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      ...(referer ? { Referer: referer } : {})
    },
    signal
  )
  return Buffer.from(await response.arrayBuffer())
}

export class FanqieChapterScraper {
  constructor(private readonly userData: string) {}

  private booksDir(): string {
    return path.join(this.userData, 'fanqie-books')
  }

  private bookDir(bookId: string): string {
    return path.join(this.booksDir(), bookId)
  }

  private detailFile(bookId: string): string {
    return path.join(this.bookDir(bookId), 'detail.json')
  }

  private chaptersDir(bookId: string): string {
    return path.join(this.bookDir(bookId), 'chapters')
  }

  private chapterFile(bookId: string, chapterId: string): string {
    return path.join(this.chaptersDir(bookId), `${chapterId}.json`)
  }

  /** 旧抓取记录没有失败明细时，用本地缓存核对当前缺失章节，不请求网络。 */
  async inspectOpeningCache(books: FanqieMultiBookItem[], chapterLimit = 3): Promise<string> {
    let cachedChapters = 0
    const issues: string[] = []
    for (const book of books) {
      const detail = await readJson<FanqieBookDetail | null>(this.detailFile(book.bookId), null)
      const title = detail?.title || book.title || book.bookId
      if (!detail?.chapters.length) {
        issues.push(`目录未缓存：《${title}》（书籍 ID：${book.bookId}）`)
        continue
      }
      for (const chapter of detail.chapters.slice(0, chapterLimit)) {
        const cached = await readJson<FanqieChapterContent | null>(this.chapterFile(book.bookId, chapter.id), null)
        if (cached && !cached.hasGarbled && cached.content.trim().length > 50) {
          cachedChapters += 1
        } else {
          issues.push(`正文待补抓：《${title}》「${chapter.title}」（书籍 ID：${book.bookId}，章节 ID：${chapter.id}）— ${cached ? '正文缓存为空、过短或含未还原字符' : '正文未缓存'}`)
        }
      }
    }
    return `当前前${chapterLimit}章缓存检查：${books.length} 本书，${cachedChapters} 章已缓存${issues.length ? `\n${issues.join('\n')}` : '，无待补抓章节'}\n此前抓取失败的明细未记录，以上为当前缓存状态。`
  }

  private fontCacheDir(): string {
    return path.join(this.userData, 'fanqie-charts')
  }

  /** 只读取目录前三章的有效本地正文，分析时不发起网络抓取。 */
  async readCachedOpening(bookId: string): Promise<FanqieChapterContent[]> {
    const detail = await readJson<FanqieBookDetail | null>(this.detailFile(bookId), null)
    const result: FanqieChapterContent[] = []
    for (const chapter of detail?.chapters.slice(0, 3) ?? []) {
      const cached = await readJson<FanqieChapterContent | null>(this.chapterFile(bookId, chapter.id), null)
      if (cached?.bookId === bookId && cached.id === chapter.id && !cached.hasGarbled && cached.content.trim().length > 50) {
        result.push(cached)
      }
    }
    return result
  }

  async listCachedChapterIds(bookId: string): Promise<string[]> {
    try {
      const files = await fs.readdir(this.chaptersDir(bookId))
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  /** 列出本地所有书籍已缓存的章节总数（bookId -> cachedCount） */
  async listCachedBooksSummary(): Promise<Record<string, number>> {
    const root = this.booksDir()
    const summary: Record<string, number> = {}
    try {
      const dirs = await fs.readdir(root)
      for (const bookId of dirs) {
        try {
          const files = await fs.readdir(this.chaptersDir(bookId))
          const count = files.filter((f) => f.endsWith('.json')).length
          if (count > 0) summary[bookId] = count
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return summary
  }

  /** 获取书籍详情和章节列表 */
  async getBookDetail(
    bookId: string,
    knownBook?: Partial<FanqieChartBook>,
    force = false,
    signal?: AbortSignal
  ): Promise<FanqieBookDetail> {
    const existing = await readJson<FanqieBookDetail | null>(this.detailFile(bookId), null)
    const cachedIds = await this.listCachedChapterIds(bookId)
    if (!force && existing && existing.chapters.length > 0) {
      let changed = false
      if (!existing.cover && knownBook?.cover) {
        existing.cover = fixCoverUrl(knownBook.cover)
        changed = Boolean(existing.cover)
      }
      if (cachedIds.length !== existing.cachedChapterIds.length) {
        existing.cachedChapterIds = cachedIds
        changed = true
      }
      if (changed) {
        await writeJsonAtomic(this.detailFile(bookId), existing)
      }
      return existing
    }

    // 1. 尝试从官方目录接口获取章节列表（无乱码）
    const chapters: FanqieChapterItem[] = []
    try {
      const dirUrl = `https://fanqienovel.com/api/reader/directory/detail?bookId=${bookId}`
      const dirJsonStr = await requestText(dirUrl, `https://fanqienovel.com/page/${bookId}`, true, signal)
      const dirData = JSON.parse(dirJsonStr) as {
        code?: number
        data?: {
          allItemIds?: string[]
          chapterListWithVolume?: Array<Array<Record<string, unknown>>>
        }
      }
      if (dirData.code === 0 && dirData.data?.chapterListWithVolume) {
        let index = 1
        for (const volume of dirData.data.chapterListWithVolume) {
          if (!Array.isArray(volume)) continue
          for (const item of volume) {
            const id = String(item.itemId || item.id || '').trim()
            if (!id) continue
            chapters.push({
              id,
              title: String(item.title || item.chapterName || `第${index}章`).trim(),
              index,
              needPay: Boolean(item.needPay || item.isPaidStory || item.isPaidPublication),
              isLocked: Boolean(item.isChapterLock),
              volumeName: typeof item.volume_name === 'string' ? item.volume_name : undefined
            })
            index++
          }
        }
      }
    } catch {
      // 目录接口失败时继续尝试页面解析
    }

    // 2. 如果章节为空，或者元数据不全，抓取书籍页面
    let title = knownBook?.title || existing?.title || ''
    let author = knownBook?.author || existing?.author || ''
    let cover = knownBook?.cover || existing?.cover || ''
    let intro = knownBook?.intro || existing?.intro || ''
    const genre = knownBook?.genre || existing?.genre || ''
    let wordCount = knownBook?.wordCount || existing?.wordCount || ''
    let readCount = knownBook?.readCount || existing?.readCount || ''
    let status = knownBook?.status || existing?.status || ''
    const tags = knownBook?.tags || existing?.tags || []

    if (!title || chapters.length === 0 || !intro) {
      try {
        const pageUrl = `https://fanqienovel.com/page/${bookId}`
        const html = await requestText(pageUrl, 'https://fanqienovel.com/', false, signal)

        if (!title) {
          const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
          if (h1Match) title = unescapeHtml(h1Match[1].replace(/<[^>]+>/g, '').trim())
        }
        if (!author) {
          const authorMatch = html.match(/class="author-name[^>]*>([^<]+)</)
          if (authorMatch) author = unescapeHtml(authorMatch[1].trim())
        }
        if (!intro) {
          const introMatch = html.match(/class="page-abstract-content[^>]*>([\s\S]*?)<\/div>/)
          if (introMatch) intro = unescapeHtml(introMatch[1].replace(/<[^>]+>/g, '').trim()).slice(0, 1000)
        }
        if (!cover) {
          const coverMatch = html.match(/class="[^"]*book-cover-img[^"]*"[^>]*(?:data-src|src)="([^"]*)"/)
          if (coverMatch) cover = fixCoverUrl(coverMatch[1])
        }
        if (!wordCount) {
          const wordMatch = html.match(/class="info-label[^"]*"[^>]*>([^<]+字)</)
          if (wordMatch) wordCount = wordMatch[1].trim()
        }
        if (!readCount) {
          const readMatch = html.match(/class="info-label[^"]*"[^>]*>([^<]+在读)</)
          if (readMatch) readCount = formatReadCount(readMatch[1].replace(/在读/, ''))
        }
        if (!status) {
          const statusMatch = html.match(/class="info-label-yellow"[^>]*>([^<]+)</)
          if (statusMatch) status = statusMatch[1].trim()
        }

        // 提取页面上的 reader 链接作为章节候补
        if (chapters.length === 0) {
          const readerLinks = [...html.matchAll(/href="\/reader\/(\d+)"[^>]*>([^<]+)</g)]
          const seen = new Set<string>()
          let index = 1
          for (const match of readerLinks) {
            const cid = match[1]
            if (seen.has(cid)) continue
            seen.add(cid)
            chapters.push({
              id: cid,
              title: unescapeHtml(match[2].trim()),
              index: index++,
              needPay: false,
              isLocked: false
            })
          }
        }
      } catch {
        // 允许静默失败，使用已有信息
      }
    }

    const detail: FanqieBookDetail = {
      bookId,
      title: title || `书籍 ${bookId}`,
      author: author || '未知',
      cover: cover || '',
      intro: intro || '',
      genre: genre || '',
      wordCount: wordCount || '',
      readCount: readCount || '',
      status: status || '',
      tags: tags || [],
      chapters,
      cachedChapterIds: cachedIds,
      updatedAt: new Date().toISOString()
    }

    await fs.mkdir(this.bookDir(bookId), { recursive: true })
    await writeJsonAtomic(this.detailFile(bookId), detail)
    return detail
  }

  /** 获取单个章节正文（含字体解密） */
  async getChapterContent(
    bookId: string,
    chapterId: string,
    knownChapterTitle?: string,
    knownBookTitle?: string,
    force = false,
    signal?: AbortSignal
  ): Promise<FanqieChapterContent> {
    const file = this.chapterFile(bookId, chapterId)
    const cached = await readJson<FanqieChapterContent | null>(file, null)
    if (!force && cached && !cached.hasGarbled && cached.content.length > 50) {
      return cached
    }

    const readerUrl = `https://fanqienovel.com/reader/${chapterId}`
    const html = await requestText(readerUrl, `https://fanqienovel.com/page/${bookId}`, false, signal)

    // 提取书名
    let bookTitle = knownBookTitle || ''
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
    if (h1Match) {
      bookTitle = unescapeHtml(h1Match[1].replace(/<[^>]+>/g, '').trim())
    }

    // 提取章节标题
    let title = knownChapterTitle || ''
    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    if (titleMatch) {
      let pageTitle = unescapeHtml(titleMatch[1].trim())
      pageTitle = pageTitle
        .replace(/在线免费阅读_番茄小说官网$/, '')
        .replace(/_番茄小说官网$/, '')
        .trim()
      if (bookTitle && pageTitle.startsWith(bookTitle)) {
        pageTitle = pageTitle.slice(bookTitle.length).trim()
      }
      if (pageTitle) title = pageTitle
    }

    // 提取正文内容
    let rawContent = ''
    const contentMatch = html.match(/<div[^>]*class="muye-reader-content[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (contentMatch) {
      rawContent = contentMatch[1]
      rawContent = rawContent
        .replace(/<p[^>]*>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
      rawContent = unescapeHtml(rawContent).trim()
    } else {
      // SSR 降级解析
      const ssrMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?<\/script>)/)
      if (ssrMatch) {
        try {
          const jsonStr = ssrMatch[1].replace(/<\/script>.*$/, '').trim()
          const state = JSON.parse(jsonStr) as Record<string, unknown>
          const reader = state.reader as Record<string, unknown> | undefined
          if (reader?.content && typeof reader.content === 'string') {
            rawContent = unescapeHtml(reader.content.replace(/<[^>]+>/g, '\n')).trim()
          }
        } catch {
          // SSR 解析失败
        }
      }
    }

    if (!rawContent) {
      throw new Error('未抓取到正文，番茄小说疑似限制访问或该章节为空')
    }

    // 检查加密字符
    const privateChars = new Set<string>()
    for (const ch of rawContent) {
      if (isPuaChar(ch)) privateChars.add(ch)
    }
    for (const ch of title) {
      if (isPuaChar(ch)) privateChars.add(ch)
    }
    for (const ch of bookTitle) {
      if (isPuaChar(ch)) privateChars.add(ch)
    }

    let decryptedContent = rawContent
    let decryptedTitle = title
    let decryptedBookTitle = bookTitle

    if (privateChars.size > 0) {
      const fontUrls = extractFontUrls(html)
      const fontUrl = fontUrls.find((u) => u.endsWith('.woff')) ?? fontUrls[0]
      if (fontUrl) {
        try {
          const fontBytes = await requestBytes(fontUrl, readerUrl, signal)
          if (fontBytes.length > 1000) {
            const map = await decryptPrivateChars(fontBytes, [...privateChars], this.fontCacheDir())
            decryptedContent = restoreText(rawContent, map, 50)
            decryptedTitle = correctTitle(restoreText(title, map, 0))
            decryptedBookTitle = correctTitle(restoreText(bookTitle, map, 0))
          }
        } catch (fontErr) {
          console.warn(`字体解密失败，将保留原始编码: ${fontErr instanceof Error ? fontErr.message : String(fontErr)}`)
        }
      }
    }

    // 段落排版整理
    const paragraphs = decryptedContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const formattedContent = paragraphs.join('\n\n')

    const hasGarbled = /[\uE000-\uF8FF□]/.test(formattedContent)
    const wordCount = countWords(formattedContent)

    const record: FanqieChapterContent = {
      id: chapterId,
      bookId,
      title: decryptedTitle || `章节 ${chapterId}`,
      bookTitle: decryptedBookTitle,
      content: formattedContent,
      url: readerUrl,
      hasGarbled,
      wordCount,
      fetchedAt: new Date().toISOString()
    }

    await fs.mkdir(this.chaptersDir(bookId), { recursive: true })
    await writeJsonAtomic(file, record)

    // 更新 detail 的已缓存章节集合
    const cachedIds = await this.listCachedChapterIds(bookId)
    const detail = await readJson<FanqieBookDetail | null>(this.detailFile(bookId), null)
    if (detail) {
      detail.cachedChapterIds = cachedIds
      await writeJsonAtomic(this.detailFile(bookId), detail)
    }

    return record
  }

  /** 批量抓取章节正文 */
  async fetchChaptersBatch(
    bookId: string,
    limit = 10,
    chapterIds?: string[],
    onProgress?: (progress: FanqieBatchFetchProgress) => void,
    signal?: AbortSignal
  ): Promise<FanqieChapterContent[]> {
    const detail = await this.getBookDetail(bookId, undefined, false, signal)
    const targets = chapterIds?.length
      ? detail.chapters.filter((ch) => chapterIds.includes(ch.id))
      : detail.chapters.slice(0, limit)

    if (targets.length === 0) {
      throw new Error('没有可抓取的章节')
    }

    const results: FanqieChapterContent[] = []
    const total = targets.length

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) {
        onProgress?.({
          bookId,
          current: i,
          total,
          chapterTitle: '',
          message: '抓取已取消',
          status: 'failed'
        })
        throw new Error('抓取已取消')
      }

      const ch = targets[i]
      onProgress?.({
        bookId,
        current: i + 1,
        total,
        chapterTitle: ch.title,
        message: `正在抓取并解密「${ch.title}」 (${i + 1}/${total})`,
        status: 'running'
      })

      try {
        const content = await this.getChapterContent(
          bookId,
          ch.id,
          ch.title,
          detail.title,
          false,
          signal
        )
        results.push(content)
      } catch (err) {
        console.warn(`章节抓取失败 ${ch.title} (${ch.id}): ${err instanceof Error ? err.message : String(err)}`)
      }

      if (i < total - 1) {
        await delay(350)
      }
    }

    onProgress?.({
      bookId,
      current: total,
      total,
      chapterTitle: '',
      message: `抓取完成，成功获取 ${results.length} 章正文`,
      status: 'completed'
    })

    return results
  }

  /**
   * 批量抓取多本书的前 N 章（默认为黄金三章 3 章）
   * 自动跳过已缓存满 N 章的书籍，具备中断控制与流式进度反馈
   */
  async fetchMultipleBooksChapters(
    books: FanqieMultiBookItem[],
    chapterLimit = 3,
    onProgress?: (progress: FanqieMultiBookProgress) => void,
    signal?: AbortSignal
  ): Promise<Record<string, number>> {
    const totalBooks = books.length
    let failedBooks = 0
    let failedChapters = 0
    let completedChapters = 0
    const failures: string[] = []
    for (let bi = 0; bi < totalBooks; bi++) {
      if (signal?.aborted) throw new Error('批量抓取已取消')
      const b = books[bi]
      const bookTitle = b.title || '未知书名'

      onProgress?.({
        bookIndex: bi + 1,
        totalBooks,
        bookTitle,
        bookId: b.bookId,
        chapterIndex: 0,
        totalChapters: chapterLimit,
        chapterTitle: '',
        message: `正在获取《${bookTitle}》目录 (${bi + 1}/${totalBooks})`,
        status: 'running'
      })

      let detail: FanqieBookDetail
      try {
        detail = await this.getBookDetail(b.bookId, { title: b.title }, false, signal)
      } catch (err) {
        if (signal?.aborted) throw new Error('批量抓取已取消', { cause: err })
        failedBooks += 1
        failures.push(`目录失败：《${bookTitle}》（书籍 ID：${b.bookId}）— ${err instanceof Error ? err.message : String(err)}`)
        console.warn(`获取《${bookTitle}》目录失败:`, err)
        continue
      }

      // 交给 getChapterContent 校验缓存，空正文或乱码缓存也要重试。
      const targets = detail.chapters.slice(0, chapterLimit)
      const totalToFetch = targets.length

      if (totalToFetch === 0) {
        failedBooks += 1
        failures.push(`目录失败：《${detail.title || bookTitle}》（书籍 ID：${b.bookId}）— 没有可抓取的章节目录`)
        onProgress?.({
          bookIndex: bi + 1,
          totalBooks,
          bookTitle: detail.title,
          bookId: b.bookId,
          chapterIndex: chapterLimit,
          totalChapters: chapterLimit,
          chapterTitle: '',
          message: `《${detail.title}》没有可抓取的章节目录`,
          status: 'running'
        })
        continue
      }

      for (let ci = 0; ci < totalToFetch; ci++) {
        if (signal?.aborted) throw new Error('批量抓取已取消')
        const ch = targets[ci]

        onProgress?.({
          bookIndex: bi + 1,
          totalBooks,
          bookTitle: detail.title,
          bookId: b.bookId,
          chapterIndex: ci + 1,
          totalChapters: totalToFetch,
          chapterTitle: ch.title,
          message: `正在抓取《${detail.title}》第 ${ci + 1}/${totalToFetch} 章: ${ch.title} (书籍 ${bi + 1}/${totalBooks})`,
          status: 'running'
        })

        try {
          const content = await this.getChapterContent(b.bookId, ch.id, ch.title, detail.title, false, signal)
          if (content.hasGarbled || !content.content.trim()) throw new Error('正文为空或含未还原字符')
          completedChapters += 1
        } catch (err) {
          if (signal?.aborted) throw new Error('批量抓取已取消', { cause: err })
          failedChapters += 1
          failures.push(`正文失败：《${detail.title || bookTitle}》第 ${ci + 1} 章「${ch.title}」（书籍 ID：${b.bookId}，章节 ID：${ch.id}）— ${err instanceof Error ? err.message : String(err)}`)
          console.warn(`抓取章节失败 《${detail.title}》${ch.title}:`, err)
        }

        await delay(300)
      }
    }

    onProgress?.({
      bookIndex: totalBooks,
      totalBooks,
      bookTitle: '',
      bookId: '',
      chapterIndex: chapterLimit,
      totalChapters: chapterLimit,
      chapterTitle: '',
      message: `前${chapterLimit}章抓取结束：${totalBooks} 本书，${completedChapters} 章已缓存${failedBooks || failedChapters ? `；${failedBooks} 本目录失败，${failedChapters} 章正文失败，可重试补抓\n${failures.join('\n')}` : ''}`,
      status: failedBooks || failedChapters ? 'failed' : 'completed'
    })

    return this.listCachedBooksSummary()
  }

  /** 导出已下载章节为 TXT 格式 */
  async exportBookTxt(bookId: string): Promise<FanqieExportTxtResult> {
    const detail = await this.getBookDetail(bookId)
    const cachedIds = await this.listCachedChapterIds(bookId)
    if (cachedIds.length === 0) {
      throw new Error('当前书籍还没有已下载的章节正文，请先抓取正文')
    }

    const chapters: FanqieChapterContent[] = []
    for (const ch of detail.chapters) {
      if (cachedIds.includes(ch.id)) {
        const item = await readJson<FanqieChapterContent | null>(this.chapterFile(bookId, ch.id), null)
        if (item) chapters.push(item)
      }
    }

    if (chapters.length === 0) {
      throw new Error('未能读取到有效的章节正文')
    }

    let totalWords = 0
    const lines: string[] = []
    lines.push('============================================================')
    lines.push(`  ${detail.title}`)
    lines.push('============================================================')
    lines.push('')
    lines.push(`作者：${detail.author}`)
    if (detail.genre) lines.push(`分类：${detail.genre}`)
    if (detail.status) lines.push(`状态：${detail.status}`)
    if (detail.wordCount) lines.push(`字数：${detail.wordCount}`)
    lines.push('')
    lines.push('────────────────────────────────────────────────────────────')
    if (detail.intro) {
      lines.push('【简介】')
      lines.push(detail.intro)
      lines.push('')
    }
    lines.push('============================================================')
    lines.push('')

    for (const [index, ch] of chapters.entries()) {
      totalWords += ch.wordCount
      lines.push('')
      lines.push('★★★★★★★★★★★★★★★★★★★★')
      lines.push(`  第${index + 1}章 ${ch.title.replace(/^第\d+章\s*/, '')}`)
      lines.push('★★★★★★★★★★★★★★★★★★★★')
      lines.push('')
      const paras = ch.content.split('\n\n')
      for (const p of paras) {
        if (p.trim()) lines.push(`\u3000\u3000${p.trim()}`)
      }
      lines.push('')
      lines.push('────────────────────────────────────────────────────────────')
    }

    return {
      title: detail.title,
      content: lines.join('\n'),
      chapterCount: chapters.length,
      wordCount: totalWords
    }
  }

  /** 删除某本书的所有本地章节正文缓存 */
  async deleteBookCache(bookId: string): Promise<void> {
    await fs.rm(this.bookDir(bookId), { recursive: true, force: true })
  }
}
