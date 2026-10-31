import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeJsonAtomic } from './atomic'

export const CHAPTER_REPAIR_LIMIT = 12
export const CHAPTER_EXPRESSION_REPAIR_LIMIT = 3
type RepairKind = 'content' | 'expression'
interface CallRecord { feature: string; durationMs: number; outcome: 'succeeded' | 'failed' | 'budget_exhausted' }
interface Execution {
  dir: string
  chapter: number
  repairs: number
  repairsByKind: Record<RepairKind, number>
  calls: CallRecord[]
  save: () => Promise<void>
}
const execution = new AsyncLocalStorage<Execution>()
function repairKind(feature: string): RepairKind | undefined {
  if (/^(continuityRepair|batchForeshadowRepair|chapterForeshadowRepair)$/.test(feature)) return 'content'
  if (/^(chapter-scene-repair|deslop:(scene-repair|repair|dialogue-repair|narrative-repair))$/.test(feature) ||
      /^deslop:cleanup:/.test(feature)) return 'expression'
  return undefined
}

/** Nested loops share bounded budgets, while polishing cannot consume the content repair budget. */
export async function runChapterExecution<T>(dir: string, chapter: number, action: () => Promise<T>): Promise<T> {
  const parent = execution.getStore()
  if (parent?.dir === dir && parent.chapter === chapter) return action()
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  let status: 'running' | 'completed' | 'failed' = 'running'
  const file = join(dir, '.cache', 'chapter-runs', `${chapter}-${randomUUID()}.json`)
  let tail = Promise.resolve()
  const state: Execution = { dir, chapter, repairs: 0, repairsByKind: { content: 0, expression: 0 }, calls: [], save: () => {
    const snapshot = { version: 2, chapter, startedAt, repairLimit: CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT,
      repairLimits: { content: CHAPTER_REPAIR_LIMIT, expression: CHAPTER_EXPRESSION_REPAIR_LIMIT },
      repairsByKind: { ...state.repairsByKind }, repairs: state.repairs, status, durationMs: Date.now() - started, calls: [...state.calls] }
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
  const kind = repairKind(name)
  if (kind) {
    const limit = kind === 'content' ? CHAPTER_REPAIR_LIMIT : CHAPTER_EXPRESSION_REPAIR_LIMIT
    if (state.repairsByKind[kind] >= limit) {
      state.calls.push({ feature: name, durationMs: 0, outcome: 'budget_exhausted' })
      await state.save()
      throw new Error(`CHAPTER_REPAIR_BUDGET: 本章本轮已用完 ${limit} 次${kind === 'content' ? '剧情纠错' : '表达润色'}，保留当前稿；${kind === 'content' ? '可重试修复当前稿。' : '剧情纠错额度独立保留。'}`)
    }
    state.repairs++
    state.repairsByKind[kind]++
  }
  const start = Date.now()
  let outcome: CallRecord['outcome'] = 'failed'
  try { const result = await action(); outcome = 'succeeded'; return result }
  finally {
    state.calls.push({ feature: name, durationMs: Date.now() - start, outcome })
    await state.save()
  }
}
