import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import { LocationRepo } from '../src/main/data/memory/location-repo'
import { WorldviewRepo } from '../src/main/data/memory/worldview-repo'
import { TimelineRepo } from '../src/main/data/memory/timeline-repo'
import { PlotPointRepo } from '../src/main/data/memory/plot-point-repo'
import { RelationshipRepo } from '../src/main/data/memory/relationship-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'

async function setupProject(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(root, 'mem-repo-'))
  // 新结构目录
  for (const sub of ['人物', '地点', '世界观', '时间线', '剧情点', '关系', '伏笔', '道具']) {
    await mkdir(path.join(dir, '记忆', sub), { recursive: true })
  }
  await mkdir(path.join(dir, '设定', '角色'), { recursive: true })
  await mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
  await mkdir(path.join(dir, '细纲'), { recursive: true })
  await mkdir(path.join(dir, '追踪'), { recursive: true })
  await writeFile(path.join(dir, '记忆', '索引.md'), '# 记忆索引\n', 'utf-8')
  return dir
}

// ============ CharacterRepo ============

describe('CharacterRepo', () => {
  let root: string
  let dir: string
  let repo: CharacterRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-char-'))
    dir = await setupProject(root)
    repo = new CharacterRepo(dir)
  })

  it('读 记忆/人物/*.md（主源）', async () => {
    await writeFile(
      path.join(dir, '记忆', '人物', '苏铭.md'),
      `# 苏铭

## 基本信息

- **身份**：大学生
- **阵营**：普通人

## 性格

- **显性性格**：沉稳
- **隐性性格**：果断

## 当前状态

- **当前状态**：第 10 章精神力透支
`
    )

    const chars = await repo.list()
    expect(chars).toHaveLength(1)
    expect(chars[0].name).toBe('苏铭')
    expect(chars[0].identity).toBe('大学生')
    expect(chars[0].personality).toBe('沉稳；果断')
    expect(chars[0].synopsis).toContain('第 10 章')
    expect(chars[0].customFields?.['当前状态']).toContain('第 10 章')
  })

  it('主源空时 fallback 到 设定/角色/*.md', async () => {
    await writeFile(
      path.join(dir, '设定', '角色', '林小溪.md'),
      `# 林小溪

## 基本信息

- **身份**：记者
- **阵营**：报社

## 性格

- **显性性格**：机智
`
    )

    const chars = await repo.list()
    expect(chars).toHaveLength(1)
    expect(chars[0].name).toBe('林小溪')
    expect(chars[0].identity).toBe('记者')
  })

  it('主源与 fallback 同名时主源胜出', async () => {
    await writeFile(
      path.join(dir, '记忆', '人物', '苏铭.md'),
      `# 苏铭\n\n## 基本信息\n\n- **身份**：主源身份\n`
    )
    await writeFile(
      path.join(dir, '设定', '角色', '苏铭.md'),
      `# 苏铭\n\n## 基本信息\n\n- **身份**：fallback 身份\n`
    )

    const chars = await repo.list()
    expect(chars).toHaveLength(1)
    expect(chars[0].identity).toBe('主源身份')
  })

  it('create 写到 记忆/人物/<name>.md，list 能读回', async () => {
    const c = await repo.create({ name: '新角色', identity: '测试' })
    expect(c.name).toBe('新角色')
    const chars = await repo.list()
    expect(chars.find((x) => x.name === '新角色')).toBeDefined()
  })

  it('customFields 与 first-class 同时存在，UI 不互斥', async () => {
    await writeFile(
      path.join(dir, '记忆', '人物', '段老虎.md'),
      `# 段老虎

## 基本信息

- **身份**：帮派头目

## 自定义分组

- **独门绝学**：铁砂掌
- **口头禅**：哼
`
    )
    const chars = await repo.list()
    const seg = chars[0]
    expect(seg.identity).toBe('帮派头目')
    expect(seg.customFields?.['独门绝学']).toBe('铁砂掌')
    expect(seg.customFields?.['口头禅']).toBe('哼')
  })

  it('update 的 customFields 浅合并：未列出的 key 保留', async () => {
    await writeFile(
      path.join(dir, '记忆', '人物', '苏铭.md'),
      `# 苏铭

## 自定义分组

- **独门绝学**：铁砂掌
- **口头禅**：哼
`
    )
    const created = (await repo.list()).find((c) => c.name === '苏铭')!
    // 只 patch 一个 key，另一个应保留
    await repo.update(created.id, { customFields: { '状态轨迹': '伤势：轻伤' } })
    const after = (await repo.list()).find((c) => c.name === '苏铭')!
    expect(after.customFields?.['状态轨迹']).toBe('伤势：轻伤')
    expect(after.customFields?.['独门绝学']).toBe('铁砂掌')
  })

  it('create/update 往返：role 与 identity 字段不串位', async () => {
    const created = await repo.create({
      name: '林远',
      role: '主角',
      identity: '剑修'
    })
    expect(created.role).toBe('主角')
    expect(created.identity).toBe('剑修')

    const listed = (await repo.list()).find((c) => c.name === '林远')!
    expect(listed.identity).toBe('剑修')
    expect(listed.role).toBe('主角')

    const raw = await readFile(path.join(dir, '记忆', '人物', '林远.md'), 'utf-8')
    expect(raw).toContain('**身份**：剑修')
    expect(raw).toContain('**角色定位**：主角')
    expect(raw).not.toMatch(/\*\*身份\*\*：主角/)
  })

  it('含特殊字符的角色名：create 后 update/delete 路径一致', async () => {
    const name = '张三:？/测试'
    const created = await repo.create({ name, identity: '路人' })
    // 显示名保留原文
    expect(created.name).toBe(name)
    // 文件名已 sanitize（无路径分隔符）
    const files = await readdir(path.join(dir, '记忆', '人物'))
    expect(files.some((f) => f.includes('/') || f.includes(':'))).toBe(false)
    expect(files.some((f) => f.endsWith('.md'))).toBe(true)

    const updated = await repo.update(created.id, { identity: '配角' })
    expect(updated?.identity).toBe('配角')
    expect(updated?.name).toBe(name)

    const afterList = await repo.list()
    expect(afterList.find((c) => c.id === created.id)?.identity).toBe('配角')

    await repo.delete(created.id)
    expect((await repo.list()).find((c) => c.id === created.id)).toBeUndefined()
  })
})

