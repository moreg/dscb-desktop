import { afterEach, describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChapterStageCache, chapterDependencyHash } from '../src/main/data/chapter-stage-cache'

afterEach(() => vi.restoreAllMocks())

describe('durable chapter stage receipts', () => {
  it('does not bind an old candidate to a newly changed dependency fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-stage-repair-race-'))
    let key = 'new-source'
    const cache = new ChapterStageCache(dir, 1, async () => key)
    await cache.rememberIfUnchanged('repair', 'old-source', { candidate: 'old' })
    expect(await cache.read('repair', Boolean)).toBeUndefined()
    key = 'old-source'
    await cache.rememberIfUnchanged('repair', 'old-source', { candidate: 'old' })
    expect(await cache.read('repair', Boolean)).toEqual({ candidate: 'old' })
    key = 'new-source'
    expect(await cache.read('repair', Boolean)).toBeUndefined()
  })
  it('scans once on a cache hit and twice when a new result needs validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-stage-scans-'))
    const fingerprint = vi.fn(async () => 'stable')
    const cache = new ChapterStageCache(dir, 1, fingerprint)
    const action = vi.fn(async () => true)
    await cache.run('outline', action, Boolean)
    expect(fingerprint).toHaveBeenCalledTimes(2)
    fingerprint.mockClear()
    await cache.run('outline', action, Boolean)
    expect(fingerprint).toHaveBeenCalledOnce()
    expect(action).toHaveBeenCalledOnce()
  })

  it('reuses unchanged file hashes while detecting equal-length edits and additions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-hash-reuse-'))
    const file = join(dir, 'chapter.md')
    await writeFile(file, 'before')
    const read = vi.spyOn(fs, 'readFile')
    const first = await chapterDependencyHash(dir, {})
    expect(read).toHaveBeenCalledOnce()
    read.mockClear()
    expect(await chapterDependencyHash(dir, {})).toBe(first)
    expect(read).not.toHaveBeenCalled()
    const time = await fs.stat(file)
    await writeFile(file, 'edited')
    await fs.utimes(file, time.atime, time.mtime)
    expect(await chapterDependencyHash(dir, {})).not.toBe(first)
    expect(read).toHaveBeenCalledOnce()
    const edited = await chapterDependencyHash(dir, {})
    await writeFile(join(dir, 'new.md'), '新增')
    expect(await chapterDependencyHash(dir, {})).not.toBe(edited)
  })

  it('does not authorize reuse when a dependency changes during hashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-hash-race-'))
    const file = join(dir, 'chapter.md')
    await writeFile(file, 'before')
    const read = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      await writeFile(file, 'changed after read')
      return result
    })
    expect(await chapterDependencyHash(dir, {})).toBeNull()
    expect(await chapterDependencyHash(dir, {})).not.toBeNull()
  })

  it('streams large dependencies instead of reading the whole file into a buffer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-large-hash-'))
    await writeFile(join(dir, 'export.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
    const read = vi.spyOn(fs, 'readFile')
    const first = await chapterDependencyHash(dir, {})
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(read).not.toHaveBeenCalled()
    expect(await chapterDependencyHash(dir, {})).toBe(first)
  })
  it('reuses after restart, invalidates content/config changes and never stores failed or racing checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-stages-'))
    const source = join(dir, 'chapter.md')
    await writeFile(source, 'first')
    let config = 'model-A/rules-1'
    const make = () => new ChapterStageCache(dir, 1, () => chapterDependencyHash(dir, config))
    const valid = (x: { ok: boolean }) => x.ok
    const action = vi.fn(async () => ({ ok: true }))
    await make().run('outline', action, valid)
    await make().run('outline', action, valid)
    expect(action).toHaveBeenCalledTimes(1)
    await writeFile(source, 'second')
    await make().run('outline', action, valid)
    config = 'model-B/rules-1'
    await make().run('outline', action, valid)
    await rm(source)
    await make().run('outline', action, valid)
    expect(action).toHaveBeenCalledTimes(4)
    await make().run('memory', async () => ({ ok: false }), valid)
    expect(await make().read('memory', valid)).toBeUndefined()
    await make().run('racing', async () => { await writeFile(source, 'changed during call'); return { ok: true } }, valid)
    expect(await make().read('racing', valid)).toBeUndefined()
  })
  it('fails closed for corrupt receipts and unknown model identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-stages-'))
    const cache = new ChapterStageCache(dir, 1, async () => null)
    await cache.remember('polish', { ok: true })
    expect(await cache.read('polish', () => true)).toBeUndefined()
    await mkdir(join(dir, '.cache/chapter-stages'), { recursive: true })
    await writeFile(join(dir, '.cache/chapter-stages/1-polish.json'), '{broken')
    expect(await new ChapterStageCache(dir, 1, async () => 'known').read('polish', () => true)).toBeUndefined()
  })
})
