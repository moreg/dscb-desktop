import { beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { registerChapterRefinementIpc } from '../src/main/ipc/chapter-refinement'
import type { ChapterRefinementService } from '../src/main/data/chapter-refinement-service'
import { abortStream, activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'
const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, payload: unknown) => Promise<unknown>>(), send: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => ({}) } }))
vi.mock('../src/main/ipc/safe-handle', () => ({ safeHandle: (name: string, handler: (e: unknown, p: unknown) => Promise<unknown>) => handlers.set(name, handler), safeSend: send }))
const generate = vi.fn(), plan = vi.fn(), commit = vi.fn(), load = vi.fn(), discard = vi.fn(), recordDetection = vi.fn()
const input = { projectId: 'project', chapterNumber: 1, content: '正文', goal: 'expression', instruction: '' }
beforeEach(() => {
  vi.clearAllMocks(); clearAllStreams(); handlers.clear()
  registerChapterRefinementIpc({ generate, plan, commit, load, discard, recordDetection } as unknown as ChapterRefinementService)
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
  expect(commit).toHaveBeenCalledWith('project', 1, id, '原文', false, undefined)
})
it('forwards a hunk index for single-change adoption and ignores client-supplied candidate text', async () => {
  const id = randomUUID(); commit.mockResolvedValue({ content: '混写正文' })
  expect(await handlers.get('refinement:commit')!({}, {
    projectId: 'project', chapterNumber: 1, id, currentDraft: '原文', undo: false, hunkIndex: 2, candidate: '伪造稿'
  })).toEqual({ content: '混写正文' })
  expect(commit).toHaveBeenCalledWith('project', 1, id, '原文', false, 2)
})

it('validates manual detector reports and passes the exact tested manuscript, not a client hash', async () => {
  const id = randomUUID()
  recordDetection.mockResolvedValue({ id })
  await expect(handlers.get('refinement:record-detection')!({}, { projectId: 'project', chapterNumber: 1, id, testedContent: '当前完整候选。', result: { status: 'green', score: 101, note: '' } })).rejects.toThrow()
  expect(recordDetection).not.toHaveBeenCalled()
  expect(await handlers.get('refinement:record-detection')!({}, { projectId: 'project', chapterNumber: 1, id,
    testedContent: '当前完整候选。', result: { status: 'green', score: 0, note: '人工复测', contentHash: '伪造哈希', source: 'automatic' } })).toEqual({ id })
  expect(recordDetection).toHaveBeenCalledWith('project', 1, id, '当前完整候选。', { status: 'green', score: 0, note: '人工复测' })
})
it('forwards detection feedback and rejects malformed excerpt lists before generating', async () => {
  await expect(handlers.get('refinement:run')!({ sender: {} }, { input: { ...input, goal: 'detection', detection: { excerpts: [] } }, action: 'generate', requestId: randomUUID() })).rejects.toThrow()
  expect(generate).not.toHaveBeenCalled()
  generate.mockResolvedValue({ status: 'ready' })
  const directed = { ...input, goal: 'detection', detection: { excerpts: ['这是一段标黄的当前原文。'], score: 35 } }
  await handlers.get('refinement:run')!({ sender: {} }, { input: directed, action: 'generate', requestId: randomUUID() })
  expect(generate.mock.calls[0][0]).toEqual(directed)
})
