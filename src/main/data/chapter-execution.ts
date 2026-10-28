import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeJsonAtomic } from './atomic'

export const CHAPTER_REPAIR_LIMIT = 3
interface CallRecord { feature: string; durationMs: number; outcome: 'succeeded' | 'failed' | 'budget_exhausted' }
interface Execution {
  repairs: number
  calls: CallRecord[]
  save: () => Promise<void>
}
const execution = new AsyncLocalStorage<Execution>()
const repairFeature = (feature: string): boolean =>
  /^(continuityRepair|batchForeshadowRepair|chapterForeshadowRepair|chapter-scene-repair|deslop:(scene-repair|repair|dialogue-repair|narrative-repair))$/.test(feature) ||
  /^deslop:cleanup:/.test(feature)

/** One shared budget across nested repair loops; independent chapters never share it. */
export async function runChapterExecution<T>(dir: string, chapter: number, action: () => Promise<T>): Promise<T> {
  if (execution.getStore()) return action()
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  let status: 'running' | 'completed' | 'failed' = 'running'
  const file = join(dir, '.cache', 'chapter-runs', `${chapter}-${randomUUID()}.json`)
  let tail = Promise.resolve()
  const state: Execution = { repairs: 0, calls: [], save: () => {
    const snapshot = { version: 1, chapter, startedAt, repairLimit: CHAPTER_REPAIR_LIMIT,
      repairs: state.repairs, status, durationMs: Date.now() - started, calls: [...state.calls] }
    tail = tail.then(() => writeJsonAtomic(file, snapshot)).catch(() => {
      console.warn('[chapter-execution] 无法保存调用记录')
    })
    return tail
  } }
  return execution.run(state, async () => {
    try { const result = await action(); status = 'completed'; return result }
    catch (error) { status = 'failed'; throw error }
    finally { await state.save() }
  })
}

/** Logs no prompts, responses, endpoints or credentials. Verification is never budgeted away. */
export async function trackChapterCall<T>(feature: string | undefined, action: () => Promise<T>): Promise<T> {
  const state = execution.getStore()
  if (!state) return action()
  const name = feature ?? 'unknown'
  if (repairFeature(name)) {
    if (state.repairs >= CHAPTER_REPAIR_LIMIT) {
      state.calls.push({ feature: name, durationMs: 0, outcome: 'budget_exhausted' })
      await state.save()
      throw new Error(`CHAPTER_REPAIR_BUDGET: 本章本轮已用完 ${CHAPTER_REPAIR_LIMIT} 次自动修复，保留当前稿；请查看未通过项后决定是否重试。`)
    }
    state.repairs++
  }
  const start = Date.now()
  let outcome: CallRecord['outcome'] = 'failed'
  try { const result = await action(); outcome = 'succeeded'; return result }
  finally {
    state.calls.push({ feature: name, durationMs: Date.now() - start, outcome })
    await state.save()
  }
}
