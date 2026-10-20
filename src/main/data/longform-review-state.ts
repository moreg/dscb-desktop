import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { readMemoryText, memoryFileFingerprint } from './memory/repository-cache'

interface PendingReview { sourceHash: string; token: string }
interface ReviewState { version: 1; pending: Record<string, PendingReview>; batchPending?: Record<string, PendingReview> }
const fileFor = (dir: string) => join(dir, '追踪', '.longform-review.json')
interface ReviewInstruction { sourceHash: string; planHash: string; instruction: string }
const instructionFile = (dir: string, chapter: number) => join(dir, '追踪', '.longform-context', `chapter-${chapter}.json`)

export async function readLongformInstruction(dir: string, chapter: number, sourceHash: string, planHash: string): Promise<string | undefined> {
  const file = instructionFile(dir, chapter)
  if (await memoryFileFingerprint(file) === 'missing') return undefined
  try {
    const value = JSON.parse(await readMemoryText(file)) as ReviewInstruction
    if (!value || typeof value.sourceHash !== 'string' || typeof value.planHash !== 'string' ||
      typeof value.instruction !== 'string' || value.instruction.length > 10000) throw new Error()
    return value.sourceHash === sourceHash && value.planHash === planHash ? value.instruction : undefined
  } catch { throw new Error('LONGFORM_STATE_INVALID: 本章临时要求记录损坏，请修复后重新核对。') }
}

/** Durable quarantine, deliberately outside .cache: restarting/clearing a batch cannot approve a draft. */
export async function readLongformReviewState(dir: string): Promise<ReviewState> {
  if (await memoryFileFingerprint(fileFor(dir)) === 'missing') return { version: 1, pending: {} }
  const raw = await readMemoryText(fileFor(dir))
  try {
    const value = JSON.parse(raw) as ReviewState
    const valid = (entries: Record<string, PendingReview>) => entries && typeof entries === 'object' && !Array.isArray(entries) &&
      !Object.entries(entries).some(([chapter, entry]) => !/^[1-9]\d*$/.test(chapter) || !Number.isSafeInteger(Number(chapter)) ||
        !entry || typeof entry.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceHash) || typeof entry.token !== 'string' || !entry.token)
    if (value.version !== 1 || !valid(value.pending) || (value.batchPending !== undefined && !valid(value.batchPending))) throw new Error()
    return value
  } catch { throw new Error('LONGFORM_STATE_INVALID: 长篇核对状态损坏，无法确认待核对正文；请修复状态文件后重试。') }
}

export function blockedLongformChapters(state: ReviewState): Record<string, PendingReview> {
  return { ...state.batchPending, ...state.pending }
}

export async function markBatchReviewPending(dir: string, chapter: number, sourceHash: string): Promise<string> {
  const file = fileFor(dir)
  return withFileLock(file, async () => {
    const state = await readLongformReviewState(dir)
    const token = randomUUID()
    state.batchPending = { ...state.batchPending, [String(chapter)]: { sourceHash, token } }
    await writeJsonAtomic(file, state)
    return token
  })
}

export async function clearBatchReviewPending(dir: string, chapter: number, token: string): Promise<void> {
  const file = fileFor(dir)
  await withFileLock(file, async () => {
    const state = await readLongformReviewState(dir)
    if (state.batchPending?.[String(chapter)]?.token !== token || state.pending[String(chapter)]) {
      throw new Error('LONGFORM_REVIEW_PENDING: 当前批次已更新或本章仍待长篇核对，不能确认完成。')
    }
    delete state.batchPending[String(chapter)]
    await writeJsonAtomic(file, state)
  })
}

export async function markLongformPending(dir: string, chapter: number, sourceHash: string): Promise<string> {
  const file = fileFor(dir)
  return withFileLock(file, async () => {
    const state = await readLongformReviewState(dir)
    const token = randomUUID()
    state.pending[String(chapter)] = { sourceHash, token }
    await writeJsonAtomic(file, state)
    return token
  })
}

export async function clearLongformPending(dir: string, chapter: number, token: string, context?: ReviewInstruction): Promise<void> {
  const file = fileFor(dir)
  await withFileLock(file, async () => {
    const state = await readLongformReviewState(dir)
    if (state.pending[String(chapter)]?.token !== token) throw new Error('LONGFORM_CONTEXT_CHANGED: 本章已有更新的核对任务，旧结果不能解除待核对状态。')
    if (context) {
      if (context.instruction.length > 10000) throw new Error('LONGFORM_CONTEXT_TOO_LARGE: 临时要求超过10000字符，无法保存核对上下文。')
      await writeJsonAtomic(instructionFile(dir, chapter), context)
    }
    delete state.pending[String(chapter)]
    await writeJsonAtomic(file, state)
  })
}