// ============ LocationRepo ============

describe('LocationRepo', () => {
  let root: string
  let dir: string
  let repo: LocationRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-loc-'))
    dir = await setupProject(root)
    repo = new LocationRepo(dir)
  })

  it('读 记忆/地点/*.md', async () => {
    await writeFile(
      path.join(dir, '记忆', '地点', '大学图书馆.md'),
      `# 大学图书馆

## 描述

5 层开放式阅览空间

## 字段

- **类型**：城市建筑
- **关联角色**：
  - 苏铭
  - 林小溪
`
    )
    const locs = await repo.list()
    expect(locs).toHaveLength(1)
    expect(locs[0].name).toBe('大学图书馆')
    expect(locs[0].category).toBe('城市建筑')
    expect(locs[0].notes).toBe('5 层开放式阅览空间')
    expect(locs[0].customFields?.['关联角色']).toEqual(['苏铭', '林小溪'])
  })

  it('fallback 解析 设定/世界观/地理.md 的 H2 节', async () => {
    await writeFile(
      path.join(dir, '设定', '世界观', '地理.md'),
      `# 地理

## 青云山

- **类型**：山脉
- **特征描述**：云雾缭绕，主角拜师之地
- **关联角色**：苏铭

## 天玄宗

- **类型**：门派
- **特征描述**：东域第一大派
`
    )
    const locs = await repo.list()
    expect(locs).toHaveLength(2)
    expect(locs.map((l) => l.name).sort()).toEqual(['天玄宗', '青云山'])
    expect(locs[0].category).toMatch(/山脉|门派/)
  })

  it('主源与 fallback 都为空返回 []', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('create 写到 记忆/地点/<name>.md', async () => {
    const loc = await repo.create({ name: '新地点', category: '场所', notes: '测试' })
    expect(loc.name).toBe('新地点')
    const locs = await repo.list()
    expect(locs.some((l) => l.name === '新地点')).toBe(true)
  })
})

// ============ WorldviewRepo ============

