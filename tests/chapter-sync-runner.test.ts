import { describe, expect, it, vi } from 'vitest'
import { ChapterSyncRunner, type SyncStep, type SyncTask } from '../src/renderer/src/chapter-sync-runner'

describe('incremental chapter sync', () => {
  it('retries only failed analysis, still validates summary, and limits model concurrency to two', async () => {
    const runner = new ChapterSyncRunner(), steps: SyncStep[] = []
    let active = 0, peak = 0
    const run = () => vi.fn(async () => { active++; peak = Math.max(active, peak); await Promise.resolve(); active--; return true })
    const outline = run(), memory = run(), summary = run()
    memory.mockResolvedValueOnce(false)
    const tasks: SyncTask[] = [{ id: 'outline', run: outline }, { id: 'memory', run: memory }, { id: 'summary', run: summary, written: true, always: true }]
    await runner.run(tasks, async () => 'same', () => true, step => steps.push(step))
    await runner.run(tasks, async () => 'same', () => true, step => steps.push(step))
    expect(outline).toHaveBeenCalledTimes(1)
    expect(memory).toHaveBeenCalledTimes(2)
    expect(summary).toHaveBeenCalledTimes(2)
    expect(peak).toBeLessThanOrEqual(2)
    expect(steps).toContainEqual(expect.objectContaining({ id: 'outline', status: 'reused' }))
    expect(steps).toContainEqual(expect.objectContaining({ id: 'memory', status: 'failed' }))
    expect(steps).toContainEqual(expect.objectContaining({ id: 'summary', status: 'written' }))
  })
  it('invalidates after source/config changes; unknown model identities and force never reuse', async () => {
    const runner = new ChapterSyncRunner(), run = vi.fn(async () => true)
    const tasks: SyncTask[] = [{ id: 'memory', run }]
    for (const key of ['old', 'new', null, null]) await runner.run(tasks, async () => key, () => true, () => {})
    await runner.run(tasks, async () => 'new', () => true, () => {}, true)
    expect(run).toHaveBeenCalledTimes(5)
  })
  it('does not launch any work for unsaved prose or continue after source changes during analysis', async () => {
    const runner = new ChapterSyncRunner(), run = vi.fn(async () => true), summary = vi.fn(async () => true)
    const tasks: SyncTask[] = [{ id: 'outline', run }, { id: 'memory', run }, { id: 'summary', run: summary }]
    await expect(runner.run(tasks, async () => { throw new Error('save first') }, () => true, () => {})).rejects.toThrow('save first')
    expect(run).not.toHaveBeenCalled()
    let key = 'before'
    run.mockImplementation(async () => { key = 'after'; return true })
    await expect(runner.run(tasks, async () => key, () => true, () => {})).rejects.toThrow('已变化')
    expect(summary).not.toHaveBeenCalled()
  })
  it('accepts index updates before taking the analysis fingerprint and rejects stale chapter callbacks', async () => {
    const runner = new ChapterSyncRunner()
    let key = 'old', current = true
    const summary = vi.fn(async () => true)
    const tasks: SyncTask[] = [
      { id: 'index', always: true, written: true, run: async () => { key = 'new'; return true } },
      { id: 'outline', run: async () => { current = false; return true } },
      { id: 'memory', run: async () => true },
      { id: 'summary', run: summary }
    ]
    await expect(runner.run(tasks, async () => key, () => current, () => {})).rejects.toThrow('正文或章节已变化')
    expect(summary).not.toHaveBeenCalled()
  })
})
