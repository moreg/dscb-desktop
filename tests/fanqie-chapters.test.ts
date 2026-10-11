import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChapterScraper } from '../src/main/data/fanqie-chart/chapters'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'
import type { FanqieBookDetail } from '../src/shared/fanqie-chart'

describe('番茄正文与章节抓取服务', () => {
  it('用榜单封面补全旧详情缓存，后续不传榜单也能读到封面', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-detail-cover-test-'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求网络'))
    try {
      const bookId = 'test_cover_book'
      const detailFile = path.join(dir, 'fanqie-books', bookId, 'detail.json')
      const existing: FanqieBookDetail = {
        bookId, title: '测试书名', author: '测试作者', cover: '', intro: '测试简介',
        genre: '', wordCount: '', readCount: '', status: '连载中', tags: [],
        chapters: [{ id: 'ch_01', title: '第一章', index: 1, needPay: false, isLocked: false }],
        cachedChapterIds: [], updatedAt: '2026-10-01T00:00:00.000Z'
      }
      await writeJsonAtomic(detailFile, existing)
      const scraper = new FanqieChapterScraper(dir)
      const cover = 'https://p3-reading-sign.fqnovelpic.com/test.jpg'
      const detail = await scraper.getBookDetail(bookId, { cover })
      expect(detail).toEqual({ ...existing, cover })
      expect((await readJson<FanqieBookDetail | null>(detailFile, null))?.cover).toBe(cover)
      expect((await scraper.getBookDetail(bookId))?.cover).toBe(cover)
      expect((await scraper.getBookDetail(bookId, { cover: '' })).cover).toBe(cover)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('正确缓存和列出已下载章节', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-chapters-test-'))
    const scraper = new FanqieChapterScraper(dir)
    const bookId = 'test_book_123'

    const empty = await scraper.listCachedChapterIds(bookId)
    expect(empty).toEqual([])

    // 模拟写入一个缓存章节
    const chapterFile = path.join(dir, 'fanqie-books', bookId, 'chapters', 'ch_01.json')
    await writeJsonAtomic(chapterFile, {
      id: 'ch_01',
      bookId,
      title: '第1章 测试开局',
      bookTitle: '测试书名',
      content: '这是第一段。\n\n这是第二段。',
      url: 'https://fanqienovel.com/reader/ch_01',
      hasGarbled: false,
      wordCount: 12,
      fetchedAt: new Date().toISOString()
    })

    const list = await scraper.listCachedChapterIds(bookId)
    expect(list).toEqual(['ch_01'])

    // 测试 TXT 导出
    // 先写入书籍详情 detail.json
    const detailFile = path.join(dir, 'fanqie-books', bookId, 'detail.json')
    await writeJsonAtomic(detailFile, {
      bookId,
      title: '测试神作',
      author: '大神作者',
      cover: '',
      intro: '这是一本精彩绝伦的爽文。',
      genre: '都市',
      wordCount: '10万字',
      readCount: '20万',
      status: '连载',
      tags: ['系统', '重生'],
      chapters: [
        { id: 'ch_01', title: '第1章 测试开局', index: 1, needPay: false, isLocked: false }
      ],
      cachedChapterIds: ['ch_01'],
      updatedAt: new Date().toISOString()
    })

    const exported = await scraper.exportBookTxt(bookId)
    expect(exported.title).toBe('测试神作')
    expect(exported.chapterCount).toBe(1)
    expect(exported.content).toContain('测试神作')
    expect(exported.content).toContain('大神作者')
    expect(exported.content).toContain('第1章 测试开局')
    expect(exported.content).toContain('这是第一段。')

    // 测试删除缓存
    await scraper.deleteBookCache(bookId)
    const afterDelete = await scraper.listCachedChapterIds(bookId)
    expect(afterDelete).toEqual([])

    await rm(dir, { recursive: true, force: true })
  })
})