describe('WorldviewRepo', () => {
  let root: string
  let dir: string
  let repo: WorldviewRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-wv-'))
    dir = await setupProject(root)
    repo = new WorldviewRepo(dir)
  })

  it('读 记忆/世界观/*.md（含子目录）', async () => {
    await mkdir(path.join(dir, '记忆', '世界观', '力量'), { recursive: true })
    await writeFile(
      path.join(dir, '记忆', '世界观', '力量', '境界体系.md'),
      `# 境界体系

觉醒 5 级：初觉 / 微觉 / 小成 / 大成 / 圆满。
`
    )
    await writeFile(
      path.join(dir, '记忆', '世界观', '金手指.md'),
      `# 金手指

运势罗盘：每日一次运势预测。
`
    )

    const wvs = await repo.list()
    expect(wvs).toHaveLength(2)
    expect(wvs.map((w) => w.name).sort()).toEqual(['境界体系', '金手指'])
  })

  it('fallback 枚举 设定/世界观/*.md', async () => {
    await writeFile(path.join(dir, '设定', '世界观', '背景设定.md'), `# 背景设定\n\n1923 年深秋...\n`)
    await writeFile(path.join(dir, '设定', '世界观', '力量体系.md'), `# 力量体系\n\n觉醒分级\n`)

    const wvs = await repo.list()
    expect(wvs).toHaveLength(2)
    expect(wvs.map((w) => w.name).sort()).toEqual(['力量体系', '背景设定'])
  })

  it('create 写到 记忆/世界观/<name>.md', async () => {
    await repo.create({ name: '势力格局', notes: '北方军阀 / 南方革命党' })
    const wvs = await repo.list()
    expect(wvs.find((w) => w.name === '势力格局')).toBeDefined()
  })
})

// ============ TimelineRepo ============

describe('TimelineRepo', () => {
  let root: string
  let dir: string
  let repo: TimelineRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-tl-'))
    dir = await setupProject(root)
    repo = new TimelineRepo(dir)
  })

  it('读 追踪/时间线.md 对照表，每行一个事件', async () => {
    await writeFile(
      path.join(dir, '追踪', '时间线.md'),
      `# 时间线

## 历史事件与小说事件对照表

| 时间 | 历史事件 | 小说事件 | 对应章节 | 对应卷 |
|------|----------|----------|----------|--------|
| 1923 深秋 | 北洋时期 | 苏九重生归来 | 第 1-30 章 | 第 1 卷 |
| 1924 | 第二次直奉战争 | 帮冯将军胜出 | 第 31-60 章 | 第 2 卷 |
`
    )
    const events = await repo.list()
    expect(events).toHaveLength(2)
    expect(events[0].name).toBe('苏九重生归来')
    expect(events[0].notes).toBe('北洋时期')
    expect(events[0].customFields?.['对应章节']).toBe('第 1-30 章')
    expect(events[0].customFields?.['对应卷']).toBe('第 1 卷')
  })

  it('主源空返回 []（不读 记忆/时间线/，那是派生缓存）', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('解析对照表缺失时返回 []，不抛错', async () => {
    await writeFile(path.join(dir, '追踪', '时间线.md'), '# 时间线\n\n没有对照表\n')
    expect(await repo.list()).toEqual([])
  })

  it('读开书格式（H1 + 裸表，表头 章节|事件名|时间跨度|涉及角色|详细描述）', async () => {
    // 开书流程 writeTrackingFiles 产出的格式：只有 H1 + 裸表，无 H2 对照节
    await writeFile(
      path.join(dir, '追踪', '时间线.md'),
      `**版本**：v1.0（2026-01-01 创建）

# 时间线

| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |
|---|---|---|---|---|
| 第 1 章 | 开端 | 1 天 | 主角 | 故事开始 |
| 第 5 章 | 初露锋芒 | - | 林远 | 林远击败赵乾 |
`
    )
    const events = await repo.list()
    expect(events).toHaveLength(2)
    expect(events[0].name).toBe('开端')
    expect(events[0].customFields?.['对应章节']).toBe('第 1 章')
    expect(events[1].name).toBe('初露锋芒')
    expect(events[1].customFields?.['对应章节']).toBe('第 5 章')
  })
})

// ============ PlotPointRepo ============

