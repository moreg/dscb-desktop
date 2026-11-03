import { expect, it, vi } from 'vitest'
import { createRendererApi } from '../src/preload/api'

it('passes one snapshot and explicit memory reuse through the cancellable stream bridge', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true }), removeListener = vi.fn()
  const api = createRendererApi({ invoke, on: vi.fn(), removeListener })
  await api.getChapterSyncContext('p', 3, '保存正文')
  expect(invoke).toHaveBeenLastCalledWith('write:syncContext', { projectId: 'p', chapterNumber: 3, content: '保存正文' })
  await api.extractMemoryStream('p', 3, vi.fn(), '保存正文', true)
  expect(invoke).toHaveBeenLastCalledWith('write:extractMemory', expect.objectContaining({ content: '保存正文', reuse: true }))
  await api.evaluateRhythmStream('p', 3, vi.fn(), '保存正文')
  expect(invoke).toHaveBeenLastCalledWith('write:evaluateRhythm', expect.objectContaining({ content: '保存正文' }))
  await api.generateFigureStream('p', 3, vi.fn(), '保存正文')
  expect(invoke).toHaveBeenLastCalledWith('write:generateFigure', expect.objectContaining({ content: '保存正文' }))
  expect(removeListener).toHaveBeenCalledTimes(3)
  await api.extractMemoryStream('p', 3, vi.fn())
  expect(invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty('content')
  expect(invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty('reuse')
})

it('binds backend sync progress and cancellation to one request and cleans up its listener', async () => {
  let complete!: (value: unknown) => void
  const invoke = vi.fn((channel: string, _payload?: unknown) => channel === 'llm:abort' ? Promise.resolve({ ok: true }) : new Promise(resolve => { complete = resolve }))
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const removeListener = vi.fn()
  const api = createRendererApi({ invoke, on: (channel, callback) => { listeners.set(channel, callback) }, removeListener })
  const onStep = vi.fn()
  const request = api.syncChapterWorkflow('p', 1, '正文快照', { force: true }, onStep)
  const payload = invoke.mock.calls[0][1] as unknown as { requestId: string }
  listeners.get('write:syncStep')?.({}, { requestId: 'other', step: { id: 'outline' } })
  expect(onStep).not.toHaveBeenCalled()
  listeners.get('write:syncStep')?.({}, { requestId: payload.requestId, step: { id: 'outline', status: 'running' } })
  expect(onStep).toHaveBeenCalledOnce()
  await request.abort()
  expect(invoke).toHaveBeenLastCalledWith('llm:abort', payload.requestId)
  complete({ steps: [] }); await request
  expect(removeListener).toHaveBeenCalledWith('write:syncStep', expect.any(Function))
})
