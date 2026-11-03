import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AGENT_TASKS, agentTaskOf, featureCategoryOf } from '../src/shared/agent-tasks'
import { ChapterWorkflow } from '../src/main/data/chapter-workflow'
import { recordChapterRetry, recordChapterRoute, trackChapterCall } from '../src/main/data/chapter-execution'
import { ChapterFactSnapshot } from '../src/main/data/chapter-fact-snapshot'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

describe('agent contracts and revision-bound facts', () => {
  it('routes identical single and batch checks consistently and explicitly routes all missing tasks', () => {
    expect(featureCategoryOf('batchOutline')).toBe(featureCategoryOf('outlineCheck'))
    for (const feature of ['memoryEvidenceRepair', 'foreshadowRepairReview', 'char-position-fix',
      'adjust-plan-compliance', 'proseOutlineRewrite', 'downstreamOutlineSync']) expect(agentTaskOf(feature)).toBeDefined()
    expect(agentTaskOf('continuityRepairPlan')).toMatchObject({ role: 'planner', mutation: 'plan_candidate' })
    expect(featureCategoryOf('chapter-refine-verify')).toBe('refineReview')
    expect(agentTaskOf('deslop:cleanup:pass1:2')?.repairBudget).toBe('expression')
    for (const task of Object.values(AGENT_TASKS)) if (task.role === 'reviewer') expect(task.repairBudget).toBeUndefined()
  })
  it('shares one expression pass across nested chapter workflows and keeps other chapters independent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-contract-'))
    await ChapterWorkflow.run(dir, 1, 'continue', async () => {
      expect(ChapterWorkflow.claimExpression()).toBe(true)
      await ChapterWorkflow.run(dir, 1, 'repair', async () => { expect(ChapterWorkflow.claimExpression()).toBe(false) })
      await ChapterWorkflow.run(dir, 2, 'generate', async () => { expect(ChapterWorkflow.claimExpression()).toBe(true) })
      await trackChapterCall('continuityRepairPlan', async () => { recordChapterRoute('opaque-route'); recordChapterRetry() })
      await ChapterWorkflow.stage('expression', 'private prose', async () => false, () => 'rejected')
    })
    const records = await Promise.all((await readdir(join(dir, '.cache/chapter-runs'))).map(async file =>
      JSON.parse(await readFile(join(dir, '.cache/chapter-runs', file), 'utf8'))))
    const record = records.find(item => item.chapter === 1)
    expect(record.calls[0]).toMatchObject({ role: 'planner', route: 'opaque-route', retries: 1, outcome: 'succeeded' })
    expect(record.stages).toContainEqual(expect.objectContaining({ stage: 'expression', verdict: 'rejected' }))
    expect(JSON.stringify(record)).not.toContain('private prose')
  })
  it('preserves concurrent projections, shares only exact evidence and invalidates model/source changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fact-snapshot-'))
    const prose = new ProseRepo(dir)
    const content = '林远把账册交给守门人。守门人让他在门外等候。'
    await prose.write(1, content)
    const first = new ChapterFactSnapshot(dir, 1, content)
    const second = new ChapterFactSnapshot(dir, 1, content)
    await Promise.all([
      first.remember('memory', 'model-a', { events: ['交接'] }, ['林远把账册交给守门人。', '伪造证据不能进入索引']),
      second.remember('ending', 'model-a', { location: '门外' }, ['守门人让他在门外等候。'])
    ])
    expect(await first.read('memory', 'model-a', Boolean)).toEqual({ events: ['交接'] })
    expect(await first.read('ending', 'model-a', Boolean)).toEqual({ location: '门外' })
    expect(await first.read('ending', 'model-b', Boolean)).toBeUndefined()
    expect(await first.context()).not.toContain('伪造证据')
    await prose.write(1, '作者已经改写了正文。')
    expect(await first.read('memory', 'model-a', Boolean)).toBeUndefined()
    await first.remember('ending', 'model-a', { location: '旧位置' })
    const next = new ChapterFactSnapshot(dir, 1, '作者已经改写了正文。')
    expect(await next.read('ending', 'model-a', Boolean)).toBeUndefined()
  })
  it('budgets local sync repairs and still permits final verification after repair exhaustion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sync-budget-'))
    const invoke = vi.fn(async () => 'ok')
    await ChapterWorkflow.run(dir, 1, 'sync', async () => {
      for (let n = 0; n < 12; n++) await trackChapterCall('outlineLocalRepair', invoke)
      await expect(trackChapterCall('outlineLocalRepair', invoke)).rejects.toThrow('CHAPTER_REPAIR_BUDGET')
      await trackChapterCall('outlineLocalRepairVerify', invoke)
    })
    expect(invoke).toHaveBeenCalledTimes(13)
  })
})
