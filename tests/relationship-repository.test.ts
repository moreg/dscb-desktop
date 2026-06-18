import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { RelationshipRepository } from '../src/main/data/relationship-repository'

describe('RelationshipRepository', () => {
  let dir: string
  let repo: RelationshipRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-rel-'))
    repo = new RelationshipRepository(dir)
  })

  it('creates a relationship', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: '师徒' })
    expect(r.id).toMatch(/.+/)
    expect(r.relationType).toBe('师徒')
  })

  it('persists to relationships.json', async () => {
    await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'memory', 'relationships.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })

  it('updates fields', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    const updated = await repo.update(r.id, { strength: 80 })
    expect(updated.strength).toBe(80)
  })

  it('deletes', async () => {
    const r = await repo.create({ characterAId: 'a', characterBId: 'b', relationType: 'X' })
    await repo.delete(r.id)
    expect(await repo.list()).toEqual([])
  })
})