describe('PlotPointRepo', () => {
  let root: string
  let dir: string
  let repo: PlotPointRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-pp-'))
    dir = await setupProject(root)
    repo = new PlotPointRepo(dir)
  })

  it('读 记忆/剧情点/*.md', async () => {
    await writeFile(
      path.join(dir, '记忆', '剧情点', '第001章 困兽.md'),
      `# 第 1 章 困兽

## 描述

孢子灾害初现

## 字段

- **核心事件**：苏铭被变异兽围攻
- **爽点/打脸**：罗盘砸退 BOSS
- **伏笔**：孢子污染源
`
    )
    const plots = await repo.list()
    expect(plots).toHaveLength(1)
    expect(plots[0].name).toBe('第 1 章 困兽')
    expect(plots[0].notes).toContain('苏铭被变异兽围攻')
    expect(plots[0].customFields?.['核心事件']).toContain('苏铭被变异兽围攻')
  })

  it('fallback 解析 细纲/细纲_第NNN章_*.md', async () => {
    await writeFile(
      path.join(dir, '细纲', '细纲_第005章_黑市.md'),
      `# 第 5 章 黑市

## 字段

- **核心事件**：苏九潜入黑市买情报
- **爽点/打脸**：识破骗子
`
    )
    const plots = await repo.list()
    expect(plots).toHaveLength(1)
    expect(plots[0].name).toContain('黑市')
    expect(plots[0].customFields?.['核心事件']).toContain('黑市')
  })

  it('从文件名提取章号与标题', async () => {
    await writeFile(
      path.join(dir, '细纲', '细纲_第012章_对决.md'),
      `# 第 12 章 对决

## 字段

- **核心事件**：与段老虎正面交锋
`
    )
    const plots = await repo.list()
    expect(plots[0].name).toMatch(/第.*12.*章/)
    expect(plots[0].customFields?.['章节号']).toBe('12')
  })
})

// ============ RelationshipRepo ============

describe('RelationshipRepo', () => {
  let root: string
  let dir: string
  let repo: RelationshipRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-rel-'))
    dir = await setupProject(root)
    repo = new RelationshipRepo(dir)
  })

  it('读 记忆/关系/*.md（每条边一个文件）', async () => {
    await writeFile(
      path.join(dir, '记忆', '关系', '苏铭__林小溪.md'),
      `# 苏铭 ↔ 林小溪

| 项目 | 内容 |
|------|------|
| 当前关系 | 暧昧 |
| 章节 | 第 5 章 |
| 触发事件 | 报社相遇 |
`
    )
    const rels = await repo.list()
    expect(rels).toHaveLength(1)
    expect(rels[0].relationType).toBe('暧昧')
    expect(rels[0].description).toContain('报社相遇')
    expect(rels[0].sources?.[0]?.path).toContain('记忆/关系')
  })

  it('fallback 解析 设定/关系.md 的关系变更日志表', async () => {
    await writeFile(
      path.join(dir, '设定', '关系.md'),
      `# 关系

| 章节 | 角色A | 角色B | 变更前 | 变更后 | 触发事件 |
|------|-------|-------|--------|--------|----------|
| 第 5 章 | 苏铭 | 林小溪 | 陌生 | 暧昧 | 报社相遇 |
| 第 10 章 | 苏铭 | 段老虎 | 陌生 | 对立 | 摆摊冲突 |
`
    )
    const rels = await repo.list()
    expect(rels).toHaveLength(2)
    expect(rels.find((r) => r.relationType === '暧昧')).toBeDefined()
    expect(rels.find((r) => r.relationType === '对立')).toBeDefined()
  })

  it('主源与 fallback 同名时主源胜出', async () => {
    await writeFile(
      path.join(dir, '记忆', '关系', '苏铭__林小溪.md'),
      `# 苏铭 ↔ 林小溪\n\n| 项目 | 内容 |\n|------|------|\n| 当前关系 | 主源关系 |\n`
    )
    await writeFile(
      path.join(dir, '设定', '关系.md'),
      `# 关系\n\n| 章节 | 角色A | 角色B | 变更前 | 变更后 | 触发事件 |\n|------|-------|-------|--------|--------|----------|\n| 第 1 章 | 苏铭 | 林小溪 | X | fallback 关系 | — |\n`
    )
    const rels = await repo.list()
    // 主源 1 条 + fallback 1 条（不同名）
    expect(rels.length).toBeGreaterThanOrEqual(1)
    const main = rels.find((r) => r.description?.includes('主源关系'))
    expect(main).toBeDefined()
  })

  it('create 写到 记忆/关系/<A>__<B>.md', async () => {
    const r = await repo.create({
      characterAName: '苏铭',
      characterBName: '林小溪',
      relationType: '暧昧',
      description: '第 5 章报社相遇'
    })
    expect(r.relationType).toBe('暧昧')
    const rels = await repo.list()
    expect(rels.some((x) => x.relationType === '暧昧')).toBe(true)
  })

  it('update 真正落盘：改 relationType 后重新 list 能读到新值', async () => {
    const created = await repo.create({
      characterAName: '苏铭',
      characterBName: '林小溪',
      relationType: '陌生'
    })
    const updated = await repo.update(created.id, { relationType: '暧昧', description: '第5章' })
    expect(updated?.relationType).toBe('暧昧')

    // 重新 list（从磁盘读），验证落盘
    const rels = await repo.list()
    const target = rels.find((r) => r.id === created.id)
    expect(target?.relationType).toBe('暧昧')
    expect(target?.description).toContain('第5章')
  })

  it('delete 落盘：删除后重新 list 不再包含该关系', async () => {
    const created = await repo.create({
      characterAName: '苏铭',
      characterBName: '段老虎',
      relationType: '对立'
    })
    await repo.delete(created.id)
    const rels = await repo.list()
    expect(rels.find((r) => r.id === created.id)).toBeUndefined()
  })

  it('特殊字符角色名：create 后 update/delete 能按 H1 显示名定位文件', async () => {
    const a = '角色A:甲'
    const b = '角色B/乙'
    const created = await repo.create({
      characterAName: a,
      characterBName: b,
      relationType: '盟友'
    })
    const files = await readdir(path.join(dir, '记忆', '关系'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.md$/)
    // 文件名已 sanitize，不含路径分隔符
    expect(files[0].includes('/')).toBe(false)
    expect(files[0].includes(':')).toBe(false)

    const updated = await repo.update(created.id, { relationType: '敌对', description: '反目' })
    expect(updated?.relationType).toBe('敌对')

    const listed = (await repo.list()).find((r) => r.id === created.id)
    expect(listed?.relationType).toBe('敌对')
    expect(listed?.description).toContain('反目')

    await repo.delete(created.id)
    expect((await repo.list()).find((r) => r.id === created.id)).toBeUndefined()
  })
})

