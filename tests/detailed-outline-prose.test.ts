import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * 细纲纯段落节纳入解析结果。
 *
 * 背景：parseBoldFields 只认 `- **字段**：值` 行，`## 情节安排` 这类
 * 纯段落节的内容既不进 ChapterDetail 也不进 prompt，写作时模型看不到。
 * proseSections 负责把这些「没有加粗字段标记」的内容按所属小节收集起来。
 */
describe('细纲纯段落节（proseSections）', () => {
  let projectDir: string

  const perChapterFile = `# 细纲_第004章_特种兵下令我偏要先取火.md

## 第 4 章：特种兵下令，我偏要先取火

- **核心事件**：邹英按军事习惯接管秩序，与邱北争执。
- **章末钩子**：试火。

## 情节安排

邹英把七人分成三组，语气不容置疑。
邱北蹲在礁石边没动，只说了一句"先取火"。

## 追踪关联

- **伏笔埋设**：
  - FB-016 邹英的军牌
`

  const variantFile = `# 细纲：第 5 章 试火

## 基本信息

- **章号**：第 5 章

## 章首钩子

"火折子在我这儿。"她把手摊开，掌心是空的。

## 核心事件

七人围着湿柴折腾了一下午。
`

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'wdesk-prose-'))
    const dir = join(projectDir, '细纲')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '细纲_第004章_特种兵下令我偏要先取火.md'), perChapterFile, 'utf8')
    writeFileSync(join(dir, '细纲_第005章_试火.md'), variantFile, 'utf8')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('标准格式：`## 情节安排` 的纯段落被收进 proseSections（按节标题分组）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch4 = list.find((d) => d.chapterNumber === 4)
    expect(ch4).toBeDefined()
    const plot = ch4!.proseSections?.find((s) => s.title === '情节安排')
    expect(plot).toBeDefined()
    expect(plot!.text).toContain('邹英把七人分成三组')
    expect(plot!.text).toContain('先取火')
  })

  it('段落内的换行被保留（多段剧情不挤成一行）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch4 = list.find((d) => d.chapterNumber === 4)
    const plot = ch4!.proseSections?.find((s) => s.title === '情节安排')
    expect(plot!.text.split('\n')).toHaveLength(2)
  })

  it('只有加粗字段的节不产生 proseSections 条目（不与 rawFields 重复）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch4 = list.find((d) => d.chapterNumber === 4)
    const titles = (ch4!.proseSections ?? []).map((s) => s.title)
    expect(titles).not.toContain('追踪关联')
    // 加粗字段仍走 rawFields，未被 proseSections 抢走
    expect(ch4!.foreshadowings).toEqual(['FB-016 邹英的军牌'])
  })

  it('已并入 plotSummary 的 `## 核心事件` 不再重复出现在 proseSections', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch5 = list.find((d) => d.chapterNumber === 5)
    expect(ch5!.plotSummary).toContain('七人围着湿柴')
    const titles = (ch5!.proseSections ?? []).map((s) => s.title)
    expect(titles).not.toContain('核心事件')
  })

  it('变体格式：`## 章首钩子` 的纯段落同样被收集', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch5 = list.find((d) => d.chapterNumber === 5)
    const hookSec = ch5!.proseSections?.find((s) => s.title === '章首钩子')
    expect(hookSec).toBeDefined()
    expect(hookSec!.text).toContain('火折子在我这儿')
  })

  it('段落之间的空行被保留，`>` 元信息引用块不混入散文', async () => {
    const dir = join(projectDir, '细纲')
    writeFileSync(
      join(dir, '细纲_第007章_两段.md'),
      `# 细纲_第007章_两段.md

> 所属卷：第 1 卷
> 节奏对齐：情绪值 5、爽点类型 1

## 第 7 章：两段

- **核心事件**：字段照旧。

## 情节安排

第一段。

第二段。
`,
      'utf8'
    )
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch7 = list.find((d) => d.chapterNumber === 7)
    const plot = ch7!.proseSections?.find((s) => s.title === '情节安排')
    expect(plot!.text).toBe('第一段。\n\n第二段。')
    const allText = (ch7!.proseSections ?? []).map((s) => s.text).join('\n')
    expect(allText).not.toContain('所属卷')
    expect(allText).not.toContain('节奏对齐')
    // 引用块信息仍走结构化字段
    expect(ch7!.volume).toBe(1)
  })

  it('无纯段落内容时 proseSections 为 undefined 或空', async () => {
    const dir = join(projectDir, '细纲')
    writeFileSync(
      join(dir, '细纲_第006章_全字段.md'),
      `# 细纲_第006章_全字段.md\n\n## 第 6 章：全字段\n\n- **核心事件**：只有字段。\n`,
      'utf8'
    )
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch6 = list.find((d) => d.chapterNumber === 6)
    expect(ch6!.proseSections ?? []).toHaveLength(0)
  })
})
