import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RhythmEntry } from '../src/shared/types'
import { parseRhythmData, serializeRhythmData } from '../src/main/data/skill-format/rhythm-html'
import { RhythmHtmlRepo } from '../src/main/data/skill-format/rhythm-html-repo'
import { ChapterRhythmWriter } from '../src/main/data/skill-format/chapter-rhythm-writer'

const htmlFor = (data: string) => `<html><script>const rhythmData = [${data}];\nconst chart = '保留图表';</script></html>`
const entry = (chapter: number, volume: number | string = 1) => ({
  chapter, title: `第${chapter}章`, emotion: 7, climax: 2, volume, actualized: false
})
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('rhythmData JSON 与 JS 字面量兼容', () => {
  it('reads all 400 JSON chapters and maps eight Chinese volume names by first appearance', () => {
    const names = ['下山风云', '风云际会', '师门旧事', '破境之战', '天外来客', '古道归途', '金仙之路', '天门再启']
    const source = Array.from({ length: 400 }, (_, index) => entry(index + 1, names[Math.floor(index / 50)]))
    source[0].title = '奉命下山'
    source[1].title = '婚书背后的名字'
    const parsed = parseRhythmData(htmlFor(source.map((item) => JSON.stringify(item)).join(', ')))!

    expect(parsed).toHaveLength(400)
    expect(parsed[1]).toMatchObject({ chapter: 2, title: '婚书背后的名字', volume: 1 })
    expect(parsed[50].volume).toBe(2)
    expect(parsed[399]).toMatchObject({ chapter: 400, volume: 8 })
  })

  it('retains legacy JS keys, single quotes, comments, decimals and trailing commas', () => {
    const html = htmlFor(`
      // 第 1 卷，注释内的 ]; 不结束数组
      { chapter: 1, title: '奉命下山', emotion: 7, climax: 3.5, volume: 1, actualized: true },
      /* 第 2 卷 */
      { title: '未分卷', chapter: 2, climax: 0, emotion: 0, actualized: false, volume: 0, },
    `)
    expect(parseRhythmData(html)).toEqual([
      { ...entry(1), title: '奉命下山', climax: 3.5, actualized: true },
      { ...entry(2, 0), title: '未分卷', climax: 0, emotion: 0 }
    ])
  })

  it('reserves explicit numeric volume IDs before assigning names', () => {
    const source = [entry(1, '下山风云'), entry(2, 2), entry(3, '风云际会'), entry(4, '2'), entry(5, '下山风云')]
    expect(parseRhythmData(htmlFor(source.map((item) => JSON.stringify(item)).join(',')))!
      .map((item) => item.volume)).toEqual([1, 2, 3, 2, 1])
  })

  it('decodes escaped legacy titles', () => {
    const html = htmlFor(String.raw`{ chapter: 1, title: '师父\'说\\路\n\x41\u4e2d', emotion: 7, climax: 2, volume: 1, actualized: false }`)
    expect(parseRhythmData(html)![0].title).toBe("师父'说\\路\nA中")
  })

  it('round-trips quotes, backslashes, newlines, array delimiters and replacement-string syntax', () => {
    const original = htmlFor(JSON.stringify(entry(1)))
    const title = "师父'说\"路\\途\n]; $& $` $' </script>\u2028\u2029"
    const entries: RhythmEntry[] = [{ ...entry(1), volume: 1, title }]
    const serialized = serializeRhythmData(original, entries)
    expect(parseRhythmData(serialized)).toEqual(entries)
    expect(serialized.startsWith('<html><script>const rhythmData = [')).toBe(true)
    expect(serialized.endsWith("];\nconst chart = '保留图表';</script></html>")).toBe(true)
    expect(serialized).not.toContain('</script>\u2028')
    expect(serialized).toContain('\\u003c/script>')
  })

  it('keeps original named volumes when serializing chapter changes', () => {
    const original = htmlFor([entry(1, '下山风云'), entry(2, '风云际会')].map((item) => JSON.stringify(item)).join(','))
    const parsed = parseRhythmData(original)!
    parsed[1].title = "她说'认账'"
    parsed[1].actualized = true
    const updated = serializeRhythmData(original, parsed)
    expect(updated).toContain("volume: '下山风云'")
    expect(updated).toContain("volume: '风云际会'")
    expect(parseRhythmData(updated)).toEqual(parsed)
  })

  it('distinguishes missing blocks from empty data and rejects executable expressions', () => {
    expect(parseRhythmData('<html>没有节奏图谱</html>')).toBeNull()
    expect(parseRhythmData(htmlFor(''))).toEqual([])
    expect(parseRhythmData(htmlFor(`{ ...${JSON.stringify(entry(1))} }`))).toEqual([])
    expect(parseRhythmData(htmlFor('{ chapter: 1, title: (() => "不能执行")(), emotion: 7, climax: 2, volume: 1, actualized: false }'))).toEqual([])
    expect(serializeRhythmData('<html>没有节奏图谱</html>', [])).toBe('<html>没有节奏图谱</html>')
  })

  it('skips invalid field types without treating string booleans as actualized', () => {
    const source = [entry(1), { ...entry(2), actualized: 'false' }, { ...entry(3), emotion: '7' }, { ...entry(4), volume: '' }]
    expect(parseRhythmData(htmlFor(source.map((item) => JSON.stringify(item)).join(',')))).toEqual([entry(1)])
  })

  it('supports writer and repository updates without destroying named-volume chart filtering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rhythm-compatibility-'))
    directories.push(directory)
    await mkdir(join(directory, '图解'))
    const file = join(directory, '图解', '节奏图谱.html')
    const html = htmlFor([entry(1, '下山风云'), entry(2, '风云际会')].map((item) => JSON.stringify(item)).join(','))
    await writeFile(file, html, 'utf8')

    const writer = new ChapterRhythmWriter(directory)
    await writer.update(2, { title: "婚书'背后'的名字", climax: 3.5 })
    await writer.markActualized(2)
    expect(await new RhythmHtmlRepo(directory).updateEmotion(2, 9)).toEqual({ previousEmotion: 7, newEmotion: 9 })

    const updated = await readFile(file, 'utf8')
    expect(parseRhythmData(updated)![1]).toMatchObject({
      chapter: 2, title: "婚书'背后'的名字", volume: 2, emotion: 9, climax: 3.5, actualized: true
    })
    expect(updated).toContain("volume: '风云际会'")
    expect(updated).toContain("const chart = '保留图表'")
  })
})
