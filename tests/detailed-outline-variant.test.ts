import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DetailedOutlineMdRepo, parseChapterBlock } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * 兼容变体格式：H1 形如「# 细纲：第 N 章 标题」（冒号+空格），
 * 文件名仍为「细纲_第NNN章_标题.md」，但文件内没有「## 第 N 章：标题」H2 章号块。
 *
 * 真实样本：O:/book/恋综直播：全网女嘉宾都馋我 共 300 章，全部采用此变体。
 * 在解析器加兼容回退之前，所有章节都被 parseFile 的 `if (!chSec) return []` 静默丢弃。
 */
describe('DetailedOutlineMdRepo 变体格式兼容', () => {
  let projectDir: string

  // 变体格式样本：H1 用「细纲：第 N 章 标题」，无「## 第N章」H2 章号块。
  // 富字段散落在「基本信息」/「核心事件」/「追踪关联」等 H2 节里。
  const variantFile = `# 细纲：第 1 章 4位女嘉宾同时指向角落发呆的他

## 基本信息

- **章号**：第 1 章
- **标题**：4位女嘉宾同时指向角落发呆的他
- **卷号**：第一卷
- **字数目标**：2500 字
- **目标情绪**：7
- **爽点类型**：2
- **关键转折点**：KP-001（开篇钩子：4位女嘉宾同时选苏晨）

## 章首钩子

"那个……能不能麻烦角落那位发呆的先生，过来一下？"

## 核心事件

节目开录第一天，6位女嘉宾按规则选第一位约会男嘉宾。

## 本章爽点

- **爽点类型**：开篇冲击 + 弹幕炸场
- **爽点描述**：4位顶流女嘉宾无视顶流男嘉宾陆景行，齐刷刷指向角落发呆的素人苏晨。

## 人物关系和出场顺序

- **视角**：苏晨视角为主
- **出场顺序**：苏晨 → 江晚晴（电话）→ 顾明远（控制室）→ 陆景行（C 位）→ 林若初 → 唐小棠

## 结尾设定和钩子

- **结尾类型**：钩子 + 留悬念
- **结尾描述**：苏晨在休息区偷看「桃花源」APP。
- **下章钩子**：弹幕炸成什么样？

## 追踪关联

- **伏笔埋设**：
  - FB-001 月老血脉
  - FB-002 前世羁绊
- **节奏图谱对齐**：emotion=7 climax=2 volume=1
`

  // 标准格式样本（确保不回归）：H1 用下划线，文件内有「## 第N章」H2 章号块
  const standardFile = `# 细纲_第002章_弹幕炸了.md

## 第 2 章：弹幕炸了

- **核心事件**：弹幕炸成烟花
- **章末钩子**：他到底什么来头？
- **字数预估**：2500
- **节奏标注**：
  - 情绪值：8
  - 爽点类型：3
`

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'wdesk-variant-'))
    const dir = join(projectDir, '细纲')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '细纲_第001章_4位女嘉宾同时指向角落发呆的他.md'), variantFile, 'utf8')
    writeFileSync(join(dir, '细纲_第002章_弹幕炸了.md'), standardFile, 'utf8')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('变体格式（H1 冒号+无 H2 章号块）能被解析出来', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    expect(list).toHaveLength(2)
  })

  it('变体格式提取出正确的章号和标题', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    expect(ch1!.title).toBe('4位女嘉宾同时指向角落发呆的他')
  })

  it('变体格式从「基本信息」节提取卷号（中文数字「第一卷」→ 1）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    expect(ch1!.volume).toBe(1)
  })

  it('变体格式从「基本信息」节提取目标情绪/爽点类型（纯数字字段值）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    expect(ch1!.emotion).toBe(7)
    expect(ch1!.climax).toBe(2)
  })

  it('变体格式提取伏笔/钩子等富字段', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    // 变体里「伏笔埋设」字段（标准格式用「伏笔铺设」），应被识别
    expect(ch1!.foreshadowings).toEqual(['FB-001 月老血脉', 'FB-002 前世羁绊'])
    expect(ch1!.wordEstimate).toContain('2500')
  })

  it('变体格式从 H2 节纯段落体提取核心事件（plotSummary）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    // 变体格式「## 核心事件」节体是纯段落，应通过 extractSectionBody 回退提取
    expect(ch1!.plotSummary).toBeDefined()
    expect(ch1!.plotSummary).toContain('6位女嘉宾')
  })

  it('变体格式提取爽点描述（coolPoint 别名）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    // 变体用「爽点描述」字段，应作为 coolPoint 的别名被识别
    expect(ch1!.coolPoint).toBeDefined()
    expect(ch1!.coolPoint).toContain('4位顶流女嘉宾')
  })

  it('变体格式提取下章钩子/结尾描述（hook 别名）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    // 变体用「下章钩子」字段，应作为 hook 的别名被识别
    expect(ch1!.hook).toBeDefined()
    expect(ch1!.hook).toContain('弹幕炸成什么样')
  })

  it('变体格式提取角色出场列表（「出场顺序」字段，按 → 分隔）', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch1 = list.find((d) => d.chapterNumber === 1)
    expect(ch1).toBeDefined()
    expect(ch1!.charactersAppearing).toBeDefined()
    expect(ch1!.charactersAppearing!.length).toBeGreaterThan(0)
    expect(ch1!.charactersAppearing).toContain('苏晨')
    expect(ch1!.charactersAppearing).toContain('林若初')
  })

  it('标准格式不被回归', async () => {
    const list = await new DetailedOutlineMdRepo(projectDir).listAll()
    const ch2 = list.find((d) => d.chapterNumber === 2)
    expect(ch2).toBeDefined()
    expect(ch2!.title).toBe('弹幕炸了')
    expect(ch2!.plotSummary).toContain('弹幕炸成烟花')
    expect(ch2!.emotion).toBe(8)
    expect(ch2!.climax).toBe(3)
  })
})

describe('parseChapterBlock 字段提取', () => {
  it('目标情绪纯数字值能被提取', () => {
    const body = `- **目标情绪**：7
- **爽点类型**：2`
    const d = parseChapterBlock('第 1 章：测试', body)
    expect(d).not.toBeNull()
    expect(d!.emotion).toBe(7)
    expect(d!.climax).toBe(2)
  })

  it('目标情绪带「情绪值：」前缀仍能被提取（不回归）', () => {
    const body = `- **目标情绪**：情绪值：7`
    const d = parseChapterBlock('第 1 章：测试', body)
    expect(d).not.toBeNull()
    expect(d!.emotion).toBe(7)
  })
})
