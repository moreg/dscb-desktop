import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'
import { writeJsonAtomic } from '../src/main/data/atomic'

describe('ChapterVersionRepository', () => {
  let dir: string
  let repo: ChapterVersionRepository

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-cv-'))
    repo = new ChapterVersionRepository(dir)
  })

  it('lists empty when versions file absent', async () => {
    expect(await repo.list(1)).toEqual([])
  })

  it('creates version 1 with word count and timestamp', async () => {
    const v = await repo.create(1, { source: 'manual', content: '林远觉醒了金符文。' })
    expect(v.versionNumber).toBe(1)
    expect(v.source).toBe('manual')
    expect(v.wordCount).toBe(9)
    expect(v.createdAt).toBeTruthy()
  })

  it('returns versions in reverse order (倒序，最新在最前)', async () => {
    await repo.create(1, { source: 'manual', content: '第一版内容' })
    await repo.create(1, { source: 'ai', content: '第二版内容' })
    const list = await repo.list(1)
    expect(list).toHaveLength(2)
    expect(list[0].versionNumber).toBe(2)
    expect(list[0].source).toBe('ai')
    expect(list[1].versionNumber).toBe(1)
    expect(list[1].source).toBe('manual')
  })

  it('keeps at most 5 versions and prunes oldest when exceeding capacity', async () => {
    // 连续创建 6 个版本
    for (let i = 1; i <= 6; i++) {
      await repo.create(1, { source: 'manual', content: `正文内容 第${i}次修改` })
    }
    const list = await repo.list(1)
    // 应该只保留 5 个版本，且倒序排列（6, 5, 4, 3, 2，版本 1 被移出）
    expect(list).toHaveLength(5)
    expect(list.map((v) => v.versionNumber)).toEqual([6, 5, 4, 3, 2])
    expect(list[0].versionNumber).toBe(6)
    expect(list[4].versionNumber).toBe(2)
  })

  it('get returns the specific version', async () => {
    await repo.create(1, { source: 'manual', content: '内容X' })
    await repo.create(1, { source: 'reviewed', content: '内容Y' })
    const v = await repo.get(1, 1)
    expect(v.content).toBe('内容X')
    expect(v.versionNumber).toBe(1)
    const v2 = await repo.get(1, 2)
    expect(v2.content).toBe('内容Y')
    expect(v2.versionNumber).toBe(2)
  })

  it('get throws on missing version', async () => {
    await expect(repo.get(1, 99)).rejects.toThrow(/not found/)
  })

  it('persists to 正文/.versions/001.versions.json', async () => {
    await repo.create(1, { source: 'manual', content: '测试内容' })
    const raw = await readFile(path.join(dir, '正文', '.versions', '001.versions.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.versions).toHaveLength(1)
    expect(parsed.versions[0].content).toBe('测试内容')
  })

  it('deletes a version and updates file', async () => {
    await repo.create(1, { source: 'manual', content: 'A' })
    await repo.create(1, { source: 'ai', content: 'B' })
    await repo.delete(1, 1)
    const list = await repo.list(1)
    expect(list.map((v) => v.versionNumber)).toEqual([2])
  })

  it('reads legacy chapters/NNN.versions.json if primary is absent', async () => {
    const legacyPath = path.join(dir, 'chapters', '001.versions.json')
    await mkdir(path.dirname(legacyPath), { recursive: true })
    await writeJsonAtomic(legacyPath, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      versions: [
        { versionNumber: 1, source: 'manual', content: '旧格式正文', wordCount: 5, createdAt: new Date().toISOString() }
      ]
    })
    const list = await repo.list(1)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('旧格式正文')
  })
})
