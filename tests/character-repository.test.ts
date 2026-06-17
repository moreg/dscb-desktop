import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { CharacterRepository } from '../src/main/data/character-repository'

describe('CharacterRepository', () => {
  let dir: string
  let repo: CharacterRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-char-'))
    repo = new CharacterRepository(dir)
  })

  it('lists empty when absent', async () => {
    expect(await repo.list()).toEqual([])
  })

  it('creates with timestamps in memory/characters.json', async () => {
    const c = await repo.create({ name: '林远', role: '主角' })
    expect(c.id).toMatch(/.+/)
    expect(c.createdAt).toBeTruthy()
    expect(c.updatedAt).toBeTruthy()
    const raw = await readFile(path.join(dir, 'memory', 'characters.json'), 'utf-8')
    expect(JSON.parse(raw).items[0].name).toBe('林远')
  })

  it('updates fields and bumps updatedAt', async () => {
    const c = await repo.create({ name: '林远' })
    const updated = await repo.update(c.id, { personality: '坚毅' })
    expect(updated.personality).toBe('坚毅')
    expect(updated.updatedAt).not.toBe(c.updatedAt)
  })

  it('deletes', async () => {
    const c = await repo.create({ name: '林远' })
    await repo.delete(c.id)
    expect(await repo.list()).toEqual([])
  })
})
