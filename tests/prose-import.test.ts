import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { buildImportPlan, decodeImportText, prepareProseImport, splitImportText, writeProseImport } from '../src/main/data/prose-import'
import { ChapterService } from '../src/main/data/chapter-service'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const roots: string[] = []
async function temp() { const root = await mkdtemp(join(tmpdir(), 'dscb-prose-import-')); roots.push(root); return root }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(join(tmpdir(), 'dscb-prose-import-'))).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})

describe('prose import', () => {
  it('splits Chinese/numeric headings using original offsets, retaining BOM, CRLF, whitespace and punctuation', () => {
    const text = '\uFEFF第一章 初遇\r\n\r\n  “你好。”\r\n\r\n第二章 来客\r\n他来了。\r\n'
    const parsed = splitImportText('全书.txt', text)
    expect(parsed.issues).toEqual([])
    expect(parsed.chapters.map(c => c.number)).toEqual([1, 2])
    expect(parsed.chapters.map(c => c.content).join('')).toBe(text)
    expect(parsed.chapters[0].content).toContain('  “你好。”\r\n')
  })

  it('sorts 1, 2, 10 numerically and reports only internal missing ranges', () => {
    const plan = buildImportPlan([
      { source: '第10章_归来.md', text: '第十章 归来\n归来。' },
      { source: '第2章_来客.md', text: '第二章 来客\n来客。' },
      { source: '第1章_开场.md', text: '第一章 开场\n开场。' }
    ], '测试')
    expect(plan.chapters.map(c => c.number)).toEqual([1, 2, 10])
    expect(plan.preview.missing).toEqual(['第3—9章'])
    expect(buildImportPlan([{ source: '第20章.txt', text: '中段正文。' }], '').preview.missing).toEqual([])
  })

  it('deduplicates exact copies, withholds conflicting versions, and preserves unaffected chapters', () => {
    const plan = buildImportPlan([
      { source: 'a/第1章.txt', text: '正文甲。' }, { source: 'b/第1章.txt', text: '正文甲。' },
      { source: 'a/第2章.txt', text: '版本甲。' }, { source: 'b/第2章.txt', text: '版本乙。' },
      { source: '第3章.txt', text: '正文丙。' }
    ], '')
    expect(plan.chapters.map(c => c.number)).toEqual([1, 3])
    expect(plan.preview.duplicates).toHaveLength(1)
    expect(plan.preview.issues[0]).toContain('不同版本')
    expect(plan.preview.missing).toEqual([])
  })

  it('withholds identical prose carrying different chapter numbers', () => {
    const plan = buildImportPlan([{ source: 'a.txt', text: '第1章 甲\n一样的正文。' }, { source: 'b.txt', text: '第2章 乙\n一样的正文。' }], '')
    expect(plan.chapters).toEqual([])
    expect(plan.preview.issues[0]).toContain('不同章号')
  })

  it('does not silently drop prefaces, guess unnumbered chapters or combine volume resets', () => {
    for (const text of ['前言。\n第1章 开始\n正文。', '没有章号的正文。', '第1章 开始\n甲。\n第1章 新卷\n乙。', '第1章 目录\n第2章 目录']) {
      const parsed = splitImportText('全书.txt', text)
      expect(parsed.chapters).toHaveLength(0)
      expect(parsed.issues.length).toBeGreaterThan(0)
    }
    expect(splitImportText('第2章.txt', '第一章 开始\n正文。').issues[0]).toContain('冲突')
  })

  it('supports numbered single files with no headings and Chinese digit chapter numbers', () => {
    expect(splitImportText('001_开场.txt', '  保持所有正文。\n').chapters[0]).toMatchObject({ number: 1, title: '开场', content: '  保持所有正文。\n' })
    expect(splitImportText('全文.txt', '第一〇二章 夜话\n夜话。').chapters[0].number).toBe(102)
  })

  it('decodes UTF-8/BOM UTF-16 losslessly and requires explicit legacy encoding', () => {
    expect(decodeImportText(Buffer.from('中文。'), 'auto')).toBe('中文。')
    expect(decodeImportText(Buffer.from('\uFEFF中文。', 'utf16le'), 'auto')).toBe('\uFEFF中文。')
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    expect(() => decodeImportText(gbk, 'auto')).toThrow('正确编码')
    expect(decodeImportText(gbk, 'gb18030')).toBe('中文')
    expect(() => decodeImportText(Buffer.from([0, 0]), 'utf-8')).toThrow()
  })

  it('walks volume folders, excludes project assets, reports unsupported files, and skips links', async () => {
    const root = await temp()
    await mkdir(join(root, '卷一'))
    await mkdir(join(root, '设定'))
    await writeFile(join(root, '卷一', '第1章.txt'), '原文。')
    await writeFile(join(root, '设定', '第2章.md'), '不是正文。')
    await writeFile(join(root, '附件.docx'), 'unsupported')
    const external = await temp()
    await writeFile(join(external, '第3章.txt'), '外部。')
    await symlink(external, join(root, '外部链接'), 'junction')
    const plan = await prepareProseImport([root], 'auto')
    expect(plan.chapters.map(c => c.number)).toEqual([1])
    expect(plan.preview.issues.some(s => s.includes('跳过链接'))).toBe(true)
    expect(plan.preview.issues.some(s => s.includes('docx'))).toBe(true)
  })

  it('imports a minimal book that the real shelf and ChapterService read, without modifying sources', async () => {
    const root = await temp()
    const source = join(root, '原稿.txt')
    const original = '\uFEFF第一章 初遇|约定 & <信>\r\n  “你好。”\r\n\r\n第二章 来客\r\n他来了。\r\n'
    await writeFile(source, original)
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const service = new ProjectService(join(root, '书库'), new LibraryRepository(join(root, 'library.json')), settings)
    const plan = await prepareProseImport([source], 'auto')
    const result = await service.importProse('测试小说', plan)
    expect(result.importedCount).toBe(2)
    expect((await service.listProjects())[0].id).toBe(result.project.id)
    const chapters = new ChapterService(service)
    const list = await chapters.listChapters(result.project.id)
    expect(list.map(c => c.chapterNumber)).toEqual([1, 2])
    expect(list[0].title).toBe('初遇|约定 & <信>')
    expect(list.every(c => c.wordCount > 0 && c.status === 'draft')).toBe(true)
    expect((await chapters.getChapter(result.project.id, 1)).content + (await chapters.getChapter(result.project.id, 2)).content).toBe(original)
    expect(await readFile(source, 'utf8')).toBe(original)
    expect((await readdir(result.project.path)).sort()).toEqual(['大纲', '正文'])
    await expect(service.importProse('测试小说', plan)).rejects.toThrow('同名')
    expect(await readFile(source, 'utf8')).toBe(original)
  })

  it('rejects traversal/reserved names and empty plans before publishing', async () => {
    const root = await temp()
    const plan = buildImportPlan([{ source: '第1章.txt', text: '原文。' }], '')
    for (const name of ['../outside', '..', 'CON', '', '书\n名']) await expect(writeProseImport(root, name, plan)).rejects.toThrow()
    await expect(writeProseImport(root, '空书', buildImportPlan([], ''))).rejects.toThrow('没有可导入')
    expect(await readdir(root)).toEqual([])
  })

  it('reports unavailable sources while retaining readable files', async () => {
    const root = await temp()
    const valid = join(root, '第1章.txt')
    await writeFile(valid, '可读原文。')
    const plan = await prepareProseImport([join(root, 'missing.txt'), valid], 'auto')
    expect(plan.chapters).toHaveLength(1)
    expect(plan.preview.issues[0]).toContain('无法读取')
  })
})
