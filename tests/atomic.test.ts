import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'

describe('atomic json io', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aw-atomic-'))
  })

  it('returns fallback when file missing', async () => {
    const result = await readJson(path.join(dir, 'nope.json'), { ok: false })
    expect(result).toEqual({ ok: false })
  })

  it('writes then reads round-trip', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { a: 1, list: [1, 2] })
    const read = await readJson<{ a: number; list: number[] }>(file, { a: 0, list: [] })
    expect(read).toEqual({ a: 1, list: [1, 2] })
  })

  it('does not leave a .tmp file after write', async () => {
    const file = path.join(dir, 'data.json')
    await writeJsonAtomic(file, { x: 1 })
    const raw = await readFile(file, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ x: 1 })
  })
})
