import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ChapterRepository } from '../src/main/data/chapter-repository'

describe('ChapterRepository', () => {
  let dir: string
  let repo: ChapterRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-chap-'))
    repo = new ChapterRepository(dir)
  })

  it('lists empty when no chapters', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates chapter 1 with zero word count', async () => {
    const meta = await repo.create({ title: '第一章' })
    expect(meta.chapterNumber).toBe(1)
    expect(meta.wordCount).toBe(0)
    expect(meta.status).toBe('outline')
  })

  it('creates sequential chapter numbers', async () => {
    await repo.create({ title: '一' })
    await repo.create({ title: '二' })
    const list = await repo.list()
    expect(list.map((m) => m.chapterNumber)).toEqual([1, 2])
  })

  it('updateContent writes md and updates word count', async () => {
    await repo.create({ title: '一' })
    const meta = await repo.updateContent(1, '林远觉醒了金符文。')
    expect(meta.wordCount).toBe(9)
    const md = await readFile(path.join(dir, 'chapters', '001.md'), 'utf-8')
    expect(md).toBe('林远觉醒了金符文。')
  })

  it('get returns meta and content', async () => {
    await repo.create({ title: '一' })
    await repo.updateContent(1, '正文内容')
    const got = await repo.get(1)
    expect(got.meta.title).toBe('一')
    expect(got.content).toBe('正文内容')
  })

  it('delete removes both md and meta', async () => {
    await repo.create({ title: '一' })
    await repo.delete(1)
    expect(await repo.list()).toEqual([])
  })

  it('uses zero-padded 3-digit filenames', async () => {
    await repo.create({ title: '一' })
    const raw = await readFile(path.join(dir, 'chapters', '001.meta.json'), 'utf-8')
    expect(JSON.parse(raw).chapterNumber).toBe(1)
  })
})
