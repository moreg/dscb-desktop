import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { MemorySyncService } from '../src/main/data/memory/sync-service'

async function setupProject(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(root, 'sync-'))
  await mkdir(path.join(dir, '记忆', '人物'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '地点'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '世界观'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '时间线'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '剧情点'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '关系'), { recursive: true })
  await mkdir(path.join(dir, '记忆', '伏笔'), { recursive: true })
  await mkdir(path.join(dir, '设定', '角色'), { recursive: true })
  await mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
  await mkdir(path.join(dir, '细纲'), { recursive: true })
  await mkdir(path.join(dir, '追踪'), { recursive: true })
  await writeFile(path.join(dir, '记忆', '索引.md'), '# 记忆索引\n\n## 人物（0）\n', 'utf-8')
  return dir
}

describe('MemorySyncService', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-sync-'))
  })

  it('从 设定/角色/<name>.md 同步到 记忆/人物/<name>.md', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '设定', '角色', '苏铭.md'),
      `# 苏铭

## 基本信息

- **身份**：大学生

## 当前状态

- **当前状态**：第 10 章精神力透支
`
    )
    const svc = new MemorySyncService(dir)
    const report = await svc.syncAll()
    expect(report.added).toBeGreaterThanOrEqual(1)

    const target = await readFile(path.join(dir, '记忆', '人物', '苏铭.md'), 'utf-8')
    expect(target).toContain('# 苏铭')
    expect(target).toContain('身份')
  })

  it('从 设定/世界观/地理.md H2 节同步到 记忆/地点/*.md', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '设定', '世界观', '地理.md'),
      `# 地理

## 青云山

- **类型**：山脉
- **特征描述**：云雾缭绕
`
    )
    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const files = await readdir(path.join(dir, '记忆', '地点'))
    expect(files).toContain('青云山.md')
  })

  it('从 细纲/细纲_第NNN章_*.md 同步到 记忆/剧情点/*.md', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '细纲', '细纲_第003章_对决.md'),
      `# 第 3 章 对决

## 字段

- **核心事件**：与段老虎正面交锋
`
    )
    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const files = await readdir(path.join(dir, '记忆', '剧情点'))
    expect(files.some((f) => f.includes('对决'))).toBe(true)
  })

  it('从 追踪/时间线.md 对照表同步到 记忆/时间线/*.md', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '追踪', '时间线.md'),
      `# 时间线

## 历史事件与小说事件对照表

| 时间 | 历史事件 | 小说事件 | 对应章节 | 对应卷 |
|------|----------|----------|----------|--------|
| 1923 | 北洋时期 | 苏九重生归来 | 第 1-30 章 | 第 1 卷 |
`
    )
    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const files = await readdir(path.join(dir, '记忆', '时间线'))
    expect(files.some((f) => f.includes('苏九'))).toBe(true)
  })

  it('从开书格式时间线（H1 + 裸表）同步到 记忆/时间线/*.md', async () => {
    const dir = await setupProject(root)
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
    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const files = await readdir(path.join(dir, '记忆', '时间线'))
    expect(files.some((f) => f.includes('开端'))).toBe(true)
    expect(files.some((f) => f.includes('初露锋芒'))).toBe(true)
  })

  it('从 设定/关系.md 同步到 记忆/关系/*.md', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '设定', '关系.md'),
      `# 关系

| 章节 | 角色A | 角色B | 变更前 | 变更后 | 触发事件 |
|------|-------|-------|--------|--------|----------|
| 第 5 章 | 苏铭 | 林小溪 | 陌生 | 暧昧 | 报社相遇 |
`
    )
    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const files = await readdir(path.join(dir, '记忆', '关系'))
    expect(files.some((f) => f.includes('苏铭') && f.includes('林小溪'))).toBe(true)
  })

  it('源文件未变时不重复写目标（mtime 比较增量）', async () => {
    const dir = await setupProject(root)
    await writeFile(
      path.join(dir, '设定', '角色', '段老虎.md'),
      `# 段老虎

## 基本信息

- **身份**：帮派头目
`
    )
    const svc = new MemorySyncService(dir)
    const r1 = await svc.syncAll()
    expect(r1.added).toBe(1)
    const r2 = await svc.syncAll()
    expect(r2.added).toBe(0)
    expect(r2.updated).toBe(0)
  })

  it('源文件更新后再次同步标记 updated', async () => {
    const dir = await setupProject(root)
    const src = path.join(dir, '设定', '角色', '段老虎.md')
    await writeFile(src, `# 段老虎\n\n## 基本信息\n\n- **身份**：初始身份\n`)

    const svc = new MemorySyncService(dir)
    const r1 = await svc.syncAll()
    expect(r1.added).toBe(1)

    // 等几毫秒让 mtime 推进，模拟"用户改了源文件"
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(src, `# 段老虎\n\n## 基本信息\n\n- **身份**：修改后身份\n`)

    const r2 = await svc.syncAll()
    expect(r2.updated).toBe(1)
    const target = await readFile(path.join(dir, '记忆', '人物', '段老虎.md'), 'utf-8')
    expect(target).toContain('修改后身份')
  })

  it('同步后生成 记忆/索引.md，包含分类计数', async () => {
    const dir = await setupProject(root)
    await writeFile(path.join(dir, '设定', '角色', '苏铭.md'), `# 苏铭\n`)
    await writeFile(path.join(dir, '设定', '世界观', '地理.md'), `## 青云山\n- **类型**：山脉\n`)

    const svc = new MemorySyncService(dir)
    await svc.syncAll()

    const indexText = await readFile(path.join(dir, '记忆', '索引.md'), 'utf-8')
    expect(indexText).toMatch(/## 人物（[1-9]\d*）/)
    expect(indexText).toMatch(/## 地点（[1-9]\d*）/)
  })

  it('源文件删除后再次同步，派生目标被清理（removed 计数 + 文件消失）', async () => {
    const dir = await setupProject(root)
    const src1 = path.join(dir, '设定', '角色', '苏铭.md')
    const src2 = path.join(dir, '设定', '角色', '林小溪.md')
    await writeFile(src1, `# 苏铭\n\n## 基本信息\n\n- **身份**：主角\n`)
    await writeFile(src2, `# 林小溪\n\n## 基本信息\n\n- **身份**：女主\n`)

    const svc = new MemorySyncService(dir)
    const r1 = await svc.syncAll()
    expect(r1.added).toBeGreaterThanOrEqual(2)

    // 删除一个源文件，再次同步
    await unlink(src1)
    const r2 = await svc.syncAll()
    expect(r2.removed).toBeGreaterThanOrEqual(1)

    // 苏铭.md 派生目标应被删除，林小溪.md 保留
    await expect(stat(path.join(dir, '记忆', '人物', '苏铭.md'))).rejects.toThrow()
    await expect(stat(path.join(dir, '记忆', '人物', '林小溪.md'))).resolves.toBeDefined()
  })

  it('用户手动创建（未进索引）的文件不被 prune 误删', async () => {
    const dir = await setupProject(root)
    await writeFile(path.join(dir, '设定', '角色', '苏铭.md'), `# 苏铭\n`)
    // 用户手动创建一个角色文件（未经过 sync）
    const manual = path.join(dir, '记忆', '人物', '手动角色.md')
    await writeFile(manual, `# 手动角色\n`)

    const svc = new MemorySyncService(dir)
    await svc.syncAll()
    // 再次同步（此时源未变，但手动文件不应被删）
    const r2 = await svc.syncAll()
    expect(r2.removed).toBe(0)
    await expect(stat(manual)).resolves.toBeDefined()
  })

  it('伏笔按各表列头同步，计划表和编号映射不能覆盖实际条目', async () => {
    const dir = await setupProject(root)
    await writeFile(path.join(dir, '追踪', '伏笔.md'), `# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 母亲的病因 | 身世 | 第 5 章 | 第 111 章 | 第 9 章 | 部分回收 |\n\n## 卷次伏笔\n\n| 伏笔编号 | 原编号 | 内容 | 状态 | 实际回收章节 | 埋设章节 | 预计回收章节 |\n|---|---|---|---|---|---|---|\n| FB-002 | FB-OLD-3 | 铜铃的声音 | 已回收 | 第 20 章 | 第 2 章 | 第 30 章 |\n\n## 六列表\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 状态 |\n|---|---|---|---|---|---|\n| FB-003 | 旧日印记 | 设定 | 第 3 章 | 第 80 章 | 已强化 |\n\n## 细纲回收计划\n\n| 伏笔编号 | 内容 | 回收章节 | 回收机制 |\n|---|---|---|---|\n| FB-002 | 计划重写的铃声 | 第 90 章 | 终战揭晓 |\n\n## 编号映射\n\n| 局部编号 | 局部内容 | 全局编号 |\n|---|---|---|\n| FB-880 | 映射说明 | FB-001 |\n`)
    const report = await new MemorySyncService(dir).syncAll()
    expect(report.errors).toEqual([])
    expect((await readdir(path.join(dir, '记忆', '伏笔'))).sort()).toEqual(['FB-001.md', 'FB-002.md', 'FB-003.md'])
    const partial = await readFile(path.join(dir, '记忆', '伏笔', 'FB-001.md'), 'utf8')
    expect(partial).toContain('**状态**：部分回收')
    expect(partial).not.toContain('**实际回收章节**')
    expect(partial).toContain('**部分回收章节**：第 9 章')
    const collected = await readFile(path.join(dir, '记忆', '伏笔', 'FB-002.md'), 'utf8')
    expect(collected).toContain('铜铃的声音')
    expect(collected).toContain('**实际回收章节**：第 20 章')
    expect(collected).not.toContain('计划重写')
    expect(collected).not.toContain('FB-OLD-3\n')
    const reinforced = await readFile(path.join(dir, '记忆', '伏笔', 'FB-003.md'), 'utf8')
    expect(reinforced).toContain('**状态**：已强化')
  })

  it('伏笔解析规则升级重建旧派生视图并清理旧错位条目，之后保持增量', async () => {
    const dir = await setupProject(root)
    const src = path.join(dir, '追踪', '伏笔.md')
    await writeFile(src, '# 伏笔\n\n| 伏笔编号 | 内容 | 状态 | 埋设章节 | 实际回收章节 |\n|---|---|---|---|---|\n| FB-001 | 铜铃 | 已回收 | 第 1 章 | 第 20 章 |\n')
    const sourceMtime = (await stat(src)).mtimeMs
    await writeFile(path.join(dir, '记忆', '伏笔', 'FB-001.md'), '# FB-001\n\n旧解析错误内容')
    await writeFile(path.join(dir, '记忆', '伏笔', 'FB-880.md'), '# FB-880\n\n旧映射行误转')
    await writeFile(path.join(dir, '记忆', '.sync-index.json'), JSON.stringify({
      '伏笔/FB-001.md': { sourceMtime, targetMtime: Date.now(), sourceRel: '追踪/伏笔.md' },
      '伏笔/FB-880.md': { sourceMtime, targetMtime: Date.now(), sourceRel: '追踪/伏笔.md' }
    }))
    const svc = new MemorySyncService(dir)
    const first = await svc.syncAll()
    expect(first.updated).toBe(1)
    expect(first.removed).toBe(1)
    expect(await readFile(path.join(dir, '记忆', '伏笔', 'FB-001.md'), 'utf8')).toContain('铜铃')
    const second = await svc.syncAll()
    expect(second.updated).toBe(0)
    expect(second.removed).toBe(0)
  })
})
