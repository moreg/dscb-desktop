import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runChapterExecution, trackChapterCall, CHAPTER_REPAIR_LIMIT, CHAPTER_EXPRESSION_REPAIR_LIMIT } from '../src/main/data/chapter-execution'

describe('chapter-wide repair budget', () => {
  it('reserves content repairs after polishing, shares nested budgets and logs no prose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-budget-'))
    const invoke = vi.fn(async () => 'private prose')
    await runChapterExecution(dir, 1, async () => {
      await trackChapterCall('deslop:scene-repair', invoke)
      await trackChapterCall('chapter-scene-repair', invoke)
      await trackChapterCall('deslop:repair', invoke)
      await expect(trackChapterCall('deslop:cleanup:line', invoke)).rejects.toThrow('表达润色')
      await runChapterExecution(dir, 1, async () => {
        await trackChapterCall('continuityRepair', invoke)
        await trackChapterCall('continuityRepair', invoke)
        await trackChapterCall('batchForeshadowRepair', invoke)
        for (let i = 3; i < CHAPTER_REPAIR_LIMIT; i++) await trackChapterCall('continuityRepair', invoke)
      })
      await expect(trackChapterCall('chapterForeshadowRepair', invoke)).rejects.toThrow('剧情纠错')
      await trackChapterCall('longformGuard', invoke)
    })
    expect(invoke).toHaveBeenCalledTimes(CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT + 1)
    const [file] = await readdir(join(dir, '.cache/chapter-runs'))
    const raw = await readFile(join(dir, '.cache/chapter-runs', file), 'utf8')
    expect(raw).not.toContain('private prose')
    expect(JSON.parse(raw)).toMatchObject({ repairs: CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT, repairLimit: CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT, repairsByKind: { content: CHAPTER_REPAIR_LIMIT, expression: CHAPTER_EXPRESSION_REPAIR_LIMIT },
      calls: expect.arrayContaining([expect.objectContaining({ outcome: 'budget_exhausted' })]) })
    await runChapterExecution(dir, 2, () => trackChapterCall('continuityRepair', invoke))
    expect(invoke).toHaveBeenCalledTimes(CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT + 2)
  })
  it('does not budget standalone operations or leak one chapter budget to concurrent chapters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-budget-'))
    await Promise.all([1, 2].map(ch => runChapterExecution(dir, ch, async () => {
      for (let i = 0; i < CHAPTER_EXPRESSION_REPAIR_LIMIT; i++) await trackChapterCall('deslop:repair', async () => 'ok')
    })))
    for (let i = 0; i < 5; i++) expect(await trackChapterCall('deslop:repair', async () => 'ok')).toBe('ok')
  })
  it('gives recovered earlier chapters their own budget and restores the current chapter budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chapter-recovery-budget-'))
    await runChapterExecution(dir, 3, async () => {
      await trackChapterCall('continuityRepair', async () => 'ok')
      await runChapterExecution(dir, 2, async () => {
        for (let i = 0; i < CHAPTER_EXPRESSION_REPAIR_LIMIT; i++) await trackChapterCall('deslop:repair', async () => 'ok')
        await expect(trackChapterCall('deslop:repair', async () => 'ok')).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
      })
      for (let i = 1; i < CHAPTER_REPAIR_LIMIT; i++) await trackChapterCall('continuityRepair', async () => 'ok')
      await expect(trackChapterCall('continuityRepair', async () => 'ok')).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
    })
    const files = await readdir(join(dir, '.cache/chapter-runs'))
    const records = await Promise.all(files.map(file => readFile(join(dir, '.cache/chapter-runs', file), 'utf8').then(JSON.parse)))
    expect(records).toHaveLength(2)
    expect(records.map(r => r.chapter).sort()).toEqual([2, 3])
    expect(records.map(r => [r.chapter, r.repairs]).sort((a, b) => a[0] - b[0])).toEqual([[2, CHAPTER_EXPRESSION_REPAIR_LIMIT], [3, CHAPTER_REPAIR_LIMIT]])
  })
})

it('enforces the budget at the actual LlmService entry point before dispatch', async () => {
  const { LlmService } = await import('../src/main/data/llm-service')
  const { repairContinuity } = await import('../src/main/data/continuity-repair')
  const dir = await mkdtemp(join(tmpdir(), 'chapter-dispatch-'))
  const llm = new LlmService({} as never)
  const dispatch = vi.spyOn(llm as unknown as { generateStreamUntracked: () => Promise<string> }, 'generateStreamUntracked').mockResolvedValue('response')
  await runChapterExecution(dir, 1, async () => {
    for (let i = 0; i < CHAPTER_REPAIR_LIMIT; i++) await llm.generateStream('', { meta: { feature: 'continuityRepair' } })
    // A continuity loop without its own round limit must propagate exhaustion immediately.
    await expect(repairContinuity({ chapterNumber: 1, content: '原稿', issue: '冲突', context: '' }, {
      generate: prompt => llm.generateStream(prompt, { meta: { feature: 'continuityRepair' } }),
      verify: async () => {}, check: async () => ({})
    })).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
    await llm.generateStream('', { meta: { feature: 'longformGuard' } })
  })
  expect(dispatch).toHaveBeenCalledTimes(CHAPTER_REPAIR_LIMIT + 1)
})
