import { expect, it, vi } from 'vitest'
import { createRendererApi } from '../src/preload/api'
import type { RefinementStage } from '../src/shared/chapter-refinement'
it('isolates progress per request, supports abort and removes listeners on completion and rejection', async () => {
  const listeners = new Set<(event: unknown, payload: { requestId: string; stage: RefinementStage }) => void>()
  let finish!: (value: unknown) => void, fail!: (error: Error) => void
  const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject })).mockResolvedValue({ ok: true })
  const api = createRendererApi({ invoke, on: (_name, fn) => listeners.add(fn), removeListener: (_name, fn) => listeners.delete(fn) })
  const input = { projectId: 'p', chapterNumber: 1, content: '原文', goal: 'expression' as const, instruction: '' }
  const a = vi.fn(), b = vi.fn()
  const first = api.refineChapter(input, 'generate', a), second = api.refineChapter(input, 'plan', b)
  for (const listener of listeners) listener(null, { requestId: first.requestId, stage: 'verifying' })
  expect(a).toHaveBeenCalledWith('verifying'); expect(b).not.toHaveBeenCalled()
  await second.abort(); expect(invoke).toHaveBeenLastCalledWith('llm:abort', second.requestId)
  finish({ ok: true }); await first; expect(listeners.size).toBe(1)
  const rejection = expect(second).rejects.toThrow('stopped'); fail(new Error('stopped')); await rejection
  expect(listeners.size).toBe(0)
})
