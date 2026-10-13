import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { FanqieChapterScraper } from '../src/main/data/fanqie-chart/chapters'
import { writeJsonAtomic } from '../src/main/data/atomic'
import type { FanqieChapterContent } from '../src/shared/fanqie-chart'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'fanqie-opening-snapshot-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
function content(id: string): FanqieChapterContent {
  return { id, bookId: 'book', title: '第' + id + '章', bookTitle: '书名', content: '主角撕毁契约。'.repeat(20), hasGarbled: false, url: '', wordCount: 100, fetchedAt: '' }
}
async function setup() {
  await writeJsonAtomic(join(root, 'fanqie-books', 'book', 'detail.json'), { chapters: [1, 2, 3].map(id => ({ id: String(id), title: '章名' })) })
  for (const id of ['1', '2', '3']) await writeJsonAtomic(join(root, 'fanqie-books', 'book', 'chapters', id + '.json'), content(id))
  return new FanqieChapterScraper(root)
}
describe('opening chapter snapshots', () => {
  it('avoids warmed JSON reads and returns isolated snapshots', async () => {
    const scraper = await setup()
    const original = await scraper.readCachedOpening('book')
    const reads = vi.spyOn(fs, 'readFile')
    const cached = await scraper.readCachedOpening('book')
    expect(reads).not.toHaveBeenCalled()
    expect(scraper.openingRevision(cached)).toBe(scraper.openingRevision(original))
    cached[0].content = '调用方修改'
    expect((await scraper.readCachedOpening('book'))[0].content).toBe(original[0].content)
  })

  it('rereads only a modified chapter even with restored mtime', async () => {
    const scraper = await setup()
    const original = await scraper.readCachedOpening('book')
    const file = join(root, 'fanqie-books', 'book', 'chapters', '2.json')
    const before = await fs.stat(file)
    await fs.writeFile(file, JSON.stringify({ ...content('2'), content: '新的冲突出现。'.repeat(20) }))
    await fs.utimes(file, before.atime, before.mtime)
    const reads = vi.spyOn(fs, 'readFile')
    const updated = await scraper.readCachedOpening('book')
    expect(updated[1].content).toContain('新的冲突')
    expect(reads).toHaveBeenCalledTimes(1)
    expect(scraper.openingRevision(updated)).not.toBe(scraper.openingRevision(original))
  })

  it('invalidates deleted, newly cached and reordered opening chapters', async () => {
    const scraper = await setup()
    await scraper.readCachedOpening('book')
    const file = join(root, 'fanqie-books', 'book', 'chapters', '1.json')
    await fs.unlink(file)
    expect((await scraper.readCachedOpening('book')).map(chapter => chapter.id)).toEqual(['2', '3'])
    await writeJsonAtomic(file, content('1'))
    await writeJsonAtomic(join(root, 'fanqie-books', 'book', 'detail.json'), { chapters: [{ id: '3' }, { id: '1' }, { id: '2' }] })
    expect((await scraper.readCachedOpening('book')).map(chapter => chapter.id)).toEqual(['3', '1', '2'])
  })
})
