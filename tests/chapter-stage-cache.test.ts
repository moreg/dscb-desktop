import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChapterStageCache, chapterDependencyHash } from '../src/main/data/chapter-stage-cache'

describe('durable chapter stage receipts', () => {
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
