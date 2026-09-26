import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'
import { isProjectArchived } from '../src/shared/types'

describe('isProjectArchived', () => {
  it('treats missing or blank archivedAt as not archived', () => {
    expect(isProjectArchived({})).toBe(false)
    expect(isProjectArchived({ archivedAt: '' })).toBe(false)
    expect(isProjectArchived({ archivedAt: '  ' })).toBe(false)
    expect(isProjectArchived({ archivedAt: '2026-01-01T00:00:00.000Z' })).toBe(true)
  })
})

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

  it('updates the project name and description without changing its path', async () => {
    const created = await repo.create({ name: '旧名', path: dir })
    const updated = await repo.update(created.id, { name: '新书名', description: '新简介' })
    expect(updated.name).toBe('新书名')
    expect(updated.description).toBe('新简介')
    expect(updated.path).toBe(dir)
    expect((await repo.list())[0]).toMatchObject({ name: '新书名', description: '新简介' })
  })

  it('archives a project and keeps the original timestamp on repeat', async () => {
    const created = await repo.create({ name: '待归档', path: dir })
    expect(created.archivedAt).toBeUndefined()
    const archived = await repo.setArchived(created.id, true)
    expect(archived.archivedAt).toMatch(/^\d{4}-/)
    const again = await repo.setArchived(created.id, true)
    expect(again.archivedAt).toBe(archived.archivedAt)
    const repo2 = new LibraryRepository(path.join(dir, 'library.json'))
    expect((await repo2.list())[0].archivedAt).toBe(archived.archivedAt)
  })

  it('unarchives a project and drops archivedAt from disk', async () => {
    const created = await repo.create({ name: '待移回', path: dir })
    await repo.setArchived(created.id, true)
    const restored = await repo.setArchived(created.id, false)
    expect(restored.archivedAt).toBeUndefined()
    const raw = JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8')) as {
      projects: Array<{ archivedAt?: string }>
    }
    expect(raw.projects[0].archivedAt).toBeUndefined()
  })

  it('throws when archiving an unknown project', async () => {
    await expect(repo.setArchived('missing', true)).rejects.toThrow(/not found/)
  })
})
