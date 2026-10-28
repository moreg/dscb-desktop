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
