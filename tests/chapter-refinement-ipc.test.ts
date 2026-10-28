import { beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { registerChapterRefinementIpc } from '../src/main/ipc/chapter-refinement'
import type { ChapterRefinementService } from '../src/main/data/chapter-refinement-service'
import { abortStream, activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'
const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, payload: unknown) => Promise<unknown>>(), send: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => ({}) } }))
vi.mock('../src/main/ipc/safe-handle', () => ({ safeHandle: (name: string, handler: (e: unknown, p: unknown) => Promise<unknown>) => handlers.set(name, handler), safeSend: send }))
const generate = vi.fn(), plan = vi.fn(), commit = vi.fn(), load = vi.fn(), discard = vi.fn()
const input = { projectId: 'project', chapterNumber: 1, content: '正文', goal: 'expression', instruction: '' }
beforeEach(() => {
  vi.clearAllMocks(); clearAllStreams(); handlers.clear()
  registerChapterRefinementIpc({ generate, plan, commit, load, discard } as unknown as ChapterRefinementService)
})
it('validates scope and IDs before starting model work', async () => {
  await expect(handlers.get('refinement:run')!({ sender: {} }, { input: { ...input, selection: { start: -1, end: 4 } }, action: 'generate', requestId: randomUUID() })).rejects.toThrow()
  expect(generate).not.toHaveBeenCalled(); expect(activeStreamCount()).toBe(0)
})
it('propagates early cancellation and cleans up its request registry', async () => {
  const requestId = randomUUID(); abortStream(requestId)
  generate.mockImplementationOnce(async (_input, signal, progress) => {
    expect(signal.aborted).toBe(true); progress('verifying'); throw new Error('LLM_ABORTED')
  })
  expect(await handlers.get('refinement:run')!({ sender: {} }, { input, action: 'generate', requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
  expect(send).toHaveBeenCalledWith(expect.anything(), 'refinement:stage', { requestId, stage: 'verifying' })
  expect(activeStreamCount()).toBe(0)
})
it('commits only a server-side candidate ID and passes the editor baseline for conflict checking', async () => {
  const id = randomUUID(); commit.mockResolvedValue({ content: '候选' })
  expect(await handlers.get('refinement:commit')!({}, { projectId: 'project', chapterNumber: 1, id, currentDraft: '原文', undo: false, candidate: '伪造稿' })).toEqual({ content: '候选' })
  expect(commit).toHaveBeenCalledWith('project', 1, id, '原文', false)
})
