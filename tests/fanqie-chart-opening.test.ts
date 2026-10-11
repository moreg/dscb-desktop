import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChartService } from '../src/main/data/fanqie-chart/service'
import { FanqieChapterScraper } from '../src/main/data/fanqie-chart/chapters'
import { writeJsonAtomic } from '../src/main/data/atomic'
import { localDateString } from '../src/main/data/fanqie-chart/parse'
import { saveChartCovers } from '../src/main/data/fanqie-chart/covers'
import type { LlmService } from '../src/main/data/llm-service'
import type { FanqieChartRecord } from '../src/shared/fanqie-chart'

vi.mock('../src/main/data/fanqie-chart/covers', () => ({
  saveChartCovers: vi.fn(async () => ({ stored: 0, directory: '' }))
}))

describe('榜单自动缓存前三章', () => {
  it('读取旧失败提示时列出缺失章节，缓存补齐后不再显示旧失败数量', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-legacy-note-'))
    try {
      const service = new FanqieChartService(dir, {} as LlmService)
      const chartFile = path.join(dir, 'fanqie-charts', 'new_book_male__261.json')
      const oldRecord = { chartType: 'new_book_male:261', books: [{ bookId: 'a', title: '测试书籍' }],
        chapterFetchNote: '前3章抓取结束：1 本书，0 章已缓存；0 本目录失败，1 章正文失败，可重试补抓' }
      await writeJsonAtomic(chartFile, oldRecord)
      await writeJsonAtomic(path.join(dir, 'fanqie-books', 'a', 'detail.json'), {
        title: '测试书籍', chapters: [{ id: '2', title: '第2章 缺失正文' }]
      })
      const note = (await service.list())[0].chapterFetchNote
      expect(note).toContain('正文待补抓：《测试书籍》「第2章 缺失正文」')
      expect(note).toContain('正文未缓存')
      expect((await service.list())[0].chapterFetchNote).toBe(note)
      await writeJsonAtomic(path.join(dir, 'fanqie-books', 'a', 'chapters', '2.json'), {
        content: '已补齐正文'.repeat(20), hasGarbled: false
      })
      const repairedNote = (await service.list())[0].chapterFetchNote
      expect(repairedNote).toContain('1 章已缓存，无待补抓章节')
      expect(repairedNote).not.toContain('1 章正文失败')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('逐章验证缓存，仅抓目录前三章，失败后继续处理其他书籍', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-opening-cache-'))
    try {
      const scraper = new FanqieChapterScraper(dir)
      vi.spyOn(scraper, 'getBookDetail').mockImplementation(async (bookId) => ({
        bookId, title: '测试书籍', author: '', cover: '', intro: '', genre: '',
        wordCount: '', readCount: '', status: '', tags: [], updatedAt: '',
        cachedChapterIds: ['1', '2', '3'],
        chapters: Array.from({ length: 4 }, (_, i) => ({
          id: String(i + 1), title: `第${i + 1}章`, index: i + 1, needPay: false, isLocked: false
        }))
      }))
      const content = vi.spyOn(scraper, 'getChapterContent').mockImplementation(async (bookId, id) => {
        if (bookId === 'a' && id === '2') throw new Error('正文请求失败')
        return { id, bookId, title: '', bookTitle: '', content: '正文内容',
          url: '', hasGarbled: false, wordCount: 4, fetchedAt: '' }
      })
      vi.spyOn(scraper, 'listCachedBooksSummary').mockResolvedValue({ a: 2, b: 3 })
      const messages: string[] = []
      await scraper.fetchMultipleBooksChapters([{ bookId: 'a' }, { bookId: 'b' }], 3,
        (progress) => messages.push(`${progress.status}:${progress.message}`))
      expect(content.mock.calls.map(([bookId, id]) => `${bookId}:${id}`))
        .toEqual(['a:1', 'a:2', 'a:3', 'b:1', 'b:2', 'b:3'])
      expect(messages.at(-1)).toContain('failed:')
      expect(messages.at(-1)).toContain('5 章已缓存')
      expect(messages.at(-1)).toContain('1 章正文失败')
      expect(messages.at(-1)).toContain('正文失败：《测试书籍》第 2 章「第2章」')
      expect(messages.at(-1)).toContain('书籍 ID：a，章节 ID：2')
      expect(messages.at(-1)).toContain('正文请求失败')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([false, true])('复用今日榜单时仍补抓所有书籍，正文异常=%s', async (fail) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-opening-'))
    try {
      const books = Array.from({ length: 12 }, (_, i) => ({
        rank: i + 1, bookId: String(i + 1), title: `测试书籍${i + 1}`,
        author: '', cover: '', genre: '', wordCount: '', readCount: '', intro: '',
        tags: [], url: '', status: '', garbled: false
      }))
      const record: FanqieChartRecord = {
        id: 'new_book_male:261', chartType: 'new_book_male:261', chartDate: localDateString(),
        books, analysis: null, ideas: null, status: 'fetched', targetCount: 30,
        actualCount: 12, isPartial: true, partialReason: '', sourceHash: 'sample',
        fetchedAt: '', updatedAt: ''
      }
      await writeJsonAtomic(path.join(dir, 'fanqie-charts', 'new_book_male__261.json'), record)
      let coversRoot = path.join(dir, 'custom-covers')
      const service = new FanqieChartService(dir, {} as LlmService, async () => coversRoot)
      const fetch = vi.spyOn(service.chapterScraper, 'fetchMultipleBooksChapters')
        .mockImplementation(async (_books, limit, progress) => {
          expect(limit).toBe(3)
          if (fail) throw new Error('目录请求失败')
          progress?.({ bookIndex: 12, totalBooks: 12, bookTitle: '', bookId: '',
            chapterIndex: 3, totalChapters: 3, chapterTitle: '', message: '36章已缓存', status: 'completed' })
          return {}
        })
      const result = await service.fetch(record.chartType, false)
      expect(saveChartCovers).toHaveBeenLastCalledWith(expect.objectContaining({ root: coversRoot }))
      expect(fetch).toHaveBeenCalledWith(books, 3, expect.any(Function), undefined)
      expect(result.books).toHaveLength(12)
      expect(result.chapterFetchNote).toContain(fail ? '目录请求失败' : '36章已缓存')
      expect((await service.list())[0].chapterFetchNote).toBe(result.chapterFetchNote)
      coversRoot = path.join(dir, 'changed-covers')
      await service.fetch(record.chartType, false)
      expect(saveChartCovers).toHaveBeenLastCalledWith(expect.objectContaining({ root: coversRoot }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
