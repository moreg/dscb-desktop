import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeJsonAtomic } from './atomic'
import { agentTaskOf, type AgentRole } from '../../shared/agent-tasks'

import { CHAPTER_REPAIR_LIMIT, CHAPTER_EXPRESSION_REPAIR_LIMIT } from '../../shared/chapter-repair-limits'
export { CHAPTER_REPAIR_LIMIT, CHAPTER_EXPRESSION_REPAIR_LIMIT } from '../../shared/chapter-repair-limits'
type RepairKind = 'content' | 'expression'
interface CallRecord { feature: string; role?: AgentRole; durationMs: number; outcome: 'succeeded' | 'failed' | 'budget_exhausted';
  route?: string; retries?: number }
export interface ChapterStageRecord {
  stage: string
  verdict: 'passed' | 'rejected' | 'incomplete' | 'cached'
  inputRevision?: string
  outputRevision?: string
  attemptKind?: 'format' | 'repair' | 'verification'
  durationMs?: number
}
interface Execution {
  dir: string
  chapter: number
  repairs: number
  repairsByKind: Record<RepairKind, number>
  calls: CallRecord[]
  stages: ChapterStageRecord[]
  started: number
  save: () => Promise<void>
}
const execution = new AsyncLocalStorage<Execution>()
const callContext = new AsyncLocalStorage<CallRecord>()
/** Count retries separately from logical calls; never record prompts or error bodies. */
export function recordChapterRetry(): void {
  const call = callContext.getStore()
  if (call) call.retries = (call.retries ?? 0) + 1
}
export function recordChapterRoute(route: string): void {
  const call = callContext.getStore()
  if (call) call.route = route
}
export function recordChapterStage(record: ChapterStageRecord): void {
  const state = execution.getStore()
  if (state && state.stages.length < 256) state.stages.push(record)
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
  const state: Execution = { dir, chapter, started, stages: [], repairs: 0, repairsByKind: { content: 0, expression: 0 }, calls: [], save: () => {
    const snapshot = { version: 3, chapter, startedAt, repairLimit: CHAPTER_REPAIR_LIMIT + CHAPTER_EXPRESSION_REPAIR_LIMIT,
      repairLimits: { content: CHAPTER_REPAIR_LIMIT, expression: CHAPTER_EXPRESSION_REPAIR_LIMIT },
      repairsByKind: { ...state.repairsByKind }, repairs: state.repairs, status, durationMs: Date.now() - started,
      calls: [...state.calls], stages: [...state.stages] }
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
  const task = agentTaskOf(name)
  const kind: RepairKind | undefined = task?.repairBudget
  if (kind) {
    const limit = kind === 'content' ? CHAPTER_REPAIR_LIMIT : CHAPTER_EXPRESSION_REPAIR_LIMIT
    if (state.repairsByKind[kind] >= limit || state.calls.length >= 64 || Date.now() - state.started > 30 * 60_000) {
      state.calls.push({ feature: name, role: task?.role, durationMs: 0, outcome: 'budget_exhausted' })
      await state.save()
      const reason = state.repairsByKind[kind] >= limit
        ? `已用完 ${limit} 次${kind === 'content' ? '剧情纠错' : '表达润色'}`
        : Date.now() - state.started > 30 * 60_000 ? '执行已超过 30 分钟' : '模型调用已达到 64 次'
      throw new Error(`CHAPTER_REPAIR_BUDGET: 本章本轮${reason}，停止追加修订并保留当前稿；必需核验仍会执行，可稍后重试修复当前稿。`)
    }
    state.repairs++
    state.repairsByKind[kind]++
  }
  const start = Date.now()
  const call: CallRecord = { feature: name, role: task?.role, durationMs: 0, outcome: 'failed' }
  try { const result = await callContext.run(call, action); call.outcome = 'succeeded'; return result }
  finally {
    call.durationMs = Date.now() - start
    state.calls.push(call)
    await state.save()
  }
}
