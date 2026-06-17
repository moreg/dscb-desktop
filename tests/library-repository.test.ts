import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'

describe('LibraryRepository', () => {
  let dir: string
  let repo: LibraryRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-lib-'))
    repo = new LibraryRepository(path.join(dir, 'library.json'))
  })

  it('lists empty when library.json absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates a project with id and timestamps', async () => {
    const p = await repo.create({ name: '测试小说', path: dir })
    expect(p.id).toMatch(/.+/)
    expect(p.name).toBe('测试小说')
    expect(p.createdAt).toBeTruthy()
    expect(p.lastOpenedAt).toBeTruthy()
  })

  it('persists created project across instances', async () => {
    await repo.create({ name: '小说A', path: dir })
    const repo2 = new LibraryRepository(path.join(dir, 'library.json'))
    const list = await repo2.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('小说A')
  })
})
