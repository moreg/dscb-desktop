import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'

// 用《民国老六》项目的真实文件结构造 fixture
const CHARACTER_STATES = `# 角色状态快照

> 记录核心角色的当前实力、立场、目标、道具、关系和更新章节。

## 当前状态（第 1 卷第 10 章末尾）

| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |
|------|----------|----------|----------|----------|----------|----------|
| 苏九 | 暗劲；铁罗盘 Lv.1（精神力 0%，需休息） | 中立偏苟 | 解决沈清秋的报道威胁 | 运势罗盘、铜钱 | 沈清秋：房东女儿；段老虎：代理人 | 第 10 章 |
| 沈清秋 | 无武功 | 中立偏好奇 | 用报道威胁苏九 | 记者证、相机 | 苏九：被威胁对象 | 第 10 章 |
| 冯将军 | 未登场 | - | - | - | - | - |

## 状态变更记录

| 章节 | 角色 | 变更内容 |
|------|------|----------|
| 第 1 章 | 苏九 | 重生归来，天津码头摆摊 |
| 第 9 章 | 苏九 | 精神力透支 100%，触发借运机制 |
| 第 50 章 | 苏九 | 罗盘升级：铁→铜 |
| 第 100 章 | 苏九 | 后续章节变更 |
`

const TIMELINE = `# 全书时间线

> 小说时间跨度：1923 年深秋 → 1949 年

## 全书时间轴图

\`\`\`mermaid
timeline
    title 全书时间轴
    1923 深秋 : 苏九重生归来
\`\`\`

## 历史事件与小说事件对照表

| 时间 | 历史事件 | 小说事件 | 对应章节 | 对应卷 |
|------|----------|----------|----------|--------|
| 1923 年深秋 | 北洋政府时期 | 苏九重生归来 | 第 1-30 章 | 第 1 卷 |
| 1924 年 | 第二次直奉战争 | 苏九帮冯将军胜出 | 第 31-60 章 | 第 2 卷 |
`

const PROGRESS = `# 日更进度摘要

| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |
|------|------|----------|-----------|--------|
| 2026-07-03 | 第1-10章细纲 | 卷级规划完成 | 第11-12章 | 无 |
| 2026-07-04 | 第11-20章 | 完成第11-20章 | 第21章 | 时间线冲突 |
| 2026-07-05 | 第21-30章 | 完成卷1收尾 | 第31章卷2开篇 | 无 |
`

const ISSUES = `# 问题记录

| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |
|------|----------|----------|----------|------|
| 2026-07-03 | 苏九精神力账目不一致 | 第5章多算了一次消耗 | 回退第5章精神力数值 | 待处理 |
| 2026-07-04 | 沈清秋动机薄弱 | 缺少报社主编授意背景 | 补写主编戏份 | 处理中 |
| 2026-07-04 | 段老虎称呼混乱 | 已修正 | - | 已解决 |
`

