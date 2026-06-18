import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { OutlineRepository } from '../src/main/data/outline-repository'

describe('OutlineRepository', () => {
  let dir: string
  let repo: OutlineRepository
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-ol-'))
    repo = new OutlineRepository(dir)
  })

  it('main returns null when absent', async () => {
    expect(await repo.readMain()).toBeNull()
  })

  it('writes and reads main outline', async () => {
    await repo.writeMain({ schemaVersion: 1, updatedAt: 't', synopsis: '故事简介' })
    expect((await repo.readMain())?.synopsis).toBe('故事简介')
  })

  it('detailed lists empty when absent', async () => {
    expect(await repo.listDetailed()).toEqual([])
  })

  it('upserts detailed item by chapterNumber', async () => {
    await repo.upsertDetailed({ chapterNumber: 1, plotSummary: 'A' })
    await repo.upsertDetailed({ chapterNumber: 1, plotSummary: 'B' })
    const list = await repo.listDetailed()
    expect(list).toHaveLength(1)
    expect(list[0].plotSummary).toBe('B')
  })

  it('persists detailed to detailed.json', async () => {
    await repo.upsertDetailed({ chapterNumber: 2, plotSummary: 'X' })
    const raw = JSON.parse(await readFile(path.join(dir, 'outlines', 'detailed.json'), 'utf-8'))
    expect(raw.items).toHaveLength(1)
  })
})
