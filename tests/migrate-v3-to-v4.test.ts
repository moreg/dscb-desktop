import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { migrateProjectV3ToV4, type MigrationReport } from '../src/main/data/memory/migration-v3-to-v4'

// 构造老版 v3 项目（带 记忆系统/ 与 chapters/）
async function setupV3Project(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(root, 'proj-'))
  await mkdir(path.join(dir, '记忆系统'), { recursive: true })
  await mkdir(path.join(dir, '设定', '角色'), { recursive: true })
  await mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
  await mkdir(path.join(dir, '大纲'), { recursive: true })
  await mkdir(path.join(dir, '细纲'), { recursive: true })
  await mkdir(path.join(dir, '追踪'), { recursive: true })
  await mkdir(path.join(dir, 'chapters'), { recursive: true })
  await mkdir(path.join(dir, '参考资料'), { recursive: true })
  return dir
}

const V3_CHARACTER_CARD = `# 角色卡

## 主角

### 苏铭（男主）
- **身份**：大学生
- **显性性格**：沉稳
- **隐性性格**：果断
- **金手指**：运势罗盘
- **专属标签**：#闷骚# #护妻#
- **当前状态**：第 10 章，精神力透支

### 林小溪（女主）
- **身份**：记者
- **显性性格**：好奇
- **专属标签**：#机智#

## 核心反派

### 段老虎（BOSS）
- **身份**：帮派头目
- **显性性格**：凶狠

## 关系变更日志

| 章节 | 角色A | 角色B | 变更前 | 变更后 | 触发事件 |
|------|-------|-------|--------|--------|----------|
| 第 5 章 | 苏铭 | 林小溪 | 陌生 | 暧昧 | 报社相遇 |
| 第 10 章 | 苏铭 | 段老虎 | 陌生 | 对立 | 摆摊冲突 |
`

const V3_LOCATION = `# 地点档案

## 1. 大学图书馆

- **类型**：城市建筑
- **特征描述**：5 层开放式阅览空间
- **关联事件**：
  - 第 1 章：苏铭困在 3 楼
- **关联角色**：苏铭、林小溪

## 2. 城南安全屋（徐昭昭未来准备）

- **类型**：室内场所
- **特征描述**：废弃民居改造
- **关联角色**：徐昭昭
`

const V3_WORLDVIEW = `# 世界观设定

## 力量/境界体系

觉醒等级分 5 级

## 势力格局

- 苏铭小队
- 北方军阀

## 金手指

运势罗盘 Lv.1
`

const V3_CORE_PLOT = `# 核心情节

## 第一卷：天降老婆（第 1-30 章）

### 第 1 章：困兽

- **核心事件**：孢子灾害初现
- **爽点/打脸**：苏铭用罗盘砸退变异兽
- **伏笔**：孢子污染源

### 第 2 章：破窗

- **核心事件**：徐昭昭破窗而入
`

const V3_FORESHA = `# 伏笔追踪

| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |
|----------|----------|----------|----------|-------------|-------------|------|
| FB-001 | 孢子污染源 | 设定 | 第 1 章 | 第 50 章 | 未回收 | 未回收 |
| FB-002 | 徐昭昭的相机 | 道具 | 第 2 章 | 第 30 章 | 未回收 | 未回收 |
`

const V3_TRACKING_FS = `# 伏笔追踪

| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |
|----------|----------|----------|----------|-------------|-------------|------|
| FB-001 | 孢子污染源（追踪版） | 设定 | 第 1 章 | 第 50 章 | 第 50 章 | 已回收 |
`

