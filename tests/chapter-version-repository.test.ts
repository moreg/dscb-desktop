import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterVersionRepository } from '../src/main/data/chapter-version-repository'

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

  it('creates version 1 with word count', async () => {
    const v = await repo.create(1, { source: 'manual', content: '林远觉醒了金符文。' })
    expect(v.versionNumber).toBe(1)
    expect(v.source).toBe('manual')
    expect(v.wordCount).toBe(9)
    expect(v.createdAt).toBeTruthy()
  })

  it('creates sequential version numbers', async () => {
    await repo.create(1, { source: 'manual', content: 'A' })
    await repo.create(1, { source: 'ai', content: 'B' })
    const list = await repo.list(1)
    expect(list.map((v) => v.versionNumber)).toEqual([1, 2])
    expect(list.map((v) => v.source)).toEqual(['manual', 'ai'])
  })

  it('get returns the version', async () => {
    await repo.create(1, { source: 'manual', content: 'X' })
    const v = await repo.get(1, 1)
    expect(v.content).toBe('X')
  })

  it('get throws on missing version', async () => {
    await expect(repo.get(1, 99)).rejects.toThrow(/not found/)
  })

  it('persists to NNN.versions.json', async () => {
    await repo.create(1, { source: 'manual', content: 'X' })
    const raw = await readFile(path.join(dir, 'chapters', '001.versions.json'), 'utf-8')
    expect(JSON.parse(raw).versions).toHaveLength(1)
  })

  it('deletes a version', async () => {
    await repo.create(1, { source: 'manual', content: 'A' })
    await repo.create(1, { source: 'ai', content: 'B' })
    await repo.delete(1, 1)
    const list = await repo.list(1)
    expect(list.map((v) => v.versionNumber)).toEqual([2])
  })
})
