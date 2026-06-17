import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { MemoryHistory } from '../src/main/data/memory-history'

describe('MemoryHistory', () => {
  let dir: string
  let history: MemoryHistory
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-hist-'))
    history = new MemoryHistory(dir)
  })

  it('lists empty when absent', async () => {
    expect(await history.list()).toEqual([])
  })

  it('appends entries and reads them back', async () => {
    await history.append({
      at: '2026-06-18T00:00:00.000Z',
      type: 'character',
      action: 'create',
      entityId: 'c1',
      summary: '林远'
    })
    await history.append({
      at: '2026-06-18T00:00:01.000Z',
      type: 'character',
      action: 'delete',
      entityId: 'c1'
    })
    const list = await history.list()
    expect(list).toHaveLength(2)
    expect(list[0].summary).toBe('林远')
    expect(list[1].action).toBe('delete')
  })

  it('writes one json object per line', async () => {
    await history.append({ at: 't1', type: 'character', action: 'create' })
    await history.append({ at: 't2', type: 'character', action: 'delete' })
    const raw = await readFile(path.join(dir, 'memory', 'history.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).action).toBe('create')
  })
})