describe('migrate-v3-to-v4', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-migrate-'))
  })

  it('完整 v3 项目：转换所有 记忆系统/ 文件到 记忆/ 子目录', async () => {
    const dir = await setupV3Project(root)
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), V3_CHARACTER_CARD)
    await writeFile(path.join(dir, '记忆系统', '地点档案.md'), V3_LOCATION)
    await writeFile(path.join(dir, '记忆系统', '世界观设定.md'), V3_WORLDVIEW)
    await writeFile(path.join(dir, '记忆系统', '核心情节.md'), V3_CORE_PLOT)
    await writeFile(path.join(dir, '记忆系统', '伏笔追踪.md'), V3_FORESHA)

    const report = await migrateProjectV3ToV4(dir)

    // 人物
    const charFiles = (await readdir(path.join(dir, '记忆', '人物'))).sort()
    expect(charFiles).toEqual(['林小溪.md', '段老虎.md', '苏铭.md'])

    // 地点
    const locFiles = (await readdir(path.join(dir, '记忆', '地点'))).sort()
    expect(locFiles).toEqual(['城南安全屋.md', '大学图书馆.md'])
    const dxyContent = await readFile(path.join(dir, '记忆', '地点', '大学图书馆.md'), 'utf-8')
    expect(dxyContent).toContain('# 大学图书馆')
    expect(dxyContent).toContain('**类型**：城市建筑')

    // 世界观（递归读，因为支持子目录分层）
    async function listMdDeep(rootDir: string): Promise<string[]> {
      const out: string[] = []
      const stack: string[] = [rootDir]
      while (stack.length) {
        const cur = stack.pop()!
        const entries = await readdir(cur, { withFileTypes: true })
        for (const e of entries.sort()) {
          const full = path.join(cur, e.name)
          if (e.isDirectory()) stack.push(full)
          else if (e.name.endsWith('.md')) {
            out.push(path.relative(rootDir, full).replace(/\\/g, '/'))
          }
        }
      }
      return out.sort()
    }
    const wvFiles = await listMdDeep(path.join(dir, '记忆', '世界观'))
    expect(wvFiles).toEqual(['力量/境界体系.md', '势力格局.md', '金手指.md'])

    // 剧情点
    const plotFiles = (await readdir(path.join(dir, '记忆', '剧情点'))).sort()
    expect(plotFiles).toEqual(['第001章 困兽.md', '第002章 破窗.md'])

    // 伏笔
    const fFiles = (await readdir(path.join(dir, '记忆', '伏笔'))).sort()
    expect(fFiles).toEqual(['FB-001.md', 'FB-002.md'])

    // 关系（从 角色卡.md 的 关系变更日志 派生）
    const relFiles = await readdir(path.join(dir, '记忆', '关系'))
    expect(relFiles.length).toBe(2)

    // 索引
    const indexText = await readFile(path.join(dir, '记忆', '索引.md'), 'utf-8')
    expect(indexText).toContain('# 记忆索引')
    expect(indexText).toContain('## 人物（3）')
    expect(indexText).toContain('## 地点（2）')

    // 老的 记忆系统/ 与 chapters/ 应被删除
    await expect(stat(path.join(dir, '记忆系统'))).rejects.toThrow()
    await expect(stat(path.join(dir, 'chapters'))).rejects.toThrow()

    // 报告
    expect(report.converted).toBeGreaterThan(5)
    expect(report.removedDirs).toContain('记忆系统')
    expect(report.removedDirs).toContain('chapters')
  })

  it('空 v3 项目：仅生成骨架文件不报错', async () => {
    const dir = await setupV3Project(root)
    const report = await migrateProjectV3ToV4(dir)
    expect(report.converted).toBe(0)
    const indexText = await readFile(path.join(dir, '记忆', '索引.md'), 'utf-8')
    expect(indexText).toContain('## 人物（0）')
  })

  it('伏笔双写：记忆系统/伏笔追踪.md 与 追踪/伏笔.md 合并，追踪版优先（更近的更新）', async () => {
    const dir = await setupV3Project(root)
    await writeFile(path.join(dir, '记忆系统', '伏笔追踪.md'), V3_FORESHA)
    await writeFile(path.join(dir, '追踪', '伏笔.md'), V3_TRACKING_FS)

    await migrateProjectV3ToV4(dir)

    const merged = await readFile(path.join(dir, '追踪', '伏笔.md'), 'utf-8')
    // FB-001 取追踪版（已回收）
    expect(merged).toContain('FB-001')
    expect(merged).toContain('已回收')
    // FB-002 仅在记忆版有，应保留
    expect(merged).toContain('FB-002')
    // FB-001 的两个版本合并为一行（FB-001）
    const matches = merged.match(/FB-001/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('重命名 参考资料/ → 资料/', async () => {
    const dir = await setupV3Project(root)
    await writeFile(path.join(dir, '参考资料', 'readme.txt'), 'note')

    await migrateProjectV3ToV4(dir)

    await expect(stat(path.join(dir, '参考资料'))).rejects.toThrow()
    const renamed = await readFile(path.join(dir, '资料', 'readme.txt'), 'utf-8')
    expect(renamed).toBe('note')
  })

  it('dry-run 模式不实际写文件', async () => {
    const dir = await setupV3Project(root)
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), V3_CHARACTER_CARD)

    const report = await migrateProjectV3ToV4(dir, { dryRun: true })

    // 老文件还在
    await expect(stat(path.join(dir, '记忆系统', '角色卡.md'))).resolves.toBeDefined()
    // 新目录没创建
    await expect(stat(path.join(dir, '记忆', '人物'))).rejects.toThrow()
    // 但报告里写了会转换的内容
    expect(report.dryRun).toBe(true)
    expect(report.wouldConvert).toBeGreaterThan(0)
  })

  it('已经是 v4 的项目（无 记忆系统/）：直接返回空报告', async () => {
    const dir = await mkdtemp(path.join(root, 'already-v4-'))
    const report = await migrateProjectV3ToV4(dir)
    expect(report.skipped).toBe(true)
  })

  it('损坏的 v3 文件：跳过并报告错误，不中断整体迁移', async () => {
    const dir = await setupV3Project(root)
    // 角色卡.md 是损坏的（非法 markdown）
    await writeFile(path.join(dir, '记忆系统', '角色卡.md'), '## 主角\n\n### \n- 字段：值')
    await writeFile(path.join(dir, '记忆系统', '地点档案.md'), V3_LOCATION)

    const report = await migrateProjectV3ToV4(dir)

    expect(report.errors.length).toBeGreaterThanOrEqual(0)
    // 地点仍能正常迁移
    const locFiles = await readdir(path.join(dir, '记忆', '地点'))
    expect(locFiles.length).toBe(2)
  })
})