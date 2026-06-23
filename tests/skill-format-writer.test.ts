import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CharacterCardMdRepo } from '../src/main/data/skill-format/character-card-md-repo'
import { ChapterRhythmWriter } from '../src/main/data/skill-format/chapter-rhythm-writer'
import { OutlineMdRepo } from '../src/main/data/skill-format/outline-md-repo'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { DetailedOutlineWriter } from '../src/main/data/skill-format/detailed-outline-writer'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import { LocationMdRepo } from '../src/main/data/skill-format/location-md-repo'
import { WorldviewMdRepo } from '../src/main/data/skill-format/worldview-md-repo'
import { parseRhythmData } from '../src/main/data/skill-format/rhythm-html'

const SAMPLE = 'O:/book/测试写作'
const HAS = existsSync(join(SAMPLE, '大纲', '大纲.md'))
const describeIf = HAS ? describe : describe.skip

/** 手动逐文件拷贝（cpSync 在 O 盘会硬崩 worker，改用 readFileSync/writeFileSync） */
function copyFile(src: string, dest: string): void {
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, readFileSync(src, 'utf-8'), 'utf-8')
}

describeIf('Phase 3 写入回环（真实样本复制到临时目录）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'v3-write-'))
    copyFile(join(SAMPLE, '记忆系统', '角色卡.md'), join(dir, '记忆系统', '角色卡.md'))
    copyFile(join(SAMPLE, '大纲', '大纲.md'), join(dir, '大纲', '大纲.md'))
    copyFile(join(SAMPLE, '图解', '节奏图谱.html'), join(dir, '图解', '节奏图谱.html'))
    copyFile(join(SAMPLE, '细纲', '第01卷.md'), join(dir, '细纲', '第01卷.md'))
    copyFile(join(SAMPLE, '记忆系统', '伏笔追踪.md'), join(dir, '记忆系统', '伏笔追踪.md'))
    copyFile(join(SAMPLE, '记忆系统', '地点档案.md'), join(dir, '记忆系统', '地点档案.md'))
    copyFile(join(SAMPLE, '记忆系统', '世界观设定.md'), join(dir, '记忆系统', '世界观设定.md'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('角色 create 写入 H3 块，且不破坏既有角色/路人/关系图', async () => {
    const repo = new CharacterCardMdRepo(dir)
    const before = await repo.list()
    await repo.create({ name: '测试新人', role: '核心配角', identity: '神秘人', personality: '冷静' })
    const after = await repo.list()
    expect(after.length).toBe(before.length + 1)
    const created = after.find((c) => c.name === '测试新人')
    expect(created).toBeDefined()
    expect(created!.identity).toBe('神秘人')
    // 既有角色仍在
    expect(after.find((c) => c.name === '苏铭')).toBeDefined()
    // 路人/关系图/关系日志节保留（用原文检查）
    const raw = readFileSync(join(dir, '记忆系统', '角色卡.md'), 'utf-8')
    expect(raw).toContain('人物关系图')
    expect(raw).toContain('关系变更日志')
  })

  it('角色 update 外科手术式：改 personality，保留 行为习惯，清掉 隐性性格', async () => {
    const repo = new CharacterCardMdRepo(dir)
    const updated = await repo.update('苏铭', { personality: '测试新性格' })
    expect(updated).not.toBeNull()
    expect(updated!.rawFields?.['显性性格']).toBe('测试新性格')
    expect(updated!.rawFields?.['行为习惯']).toBeDefined() // 保留
    expect(updated!.rawFields?.['隐性性格']).toBeUndefined() // 清掉避免重复
    // 文件里 苏铭 块仍在，老吴 块未受影响
    const raw = readFileSync(join(dir, '记忆系统', '角色卡.md'), 'utf-8')
    expect(raw).toContain('### 苏铭')
    expect(raw).toContain('### 老吴')
    expect(raw).toContain('测试新性格')
  })

  it('角色 delete 移除指定块，其他角色保留', async () => {
    const repo = new CharacterCardMdRepo(dir)
    const before = await repo.list()
    await repo.delete('老吴')
    const after = await repo.list()
    expect(after.find((c) => c.name === '老吴')).toBeUndefined()
    expect(after.find((c) => c.name === '苏铭')).toBeDefined()
    expect(after.length).toBe(before.length - 1)
  })

  it('ChapterRhythmWriter.update 同步三处：rhythmData + 大纲逐章表 + 细纲节奏标注', async () => {
    const writer = new ChapterRhythmWriter(dir)
    await writer.update(1, { title: '测试新标题', emotion: 9, climax: 3 })

    // 1. rhythmData
    const html = readFileSync(join(dir, '图解', '节奏图谱.html'), 'utf-8')
    const entries = parseRhythmData(html)!
    const e1 = entries.find((e) => e.chapter === 1)
    expect(e1).toMatchObject({ title: '测试新标题', emotion: 9, climax: 3 })
    // 其他章未受影响
    expect(entries.find((e) => e.chapter === 2)?.title).toBe('破窗')

    // 2. 大纲.md 逐章表
    const outlineText = readFileSync(join(dir, '大纲', '大纲.md'), 'utf-8')
    expect(outlineText).toContain('| 第 1 章 | 测试新标题 | 9 | 3 |')

    // 3. 细纲 第01卷.md 第 1 章节奏标注
    const detailText = readFileSync(join(dir, '细纲', '第01卷.md'), 'utf-8')
    expect(detailText).toContain('情绪值：9')
    expect(detailText).toContain('爽点类型：3（大高潮）')
  })

  it('ChapterRhythmWriter.markActualized 把 rhythmData 该章置 true', async () => {
    const writer = new ChapterRhythmWriter(dir)
    const before = parseRhythmData(readFileSync(join(dir, '图解', '节奏图谱.html'), 'utf-8'))!
    expect(before.find((e) => e.chapter === 5)?.actualized).toBe(false)
    await writer.markActualized(5)
    const after = parseRhythmData(readFileSync(join(dir, '图解', '节奏图谱.html'), 'utf-8'))!
    expect(after.find((e) => e.chapter === 5)?.actualized).toBe(true)
    // 其他章未变
    expect(after.find((e) => e.chapter === 6)?.actualized).toBe(false)
  })

  it('细纲 round-trip：写入后重新解析字段一致', async () => {
    const writer = new ChapterRhythmWriter(dir)
    await writer.update(2, { emotion: 8, climax: 4 })
    const details = await new DetailedOutlineMdRepo(dir).listAll()
    const ch2 = details.find((d) => d.chapterNumber === 2)
    expect(ch2?.emotion).toBe(8)
    expect(ch2?.climax).toBe(4)
  })

  it('DetailedOutlineWriter round-trip：写入写作要求后重新解析一致', async () => {
    const writer = new DetailedOutlineWriter(dir)
    await writer.update(2, { writingRequirements: '必须引入反派线索' })
    const details = await new DetailedOutlineMdRepo(dir).listAll()
    const ch2 = details.find((d) => d.chapterNumber === 2)
    expect(ch2?.writingRequirements).toBe('必须引入反派线索')

    // 检查文件内容是否正确写入了本章写作要求
    const detailText = readFileSync(join(dir, '细纲', '第01卷.md'), 'utf-8')
    expect(detailText).toContain('- **本章写作要求**：必须引入反派线索')
  })

  it('大纲 round-trip：标题改后重新解析节奏回退表一致', async () => {
    const writer = new ChapterRhythmWriter(dir)
    await writer.update(10, { title: '第十章新名' })
    const read = await new OutlineMdRepo(dir).read()
    const ch10 = read?.rhythmFallback.find((r) => r.chapter === 10)
    expect(ch10?.title).toBe('第十章新名')
  })

  it('伏笔 create 追加表行，list 含新 id', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    const before = await repo.list()
    const created = await repo.create({ content: '测试新伏笔', expectedCollect: 100, note: '设定' })
    const after = await repo.list()
    expect(after.length).toBe(before.length + 1)
    expect(created.id).toMatch(/^FB-\d{3}$/)
    expect(after.find((f) => f.id === created.id)?.content).toBe('测试新伏笔')
    // 表头与既有行保留
    const raw = readFileSync(join(dir, '记忆系统', '伏笔追踪.md'), 'utf-8')
    expect(raw).toContain('| 伏笔编号 |')
    expect(raw).toContain('FB-001')
  })

  it('伏笔 collect：状态→collected，实际回收章号写入', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    await repo.collect('FB-001', 282)
    const list = await repo.list()
    const ring = list.find((f) => f.id === 'FB-001')
    expect(ring?.status).toBe('collected')
    expect(ring?.actualCollect).toBe(282)
  })

  it('伏笔 delete 移除表行', async () => {
    const repo = new ForeshadowingMdRepo(dir)
    const before = await repo.list()
    await repo.delete('FB-002')
    const after = await repo.list()
    expect(after.find((f) => f.id === 'FB-002')).toBeUndefined()
    expect(after.length).toBe(before.length - 1)
  })

  it('地点 create 追加 ## N. 节，delete 移除', async () => {
    const repo = new LocationMdRepo(dir)
    const before = await repo.list()
    await repo.create({ name: '测试新地点', category: '城市建筑', notes: '特征描述文案' })
    const after = await repo.list()
    expect(after.length).toBe(before.length + 1)
    expect(after.find((l) => l.name === '测试新地点')).toBeDefined()
    // 删除
    await repo.delete('测试新地点')
    const final = await repo.list()
    expect(final.find((l) => l.name === '测试新地点')).toBeUndefined()
  })

  it('世界观 update 改 notes，round-trip 一致', async () => {
    const repo = new WorldviewMdRepo(dir)
    const list = await repo.list()
    const target = list[0]
    await repo.update(target.name, { notes: '测试新内容' })
    const after = await repo.list()
    expect(after.find((w) => w.name === target.name)?.notes).toContain('测试新内容')
  })
})
