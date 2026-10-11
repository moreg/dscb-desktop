import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedCoverUrl, sanitizePathPart, saveChartCovers, sniffCoverImage } from '../src/main/data/fanqie-chart/covers'
import type { FanqieChartBook } from '../src/shared/fanqie-chart'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

function book(patch: Partial<FanqieChartBook>): FanqieChartBook {
  return {
    rank: 1,
    bookId: '111',
    title: '说好去修仙',
    author: '作者',
    cover: 'https://p3-reading-sign.fqnovelpic.com/cover.jpg',
    genre: '都市',
    wordCount: '1000',
    readCount: '1万',
    intro: '简介',
    tags: [],
    url: 'https://fanqienovel.com/page/111',
    status: '连载',
    garbled: false,
    ...patch
  }
}

function jpegResponse(): Response {
  return new Response(JPEG, {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) }
  })
}

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fq-covers-'))
  dirs.push(dir)
  return dir
}

describe('番茄封面保存', () => {
  it('只接受番茄和图片 CDN 的地址', () => {
    expect(isAllowedCoverUrl('https://p6-novel.byteimg.com/a.jpg')).toBe(true)
    expect(isAllowedCoverUrl('https://p3-reading-sign.fqnovelpic.com/a.jpg')).toBe(true)
    expect(isAllowedCoverUrl('https://evil-fanqienovel.com/a.jpg')).toBe(false)
    expect(isAllowedCoverUrl('https://fanqienovel.com.evil/a.jpg')).toBe(false)
    expect(isAllowedCoverUrl('file:///C:/Windows/win.ini')).toBe(false)
  })

  it('书名里的路径符号不会跑出分类目录', () => {
    expect(sanitizePathPart('..\\..\\outside', 'book_1')).toBe('.._.._outside')
    expect(sanitizePathPart('CON', 'book_1')).toBe('book_1')
    expect(sanitizePathPart('   ', 'book_1')).toBe('book_1')
  })

  it('拒绝网页冒充的封面', () => {
    expect(sniffCoverImage(JPEG, 'application/octet-stream')).toBe('.jpg')
    expect(() => sniffCoverImage(Buffer.from('<html>nope</html>'), 'text/html')).toThrow('封面不是有效图片')
  })

  it('按榜单和分类用书名落盘，再次抓取不重复下载', async () => {
    const root = await tempRoot()
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return jpegResponse()
    }
    const first = await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [book({})],
      fetchImpl
    })
    const saved = path.join(root, '男频新书榜', '都市日常', '说好去修仙.jpg')
    expect(first.saved).toBe(1)
    expect(first.directory).toBe(path.join(root, '男频新书榜', '都市日常'))
    expect(await readFile(saved)).toEqual(JPEG)

    const second = await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [book({})],
      fetchImpl
    })
    expect(second.skipped).toBe(1)
    expect(second.saved).toBe(0)
    expect(calls).toBe(1)
  })

  it('同名不同书加编号，不覆盖已有文件', async () => {
    const root = await tempRoot()
    const fetchImpl = async (): Promise<Response> => jpegResponse()
    await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [book({ bookId: '111', title: '回到过去' })],
      fetchImpl
    })
    await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [book({ bookId: '222', title: '回到过去' })],
      fetchImpl
    })
    const dir = path.join(root, '男频新书榜', '都市日常')
    expect(await readFile(path.join(dir, '回到过去.jpg'))).toEqual(JPEG)
    expect(await readFile(path.join(dir, '回到过去_222.jpg'))).toEqual(JPEG)
  })

  it('坏域名和假图片记失败，不写文件', async () => {
    const root = await tempRoot()
    const result = await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [
        book({ bookId: '1', cover: 'https://evil.example/a.jpg' }),
        book({ bookId: '2', cover: 'https://p3-reading-sign.fqnovelpic.com/a.jpg', title: '假图' })
      ],
      fetchImpl: async () => new Response(Buffer.from('<html>nope</html>'), { status: 200, headers: { 'content-type': 'text/html' } })
    })
    expect(result.failed).toBe(2)
    expect(result.saved).toBe(0)
    await expect(readFile(path.join(root, '男频新书榜', '都市日常', '假图.jpg'))).rejects.toThrow()
  })

  it('盘上已有同名文件时补索引，不重下', async () => {
    const root = await tempRoot()
    const dir = path.join(root, '男频新书榜', '都市日常')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '说好去修仙.jpg'), JPEG)
    let calls = 0
    const result = await saveChartCovers({
      root,
      chartType: 'new_book_male:261',
      books: [book({})],
      fetchImpl: async () => {
        calls += 1
        return jpegResponse()
      }
    })
    expect(calls).toBe(0)
    expect(result.saved).toBe(0)
    expect(result.stored).toBe(1)
    const index = JSON.parse(await readFile(path.join(root, '_index.json'), 'utf-8')) as {
      books: Record<string, { paths: string[] }>
    }
    expect(index.books['111'].paths).toEqual(['男频新书榜/都市日常/说好去修仙.jpg'])
  })
})
