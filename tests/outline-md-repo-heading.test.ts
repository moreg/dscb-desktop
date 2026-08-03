import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { OutlineMdRepo } from '../src/main/data/skill-format/outline-md-repo'

/**
 * 卷结构的 H2 标题容错。
 *
 * 规范写「## 主线剧情走向」，但实际项目里也有写成「## 主线剧情」的
 * （真实样本：J:\book\大小姐又买下了我的下家公司、师姐每晚敲我门）。
 * 早先按等值匹配，这类项目整段卷结构读不出来；若卷纲文件名也不合规，卷数直接是 0。
 */
describe('OutlineMdRepo 主线剧情标题容错', () => {
  let dir: string

  const outline = (heading: string): string =>
    `# 大纲\n\n## ${heading}\n\n` +
    '### 第1卷：她买下了我住的整栋楼（第 1-30 章）\n\n卷一说明。\n\n' +
    '### 第2卷：三小时见不到你就失眠（第 31-60 章）\n\n卷二说明。\n'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outline-heading-'))
    mkdirSync(join(dir, '大纲'), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('标准标题「主线剧情走向」能解析出卷结构', async () => {
    writeFileSync(join(dir, '大纲', '大纲.md'), outline('主线剧情走向'), 'utf-8')
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.volumes).toHaveLength(2)
    expect(read!.volumes[0]).toMatchObject({
      number: 1,
      name: '她买下了我住的整栋楼',
      chapterStart: 1,
      chapterEnd: 30
    })
  })

  it('简写标题「主线剧情」也能解析出卷结构', async () => {
    writeFileSync(join(dir, '大纲', '大纲.md'), outline('主线剧情'), 'utf-8')
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.volumes).toHaveLength(2)
    expect(read!.volumes[1]).toMatchObject({ number: 2, chapterStart: 31, chapterEnd: 60 })
  })

  it('无关的以「主线」开头的节不会被误当成卷结构源', async () => {
    writeFileSync(
      join(dir, '大纲', '大纲.md'),
      '# 大纲\n\n## 主线人物表\n\n### 第1卷：不该被读到（第 1-30 章）\n',
      'utf-8'
    )
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.volumes).toHaveLength(0)
  })
})

/**
 * 逐章节奏标注表的读取容错。
 *
 * 这条回退路径（节奏图谱缺失/为空时改读大纲表）此前对**所有**真实项目都是死的：
 * 技能写的标题是「逐章节奏标注（与节奏图谱对齐）」带括号，而代码按等值匹配；
 * 且多数项目把整张表直接挂在 H2 底下，而代码只遍历 H3 分卷子节。
 */
describe('OutlineMdRepo 逐章节奏标注回退', () => {
  let dir: string

  const table =
    '| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |\n|---|---|---|---|---|\n' +
    '| 第 1 章 | 静海坠落 | 5 | 1 | 1 |\n| 第 31 章 | 反攻 | 8 | 3 | 2 |\n'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outline-rhythm-'))
    mkdirSync(join(dir, '大纲'), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('标题带括号说明也能命中', async () => {
    writeFileSync(
      join(dir, '大纲', '大纲.md'),
      `# 大纲\n\n## 逐章节奏标注（与节奏图谱对齐）\n\n${table}`,
      'utf-8'
    )
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.rhythmFallback).toHaveLength(2)
    expect(read!.rhythmFallback[0]).toMatchObject({
      chapter: 1,
      title: '静海坠落',
      emotion: 5,
      climax: 1,
      volume: 1,
      actualized: false
    })
  })

  it('整张表直接挂在 H2 下（无 H3 分卷子节）也能读', async () => {
    writeFileSync(join(dir, '大纲', '大纲.md'), `# 大纲\n\n## 逐章节奏标注\n\n${table}`, 'utf-8')
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.rhythmFallback.map((e) => e.chapter)).toEqual([1, 31])
    // 卷号取自表格的「卷」列
    expect(read!.rhythmFallback[1].volume).toBe(2)
  })

  it('按 H3 分卷子节组织时不回归', async () => {
    writeFileSync(
      join(dir, '大纲', '大纲.md'),
      '# 大纲\n\n## 逐章节奏标注（与节奏图谱对齐）\n\n### 第1卷\n\n' +
        '| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |\n|---|---|---|---|---|\n| 第 1 章 | 静海坠落 | 5 | 1 | 1 |\n',
      'utf-8'
    )
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.rhythmFallback).toHaveLength(1)
    expect(read!.rhythmFallback[0].volume).toBe(1)
  })

  it('大纲表为空时回退结果也为空，不误报', async () => {
    writeFileSync(
      join(dir, '大纲', '大纲.md'),
      '# 大纲\n\n## 逐章节奏标注（与节奏图谱对齐）\n\n待补充。\n',
      'utf-8'
    )
    const read = await new OutlineMdRepo(dir).read()
    expect(read!.rhythmFallback).toHaveLength(0)
  })
})
