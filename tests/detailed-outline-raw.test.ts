import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * readRaw：读取某章细纲的磁盘原文，供「查看完整细纲」弹窗展示。
 *
 * 关键点：listAll() 只收加粗字段行，纯段落节（`## 情节安排` 下的散文）
 * 在结构化结果里看不到；readRaw 必须原样返回。
 */
describe('DetailedOutlineMdRepo.readRaw', () => {
  let projectDir: string

  // 标准格式：每章一文件，有 H2 章号块 + 扩展节（含纯段落）
  const perChapterFile = `# 细纲_第004章_特种兵下令我偏要先取火.md

## 第 4 章：特种兵下令，我偏要先取火

- **核心事件**：邹英按军事习惯接管秩序，与邱北争执。
- **章末钩子**：试火。
- **字数预估**：3000 字

## 情节安排

邹英把七人分成三组，语气不容置疑。邱北蹲在礁石边没动，只说了一句"先取火"。
两人对峙了整整半分钟，最后各退一步。

## 追踪关联

- **伏笔埋设**：
  - FB-016 邹英的军牌
`

  // 变体格式：H1 用冒号，文件内无 H2 章号块
  const variantFile = `# 细纲：第 5 章 试火

## 基本信息

- **章号**：第 5 章

## 核心事件

七人围着湿柴折腾了一下午。
`

  // 旧格式：每卷一文件，多章共存
  const perVolumeFile = `# 第 2 卷

## 第 20 章：登船

- **核心事件**：七女登船。

## 第 21 章：断电

- **核心事件**：船上全黑。
`

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'wdesk-raw-'))
    const dir = join(projectDir, '细纲')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '细纲_第004章_特种兵下令我偏要先取火.md'), perChapterFile, 'utf8')
    writeFileSync(join(dir, '细纲_第005章_试火.md'), variantFile, 'utf8')
    writeFileSync(join(dir, '第02卷.md'), perVolumeFile, 'utf8')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('每章一文件：返回整份文件原文（含扩展节的纯段落）', async () => {
    const raw = await new DetailedOutlineMdRepo(projectDir).readRaw(4)
    expect(raw).not.toBeNull()
    expect(raw!.fileName).toBe('细纲_第004章_特种兵下令我偏要先取火.md')
    expect(raw!.text).toBe(perChapterFile)
    // 纯段落节是 listAll() 拿不到的内容，正是弹窗要补上的
    expect(raw!.text).toContain('两人对峙了整整半分钟')
  })

  it('原文保留结构化结果丢弃的 md 标记与排版', async () => {
    const repo = new DetailedOutlineMdRepo(projectDir)
    const detail = (await repo.listAll()).find((d) => d.chapterNumber === 4)
    expect(detail).toBeDefined()
    // 纯段落内容现已进入 proseSections（见 detailed-outline-prose.test.ts），
    // 但字段的 md 标记、节标题层级、原始换行只有 readRaw 能给出
    const structured = JSON.stringify(detail)
    expect(structured).not.toContain('- **核心事件**：')
    const raw = await repo.readRaw(4)
    expect(raw!.text).toContain('- **核心事件**：')
    expect(raw!.text).toContain('## 情节安排')
  })

  it('变体格式（H1 冒号、无 H2 章号块）也能按章号命中', async () => {
    const raw = await new DetailedOutlineMdRepo(projectDir).readRaw(5)
    expect(raw).not.toBeNull()
    expect(raw!.fileName).toBe('细纲_第005章_试火.md')
    expect(raw!.text).toContain('七人围着湿柴折腾了一下午')
  })

  it('每卷一文件：只截取该章的 H2 块，不泄露同卷其他章', async () => {
    const raw = await new DetailedOutlineMdRepo(projectDir).readRaw(20)
    expect(raw).not.toBeNull()
    expect(raw!.fileName).toBe('第02卷.md')
    expect(raw!.text).toContain('## 第 20 章：登船')
    expect(raw!.text).toContain('七女登船')
    expect(raw!.text).not.toContain('船上全黑')
  })

  it('章号不存在时返回 null', async () => {
    const raw = await new DetailedOutlineMdRepo(projectDir).readRaw(999)
    expect(raw).toBeNull()
  })

  it('细纲目录不存在时返回 null 而非抛错', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wdesk-raw-empty-'))
    try {
      const raw = await new DetailedOutlineMdRepo(empty).readRaw(1)
      expect(raw).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
