import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'

const TRACKING_FS = `# 伏笔追踪

| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |
|----------|----------|----------|----------|-------------|-------------|------|
| FB-001 | 孢子污染源 | 设定 | 第 1 章 | 第 50 章 | 未回收 | 未回收 |
`

const LEGACY_FS = `# 伏笔追踪

| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |
|----------|----------|----------|----------|-------------|-------------|------|
| FB-LEGACY | 旧版本伏笔 | 设定 | 第 1 章 | 第 5 章 | 未回收 | 未回收 |
`

describe('ForeshadowingMdRepo (v4 single-source)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-fs-'))
    await mkdir(path.join(root, '追踪'), { recursive: true })
  })

  it('只从 追踪/伏笔.md 读取（PR2：删除 记忆系统/伏笔追踪.md 回退）', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    // 同时存在 legacy 路径，但**不应**被读取
    await mkdir(path.join(root, '记忆系统'), { recursive: true })
    await writeFile(path.join(root, '记忆系统', '伏笔追踪.md'), LEGACY_FS, 'utf-8')

    const repo = new ForeshadowingMdRepo(root)
    const items = await repo.list()

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('FB-001')
    expect(items[0].content).toContain('孢子污染源')
    // legacy 不再被读取
    expect(items.find((f) => f.id === 'FB-LEGACY')).toBeUndefined()
  })

  it('仅 追踪/伏笔.md 时正常返回', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    const items = await repo.list()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('FB-001')
  })

  it('两个文件都没有时返回空数组（不抛错）', async () => {
    const repo = new ForeshadowingMdRepo(root)
    expect(await repo.list()).toEqual([])
  })

  it('create 写到 追踪/伏笔.md（PR3：消除双写分裂）', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    const created = await repo.create({ content: '新伏笔', expectedCollect: 10 })
    expect(created.id).toMatch(/^FB-\d+$/)

    const tracking = await readFile(path.join(root, '追踪', '伏笔.md'), 'utf-8')
    expect(tracking).toContain('新伏笔')
    // 不应写到 记忆系统/伏笔追踪.md（双写分裂根因）
    const legacyExists = await import('fs/promises').then(({ access }) =>
      access(path.join(root, '记忆系统', '伏笔追踪.md')).then(() => true).catch(() => false)
    )
    expect(legacyExists).toBe(false)
  })

  it('无表骨架时 create 自动建表头并写入（不静默成功）', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), '# 伏笔追踪\n\n', 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    const created = await repo.create({ content: '无表时新建', expectedCollect: 8 })
    expect(created.id).toMatch(/^FB-\d+$/)

    const tracking = await readFile(path.join(root, '追踪', '伏笔.md'), 'utf-8')
    expect(tracking).toContain('伏笔编号')
    expect(tracking).toContain('无表时新建')
    expect(tracking).toContain(created.id)

    const listed = await repo.list()
    expect(listed.find((f) => f.content.includes('无表时新建'))).toBeDefined()
  })

  it('update 修改 追踪/伏笔.md 的行', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    await repo.update('FB-001', { content: '修改后的伏笔内容' })

    const tracking = await readFile(path.join(root, '追踪', '伏笔.md'), 'utf-8')
    expect(tracking).toContain('修改后的伏笔内容')
    expect(tracking).not.toContain('孢子污染源')
  })

  it('delete 从 追踪/伏笔.md 删除行', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    await repo.delete('FB-001')
    const items = await repo.list()
    expect(items).toHaveLength(0)
  })

  it('plant/collect 修改 追踪/伏笔.md', async () => {
    await writeFile(path.join(root, '追踪', '伏笔.md'), TRACKING_FS, 'utf-8')
    const repo = new ForeshadowingMdRepo(root)
    await repo.plant('FB-001', 3)
    let items = await repo.list()
    expect(items[0].plantChapter).toBe(3)

    await repo.collect('FB-001', 50)
    items = await repo.list()
    expect(items[0].actualCollect).toBe(50)
  })
})