describe('TrackingMdRepo', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-track-'))
    await mkdir(path.join(dir, '追踪'), { recursive: true })
  })

  it('returns null when 追踪/ directory does not exist', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'aw-track-empty-'))
    const result = await new TrackingMdRepo(emptyDir).read(5)
    expect(result).toBeNull()
  })

  it('parses character states, state changes, timeline, progress, issues', async () => {
    await writeFile(path.join(dir, '追踪', '角色状态.md'), CHARACTER_STATES)
    await writeFile(path.join(dir, '追踪', '时间线.md'), TIMELINE)
    await writeFile(path.join(dir, '追踪', '上下文.md'), PROGRESS)
    await writeFile(path.join(dir, '追踪', '问题记录.md'), ISSUES)

    const result = await new TrackingMdRepo(dir).read(15)
    expect(result).not.toBeNull()
    expect(result!.characterStates).toHaveLength(3)
    expect(result!.characterStates[0].name).toBe('苏九')
    expect(result!.characterStates[0].power).toContain('暗劲')
    expect(result!.characterStates[0].updateChapter).toBe(10)
    expect(result!.characterStates[2].name).toBe('冯将军')

    // 状态变更截到第 15 章：含第 1/9 章，不含第 50/100 章
    expect(result!.stateChanges).toHaveLength(2)
    expect(result!.stateChanges[0].chapter).toBe(1)
    expect(result!.stateChanges[1].chapter).toBe(9)

    // 时间线取「历史事件与小说事件对照表」节 body
    expect(result!.timeline).toContain('1923 年深秋')
    expect(result!.timeline).toContain('苏九重生归来')

    // 进度摘要取最后 3 条
    expect(result!.recentProgress).toHaveLength(3)
    expect(result!.recentProgress[2].date).toBe('2026-07-05')
    expect(result!.recentProgress[1].blocker).toBe('时间线冲突')

    // 问题记录只取待处理/处理中
    expect(result!.openIssues).toHaveLength(2)
    expect(result!.openIssues[0].problem).toContain('精神力账目')
    expect(result!.openIssues[1].status).toBe('处理中')
  })

  it('filters state changes by chapterNumber correctly', async () => {
    await writeFile(path.join(dir, '追踪', '角色状态.md'), CHARACTER_STATES)
    const result = await new TrackingMdRepo(dir).read(50)
    // 第 50 章应包含第 1/9/50 章，不含第 100 章
    expect(result!.stateChanges).toHaveLength(3)
    expect(result!.stateChanges[2].chapter).toBe(50)
  })

  it('handles partial files (only some exist)', async () => {
    await writeFile(path.join(dir, '追踪', '上下文.md'), PROGRESS)
    const result = await new TrackingMdRepo(dir).read(5)
    expect(result).not.toBeNull()
    expect(result!.characterStates).toEqual([])
    expect(result!.recentProgress).toHaveLength(3)
    expect(result!.timeline).toBe('')
    expect(result!.openIssues).toEqual([])
  })

  it('读开书格式时间线（H1 + 裸表，无 H2 对照节）', async () => {
    // 开书流程产出的格式：# 时间线 + 裸表，无 H2 section
    const openingTimeline = `**版本**：v1.0（2026-01-01 创建）

# 时间线

| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |
|---|---|---|---|---|
| 第 1 章 | 开端 | 1 天 | 主角 | 故事开始 |
| 第 5 章 | 初露锋芒 | - | 林远 | 林远击败赵乾 |
`
    await writeFile(path.join(dir, '追踪', '时间线.md'), openingTimeline)
    const result = await new TrackingMdRepo(dir).read(15)
    expect(result).not.toBeNull()
    // 回退到 doc.body，裸表内容应注入 timeline 字段
    expect(result!.timeline).toContain('开端')
    expect(result!.timeline).toContain('初露锋芒')
    expect(result!.timeline).toContain('林远击败赵乾')
  })

  it('readForDisplay 返回全量数据（不按章号过滤、不截断进度、含全部问题）', async () => {
    await writeFile(path.join(dir, '追踪', '角色状态.md'), CHARACTER_STATES)
    await writeFile(path.join(dir, '追踪', '时间线.md'), TIMELINE)
    await writeFile(path.join(dir, '追踪', '上下文.md'), PROGRESS)
    await writeFile(path.join(dir, '追踪', '问题记录.md'), ISSUES)

    const result = await new TrackingMdRepo(dir).readForDisplay()
    expect(result).not.toBeNull()

    // 状态变更：全量（含第 50/100 章），不按章号过滤
    expect(result!.stateChanges).toHaveLength(4)
    expect(result!.stateChanges[2].chapter).toBe(50)
    expect(result!.stateChanges[3].chapter).toBe(100)

    // 进度：全量 3 条（read 也是 3 条，但 readForDisplay 语义上不截断）
    expect(result!.recentProgress).toHaveLength(3)

    // openIssues：只含待处理/处理中（2 条）
    expect(result!.openIssues).toHaveLength(2)

    // allIssues：含全部（含已解决，3 条）
    expect(result!.allIssues).toHaveLength(3)
    expect(result!.allIssues[2].status).toBe('已解决')
    expect(result!.allIssues[2].problem).toContain('称呼混乱')
  })

  it('readForDisplay 在追踪目录不存在时返回 null', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'aw-track-empty2-'))
    const result = await new TrackingMdRepo(emptyDir).readForDisplay()
    expect(result).toBeNull()
  })

  it('列数不齐的表格不崩溃（用户手写 markdown 常见）', async () => {
    // 角色状态表 7 列，但后面有 3 列的附注行（parseTable 不区分连续块）
    const malformed = `# 角色状态快照

## 当前状态

| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |
|------|----------|----------|----------|----------|----------|----------|
| 苏九 | 暗劲 | 中立 | 苟 | 罗盘 | 无 | 第 10 章 |

> 附注（列数不齐的 pipe 行）：
| 第150章 | 金句 | 补充 |
`
    await writeFile(path.join(dir, '追踪', '角色状态.md'), malformed)

    // 不应抛 undefined.trim() 错误（之前会崩）
    const result = await new TrackingMdRepo(dir).readForDisplay()
    expect(result).not.toBeNull()
    // 正常行应正确解析
    const su = result!.characterStates.find((c) => c.name === '苏九')
    expect(su).toBeDefined()
    expect(su!.power).toBe('暗劲')
    expect(su!.updateChapter).toBe(10)
  })
})
