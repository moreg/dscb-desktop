import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ForeshadowingRepository } from '../src/main/data/foreshadowing-repository'

describe('ForeshadowingRepository', () => {
  let dir: string
  let repo: ForeshadowingRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-fs-'))
    repo = new ForeshadowingRepository(dir)
  })

  it('creates with pending status', async () => {
    const f = await repo.create({ content: '神秘玉佩', expectedCollect: 50 })
    expect(f.status).toBe('pending')
    expect(f.id).toMatch(/.+/)
  })

  it('persists to foreshadowings.json', async () => {
    await repo.create({ content: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'memory', 'foreshadowings.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })

  it('plant sets status planted and plantChapter', async () => {
    const f = await repo.create({ content: 'X' })
    const planted = await repo.plant(f.id, 3)
    expect(planted.status).toBe('planted')
    expect(planted.plantChapter).toBe(3)
  })

  it('collect sets status collected and actualCollect', async () => {
    const f = await repo.create({ content: 'X' })
    const collected = await repo.collect(f.id, 48)
    expect(collected.status).toBe('collected')
    expect(collected.actualCollect).toBe(48)
  })

  it('markMissed sets status missed', async () => {
    const f = await repo.create({ content: 'X' })
    expect((await repo.markMissed(f.id)).status).toBe('missed')
  })

  it('deletes', async () => {
    const f = await repo.create({ content: 'X' })
    await repo.delete(f.id)
    expect(await repo.list()).toEqual([])
  })
})
