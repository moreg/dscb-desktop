import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { JsonCollectionRepository } from '../src/main/data/json-collection-repository'

interface Item {
  id: string
  name: string
  updatedAt: string
}

describe('JsonCollectionRepository', () => {
  let file: string
  let repo: JsonCollectionRepository<Item>

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aw-col-'))
    file = path.join(dir, 'items.json')
    repo = new JsonCollectionRepository<Item>(file)
  })

  it('lists empty when file absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates item with generated id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    expect(item.id).toMatch(/.+/)
    expect(item.name).toBe('A')
  })

  it('persists across instances', async () => {
    await repo.create({ name: 'A', updatedAt: 'now' })
    const repo2 = new JsonCollectionRepository<Item>(file)
    expect(await repo2.list()).toHaveLength(1)
  })

  it('updates by id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    const updated = await repo.update(item.id, { name: 'B' })
    expect(updated.name).toBe('B')
  })

  it('throws on update missing id', async () => {
    await expect(repo.update('nope', { name: 'X' })).rejects.toThrow(/not found/)
  })

  it('deletes by id', async () => {
    const item = await repo.create({ name: 'A', updatedAt: 'now' })
    await repo.delete(item.id)
    expect(await repo.list()).toEqual([])
  })
})