// ============ ItemRepo ============

describe('ItemRepo', () => {
  let root: string
  let dir: string
  let repo: ItemRepo

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-item-'))
    dir = await setupProject(root)
    repo = new ItemRepo(dir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('create 写 记忆/道具/<name>.md 并返回带 item- 前缀的 id', async () => {
    const created = await repo.create({
      name: '玄铁剑',
      category: '兵器',
      notes: '重达千斤，削铁如泥'
    })
    expect(created.id).toMatch(/^item-/)
    expect(created.type).toBe('item')
    expect(created.name).toBe('玄铁剑')
    expect(created.category).toBe('兵器')
    const raw = await readFile(path.join(dir, '记忆', '道具', '玄铁剑.md'), 'utf-8')
    expect(raw).toContain('# 玄铁剑')
    expect(raw).toContain('## 描述')
    expect(raw).toContain('重达千斤')
    expect(raw).toContain('- **类型**：兵器')
  })

  it('list 从 记忆/道具/ 读回已创建的道具', async () => {
    await repo.create({ name: '玄铁剑', category: '兵器', notes: '重剑' })
    await repo.create({ name: '玉佩', category: '信物', notes: '身世线索' })
    const items = await repo.list()
    expect(items).toHaveLength(2)
    const sword = items.find((i) => i.name === '玄铁剑')
    expect(sword?.category).toBe('兵器')
    expect(sword?.notes).toBe('重剑')
    expect(sword?.type).toBe('item')
  })

  it('update 改名后旧文件被删除', async () => {
    const created = await repo.create({ name: '旧剑', category: '兵器', notes: 'x' })
    await repo.update(created.id, { name: '新剑' })
    const items = await repo.list()
    expect(items.find((i) => i.name === '新剑')).toBeDefined()
    expect(items.find((i) => i.name === '旧剑')).toBeUndefined()
  })

  it('delete 后 list 不再包含该道具', async () => {
    const created = await repo.create({ name: '玉佩', category: '信物', notes: 'x' })
    await repo.delete(created.id)
    const items = await repo.list()
    expect(items.find((i) => i.id === created.id)).toBeUndefined()
  })

  it('空目录返回 []', async () => {
    expect(await repo.list()).toEqual([])
  })
})