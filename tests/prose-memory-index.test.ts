import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, unlink, stat, utimes } from 'fs/promises'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashProse, ProseMemoryIndex } from '../src/main/data/memory/prose-memory-index'
import { buildCharacterAliasGroups } from '../src/main/data/memory/character-memory-context'

describe('ProseMemoryIndex source evidence', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-prose-recall-'))
    await mkdir(join(dir, '正文'), { recursive: true })
  })

  it('recalls a relevant event beyond the recent twelve chapters with exact source locations', async () => {
    const original = '# 第1章\r\n\r\n雨停了。\r\n\r\n林远把琉璃令牌交给沈清秋。\r\n她将它藏在左袖。\r\n\r\n山门终于打开。'
    await writeFile(join(dir, '正文', '001.md'), original)
    for (let n = 2; n < 30; n++) await writeFile(join(dir, '正文', `${String(n).padStart(3, '0')}.md`), `林远在第${n}天继续赶路。`)
    await writeFile(join(dir, '正文', '030.md'), '林远用琉璃令牌打开天门。')
    const hits = await new ProseMemoryIndex(dir).searchBefore(30, { characters: ['林远'], props: ['琉璃令牌'] })
    expect(hits[0].chapterNumber).toBe(1)
    expect(hits[0].sourcePath).toBe('正文/001.md')
    expect(hits[0].text).toContain('交给沈清秋')
    expect(original.slice(hits[0].startOffset, hits[0].endOffset)).toBe(hits[0].text)
    expect(hits[0].startLine).toBe(5)
    expect(hits[0].endLine).toBe(6)
    expect(hits[0].sourceHash).toBe(hashProse(original))
    expect(hits.some((h) => h.chapterNumber >= 30)).toBe(false)
  })

  it('enforces the character budget and deduplicates repeated paragraphs across chapters', async () => {
    const repeated = '沈清秋把琉璃令牌藏在左袖，准备交还林远。'
    await writeFile(join(dir, '正文', '001.md'), `${repeated}\n\n${repeated}`)
    await writeFile(join(dir, '正文', '002.md'), repeated)
    await writeFile(join(dir, '正文', '003.md'), '琉璃令牌已经裂开。'.repeat(100))
    const index = new ProseMemoryIndex(dir)
    const hits = await index.searchBefore(4, { props: ['琉璃令牌'] }, { maxChars: 70, maxResults: 3 })
    expect(hits.reduce((n, h) => n + h.text.length, 0)).toBeLessThanOrEqual(70)
    expect(hits.length).toBeLessThanOrEqual(3)
    const copies = await index.searchBefore(4, { props: ['琉璃令牌'] }, { excludeChapters: [3] })
    expect(copies).toHaveLength(1)
    expect(copies[0].text).toBe(repeated)
  })

  it('refreshes after equal-length rewrites with restored mtime, then removes deleted evidence', async () => {
    const file = join(dir, '正文', '001.md')
    await writeFile(file, '琉璃令牌已交给沈清秋。')
    const index = new ProseMemoryIndex(dir)
    expect((await index.searchBefore(10, '琉璃令牌'))[0].text).toContain('已交给')
    const before = await stat(file)
    await writeFile(file, '琉璃令牌仍留在林远处。')
    await utimes(file, before.atime, before.mtime)
    const changed = await new ProseMemoryIndex(dir).searchBefore(10, '琉璃令牌')
    expect(changed[0].text).toContain('仍留在')
    expect(changed[0].text).not.toContain('已交给')
    await unlink(file)
    expect(await index.searchBefore(10, '琉璃令牌')).toEqual([])
    const cache = JSON.parse(await readFile(join(dir, '.cache', 'prose-memory-index.json'), 'utf8'))
    expect(cache.chapters).toEqual([])
  })

  it('reuses unchanged indexed passages and rebuilds a damaged cache from real prose', async () => {
    const file = join(dir, '正文', '001.md')
    await writeFile(file, '琉璃令牌藏在左袖。')
    await new ProseMemoryIndex(dir).searchBefore(5, '琉璃令牌')
    const spy = vi.spyOn(fs, 'readFile')
    try {
      await new ProseMemoryIndex(dir).searchBefore(5, '琉璃令牌')
      expect(spy.mock.calls.some(([p]) => String(p) === file)).toBe(false)
    } finally { spy.mockRestore() }
    await writeFile(join(dir, '.cache', 'prose-memory-index.json'), '{damaged')
    expect((await new ProseMemoryIndex(dir).searchBefore(5, '琉璃令牌'))[0].text).toContain('左袖')
  })

  it('selects the same canonical chapter evidence after a title migration and ignores planning files', async () => {
    await writeFile(join(dir, '正文', '001.md'), '琉璃令牌的旧稿。')
    await writeFile(join(dir, '正文', '第001章 新稿.md'), '琉璃令牌的修订正文。')
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第002章_计划.md'), '琉璃令牌将毁灭世界。')
    const hits = await new ProseMemoryIndex(dir).searchBefore(8, '琉璃令牌')
    expect(hits).toHaveLength(1)
    expect(hits[0].sourcePath).toBe('正文/第001章 新稿.md')
    expect(hits[0].text).toBe('琉璃令牌的修订正文。')
  })

  it('recalls an early explicitly recorded alias without replacing the source wording', async () => {
    const original = '青衣客将装着证词的竹筒压在桥下第三块石板后。'
    await writeFile(join(dir, '正文', '001.md'), original)
    await writeFile(join(dir, '正文', '002.md'), '林远在酒馆歇脚。')
    await writeFile(join(dir, '正文', '003.md'), '玄门掌门从未到过桥下。')
    const characterAliases = buildCharacterAliasGroups([{ id: 'lin', name: '林远', createdAt: '', updatedAt: '',
      customFields: { 别名: '青衣客', 身份: '玄门掌门' } }], 50)
    const index = new ProseMemoryIndex(dir)
    const hits = await index.searchBefore(50, { characters: ['林远'], characterAliases })
    const aliasHit = hits.find((hit) => hit.chapterNumber === 1)
    expect(aliasHit?.text).toBe(original)
    expect(aliasHit?.sourceHash).toBe(hashProse(original))
    expect(hits.some((hit) => hit.chapterNumber === 3)).toBe(false)
    const reverse = await index.searchBefore(50, { text: '青衣客', characterAliases })
    expect(reverse.some((hit) => hit.chapterNumber === 2)).toBe(true)
  })

  it('keeps rare early evidence ahead of a frequent protagonist across five hundred chapters', async () => {
    const repeated = '林远检查行囊，确认绳结无损。'
    const earlyKey = '林远亲手把玄霜铜钥交给苏绫。\r\n苏绫把铜钥缝进红色行囊。'
    const earlyCode = '苏绫与林远定下青鹤暗号：三短一长敲门，只在危急时使用。'
    const fileOf = (chapter: number) => join(dir, '正文', `${String(chapter).padStart(3, '0')}.md`)
    const originals = new Map<number, string>()
    // Every chapter repeats the protagonist in several paragraphs; the rare evidence is 489+
    // chapters away. Current/future drafts deliberately contain all rare terms as distractors.
    for (let start = 1; start <= 501; start += 8) {
      await Promise.all(Array.from({ length: Math.min(8, 502 - start) }, async (_, i) => {
        const chapter = start + i
        const special = chapter === 7 ? earlyKey : chapter === 11 ? earlyCode
          : chapter >= 500 ? '林远、苏绫、玄霜铜钥和青鹤暗号的未来结局，尚未发生。'
            : `林远在第${chapter}日穿过城门，向守卫问路。`
        const prose = `# 第${chapter}章\r\n\r\n${special}\r\n\r\n${repeated}\r\n\r\n林远走进第${chapter}家客栈，叫了一壶热茶。`
        originals.set(chapter, prose)
        await writeFile(fileOf(chapter), prose)
      }))
    }
    const query = { characters: ['林远'], props: ['玄霜铜钥', '青鹤暗号', '行囊'], text: '确认苏绫保管的证物和约定。' }
    const opts = { maxChars: 145, maxResults: 6 }
    const firstStarted = performance.now()
    const first = await new ProseMemoryIndex(dir).searchBefore(500, query, opts)
    const firstMs = performance.now() - firstStarted
    const secondStarted = performance.now()
    const second = await new ProseMemoryIndex(dir).searchBefore(500, query, opts)
    const secondMs = performance.now() - secondStarted
    expect(first.slice(0, 2).map((h) => h.chapterNumber).sort((a, b) => a - b)).toEqual([7, 11])
    expect(second).toEqual(first)
    expect(first.every((h) => h.chapterNumber < 500)).toBe(true)
    expect(first.some((h) => h.text.includes('尚未发生'))).toBe(false)
    expect(first.reduce((n, h) => n + h.text.length, 0)).toBeLessThanOrEqual(opts.maxChars)
    expect(first.length).toBeLessThanOrEqual(opts.maxResults)
    expect(first.filter((h) => h.text === repeated)).toHaveLength(1)
    expect(new Set(first.map((h) => h.text.replace(/\s+/g, ''))).size).toBe(first.length)
    for (const hit of first) {
      const source = originals.get(hit.chapterNumber)!
      expect(hit.sourcePath).toBe(`正文/${String(hit.chapterNumber).padStart(3, '0')}.md`)
      expect(source.slice(hit.startOffset, hit.endOffset)).toBe(hit.text)
      expect(hit.sourceHash).toBe(hashProse(source))
      expect(hit.startLine).toBe(1 + (source.slice(0, hit.startOffset).match(/\n/g)?.length ?? 0))
      expect(hit.endLine).toBe(1 + (source.slice(0, hit.endOffset - 1).match(/\n/g)?.length ?? 0))
    }
    const initialCache = JSON.parse(await readFile(join(dir, '.cache', 'prose-memory-index.json'), 'utf8'))
    expect(initialCache.chapters).toHaveLength(499)
    expect(initialCache.chapters.every((c: { chapterNumber: number }) => c.chapterNumber < 500)).toBe(true)

    const rewritten = '# 第7章\r\n\r\n玄霜铜钥仍由林远保管，苏绫从未接手。'
    await writeFile(fileOf(7), rewritten)
    await unlink(fileOf(11))
    const updated = await new ProseMemoryIndex(dir).searchBefore(500, query, opts)
    expect(updated[0].chapterNumber).toBe(7)
    expect(updated[0].text).toContain('仍由林远保管')
    expect(updated[0].sourceHash).toBe(hashProse(rewritten))
    expect(updated.some((h) => h.text.includes('亲手把玄霜铜钥交给'))).toBe(false)
    expect(updated.some((h) => h.chapterNumber === 11 || h.text.includes('三短一长敲门'))).toBe(false)
    const updatedCache = JSON.parse(await readFile(join(dir, '.cache', 'prose-memory-index.json'), 'utf8'))
    expect(updatedCache.chapters).toHaveLength(498)
    expect(updatedCache.chapters.some((c: { chapterNumber: number }) => c.chapterNumber === 11)).toBe(false)
    console.info(`[prose-memory-index 500-chapter fixture] first=${firstMs.toFixed(1)}ms cached=${secondMs.toFixed(1)}ms; 499 eligible chapters; top=${first.slice(0, 2).map((h) => h.chapterNumber).join(',')}; chars=${first.reduce((n, h) => n + h.text.length, 0)}/${opts.maxChars}`)
  })
})
