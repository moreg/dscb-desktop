import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runChapterExecution, trackChapterCall, CHAPTER_REPAIR_LIMIT } from '../src/main/data/chapter-execution'

describe('chapter-wide repair budget', () => {
  it('shares the limit across nested repair types, permits verification and records calls without prose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-budget-'))
    const invoke = vi.fn(async () => 'private prose')
    await runChapterExecution(dir, 1, async () => {
      await trackChapterCall('deslop:scene-repair', invoke)
      await runChapterExecution(dir, 1, async () => {
        await trackChapterCall('continuityRepair', invoke)
        await trackChapterCall('batchForeshadowRepair', invoke)
      })
      await expect(trackChapterCall('chapter-scene-repair', invoke)).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
      await trackChapterCall('longformGuard', invoke)
    })
    expect(invoke).toHaveBeenCalledTimes(CHAPTER_REPAIR_LIMIT + 1)
    const [file] = await readdir(join(dir, '.cache/chapter-runs'))
    const raw = await readFile(join(dir, '.cache/chapter-runs', file), 'utf8')
    expect(raw).not.toContain('private prose')
    expect(JSON.parse(raw)).toMatchObject({ repairs: 3, calls: expect.arrayContaining([expect.objectContaining({ outcome: 'budget_exhausted' })]) })
    await runChapterExecution(dir, 2, () => trackChapterCall('continuityRepair', invoke))
    expect(invoke).toHaveBeenCalledTimes(CHAPTER_REPAIR_LIMIT + 2)
  })
  it('does not budget standalone operations or leak one chapter budget to concurrent chapters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-budget-'))
    await Promise.all([1, 2].map(ch => runChapterExecution(dir, ch, async () => {
      for (let i = 0; i < CHAPTER_REPAIR_LIMIT; i++) await trackChapterCall('deslop:repair', async () => 'ok')
    })))
    for (let i = 0; i < 5; i++) expect(await trackChapterCall('deslop:repair', async () => 'ok')).toBe('ok')
  })
})

it('enforces the budget at the actual LlmService entry point before dispatch', async () => {
  const { LlmService } = await import('../src/main/data/llm-service')
  const { repairContinuity } = await import('../src/main/data/continuity-repair')
  const dir = await mkdtemp(join(tmpdir(), 'chapter-dispatch-'))
  const llm = new LlmService({} as never)
  const dispatch = vi.spyOn(llm as unknown as { generateStreamUntracked: () => Promise<string> }, 'generateStreamUntracked').mockResolvedValue('response')
  await runChapterExecution(dir, 1, async () => {
    for (let i = 0; i < CHAPTER_REPAIR_LIMIT; i++) await llm.generateStream('', { meta: { feature: 'deslop:repair' } })
    // A continuity loop without its own round limit must propagate exhaustion immediately.
    await expect(repairContinuity({ chapterNumber: 1, content: '原稿', issue: '冲突', context: '' }, {
      generate: prompt => llm.generateStream(prompt, { meta: { feature: 'continuityRepair' } }),
      prepare: async text => text, verify: async () => {}, check: async () => ({})
    })).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
    await llm.generateStream('', { meta: { feature: 'longformGuard' } })
  })
  expect(dispatch).toHaveBeenCalledTimes(4)
})
