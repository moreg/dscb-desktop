import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, unlink, stat, utimes } from 'fs/promises'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hashProse, ProseMemoryIndex } from '../src/main/data/memory/prose-memory-index'
import { buildCharacterAliasGroups } from '../src/main/data/memory/character-memory-context'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

describe('ProseMemoryIndex source evidence', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-prose-recall-'))
    await mkdir(join(dir, '正文'), { recursive: true })
  })
  afterEach(() => vi.restoreAllMocks())

  it('reuses the parsed disk index on fully warmed queries and revalidates external index edits', async () => {
    await writeFile(join(dir, '正文', '001.md'), '令牌藏在桥下。')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    const index = new ProseMemoryIndex(dir)
    for (let attempt = 0; attempt < 3; attempt++) await index.searchBefore(3, '令牌')
    const reads = vi.spyOn(fs, 'readFile')
    try {
      expect((await index.searchBefore(3, '令牌'))[0].text).toContain('桥下')
      expect(reads).not.toHaveBeenCalled()
      await writeFile(join(dir, '.cache', 'prose-memory-index.json'), '{damaged')
      expect((await index.searchBefore(3, '令牌'))[0].text).toContain('桥下')
      expect(reads.mock.calls.some(([file]) => String(file).endsWith('prose-memory-index.json'))).toBe(true)
    } finally {
      reads.mockRestore()
    }
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

  it('adds matching short passages from adjacent chapters without spending the primary recall budget', async () => {
    const archive = '潜水队交接了铜阀试验录像。顾宁把样片和签过名的记录封进档案袋，记下小阀门根本没拍进去。'
    const contradiction = '小阀门的编号，就在你交的样片里。'
    const nearby = `沈唯把那张借据翻到背面。\r\n\r\n${contradiction}\r\n\r\n雨水从窗缝里淌了进来。`
    await writeFile(join(dir, '正文', '005.md'), archive)
    await writeFile(join(dir, '正文', '063.md'), '船夫在灶上热了两碗米酒。')
    await writeFile(join(dir, '正文', '064.md'), nearby)
    await writeFile(join(dir, '正文', '065.md'), '小阀门和铜阀试验录像是两回事，样片原件还在。')
    await writeFile(join(dir, '正文', '066.md'), '顾宁查明了小阀门的编号和样片来源。')
    const index = new ProseMemoryIndex(dir)
    const query = { characters: ['顾宁'], props: ['铜阀试验录像'] }
    const opts = { maxChars: archive.length, maxResults: 1, excludeChapters: [65] }
    const main = await index.searchBefore(66, query, opts)
    const withNearby = await index.searchBefore(66, query, { ...opts, nearbyFocus: '那段样片没有拍到小阀门。' })
    expect(main).toHaveLength(1)
    expect(main[0].text).toBe(archive)
    expect(withNearby.slice(0, 1)).toEqual(main)
    expect(withNearby.slice(1)).toEqual([expect.objectContaining({
      chapterNumber: 64, sourcePath: '正文/064.md', sourceHash: hashProse(nearby), startLine: 3, endLine: 3, text: contradiction,
      nearby: { primaryIndex: 0, anchors: expect.arrayContaining(['阀门']) }
    })])
  })

  it('preserves who said a recalled line and whether they believed it, within the original recall budget', async () => {
    const attribution = '阿九听见脚步声，把酒壶一推，模仿掌柜哄客人的腔调。'
    const claim = '“玄霜铜钥早让官差收走了。”'
    const correction = '藏在桌底的钥匙硌着他的膝盖，他没敢伸手。'
    const excerpt = [attribution, claim, correction].join('\r\n\r\n')
    const old = `# 第三章\r\n\r\n${excerpt}\r\n\r\n---\r\n\r\n城外已经起雾了。`
    const file = join(dir, '正文', '003.md')
    await writeFile(file, old)
    await writeFile(join(dir, '正文', '020.md'), '林远从县衙地窖里找回玄霜铜钥。')
    await writeFile(join(dir, '正文', '021.md'), '林远拿着玄霜铜钥出城。')
    const index = new ProseMemoryIndex(dir)
    const query = { props: ['玄霜铜钥'] }
    await index.searchBefore(22, query) // Warm the index with the later chapters.
    const options = { includeAdjacentParagraphs: true, maxChars: excerpt.length, maxResults: 1 }
    const [hit] = await index.searchBefore(20, query, options)
    expect(hit).toMatchObject({ chapterNumber: 3, sourcePath: '正文/003.md', text: excerpt, sourceHash: hashProse(old), startLine: 3, endLine: 7 })
    expect(old.slice(hit.startOffset, hit.endOffset)).toBe(excerpt)
    const [tight] = await index.searchBefore(20, query, { ...options, maxChars: claim.length })
    expect(tight.text).toBe(claim)

    const revisedAttribution = '阿九对着门外拱手，把衙门的查封令摆到了桌上。'
    const revisedCorrection = '他看着门缝下漏进来的那道光，把空匣子也递了过去。'
    const revised = old.replace(attribution, revisedAttribution).replace(correction, revisedCorrection)
    await writeFile(file, revised)
    const [after] = await index.searchBefore(20, query, { ...options, maxChars: revised.length })
    expect(after.text).toContain(revisedAttribution)
    expect(after.text).toContain(revisedCorrection)
    expect(after.text).not.toContain(correction)
    expect(after.sourceHash).toBe(hashProse(revised))
    expect(revised.slice(after.startOffset, after.endOffset)).toBe(after.text)
  })

  it('does not attach unrelated narration across scene breaks to an original quotation', async () => {
    const attribution = '雪梨把那张誊错了字的便笺揉成一团。'
    const clue = '“是铜哨，不是铜锁。”'
    const otherScene = '雨停时，沈唯已经坐上了往北的渡船。'
    const source = [attribution, clue, '---', otherScene].join('\n\n')
    await writeFile(join(dir, '正文', '001.md'), source)
    const [hit] = await new ProseMemoryIndex(dir).searchBefore(8, { props: ['铜哨'] }, { includeAdjacentParagraphs: true })
    expect(hit.text).toBe([attribution, clue].join('\n\n'))
    expect(source.slice(hit.startOffset, hit.endOffset)).toBe(hit.text)
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

  it('checks equal-size rewrites with identical recent timestamps even after that metadata ages', async () => {
    const file = join(dir, '正文', '001.md')
    const first = '林遥把铜哨塞回自己的口袋。'
    const edited = '林遥把铜哨塞进顾宁的口袋。'
    const final = '林遥把铜哨塞进沈唯的口袋。'
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(first))
    expect(Buffer.byteLength(final)).toBe(Buffer.byteLength(first))
    await writeFile(file, first)
    const frozen = await fs.stat(file, { bigint: true })
    const statSource = fs.stat.bind(fs)
    vi.spyOn(fs, 'stat').mockImplementation((path, options) => String(path) === file
      ? Promise.resolve(frozen) : statSource(path, options))
    const now = Number(frozen.ctimeNs / 1_000_000n)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const index = new ProseMemoryIndex(dir)
    const query = { props: ['铜哨'] }
    expect((await index.searchBefore(8, query))[0].text).toBe(first)
    await writeFile(file, edited)
    expect((await index.searchBefore(8, query))[0].text).toBe(edited)
    await writeFile(file, final)
    clock.mockReturnValue(now + 1000)
    expect((await index.searchBefore(8, query))[0]).toMatchObject({ text: final, sourceHash: hashProse(final) })
    const reads = vi.spyOn(fs, 'readFile')
    expect((await index.searchBefore(8, query))[0].text).toBe(final)
    expect(reads.mock.calls.some(([path]) => String(path) === file)).toBe(false)
  })

  it('reuses unchanged indexed passages and rebuilds a damaged cache from real prose', async () => {
    const file = join(dir, '正文', '001.md')
    await writeFile(file, '琉璃令牌藏在左袖。')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
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

  it('keeps recall on the editor’s saved copy when an imported copy has a different ending', async () => {
    const active = '她用铜哨吹了两声，桥底的灯便熄了。那个约好替她守桥的人，还在那里。'
    const imported = '守桥人从未赴约，她把铜哨扔进了河。'
    const file = join(dir, '正文', '001.md')
    await writeFile(file, active)
    await writeFile(join(dir, '正文', '第1章_过桥.md'), imported)
    const index = new ProseMemoryIndex(dir)
    const recalled = await index.searchBefore(20, { props: ['铜哨'] })
    expect(recalled).toHaveLength(1)
    expect(recalled[0]).toMatchObject({ sourcePath: '正文/001.md', text: await new ProseRepo(dir).read(1), sourceHash: hashProse(active) })
    await unlink(file)
    expect((await index.searchBefore(20, { props: ['铜哨'] }))[0]).toMatchObject({ sourcePath: '正文/第1章_过桥.md', text: imported })
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
