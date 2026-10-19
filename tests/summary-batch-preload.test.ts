import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'
type Listener = (event: unknown, payload: unknown) => void
const { listeners, invoke, expose } = vi.hoisted(() => ({ listeners: new Map<string, Set<Listener>>(),
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(), expose: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: {
  invoke, on: (name: string, fn: Listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) },
  removeListener: (name: string, fn: Listener) => listeners.get(name)?.delete(fn)
} }))
await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi
describe('批量概要 preload', () => {
  beforeEach(() => { listeners.clear(); invoke.mockReset() })
  it('隔离不同请求的进度与结果，成功或异常均清理事件', async () => {
    let finish!: (value: unknown) => void, fail!: (error: Error) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const a = vi.fn(), b = vi.fn(), progress = vi.fn()
    const options = { fromChapter: 1, toChapter: 800, onlyMissing: false }
    const first = api.regenerateSummariesBatch('p', options, a, progress, 'a')
    const second = api.regenerateSummariesBatch('q', options, b, undefined, 'b')
    expect(invoke.mock.calls[0]).toEqual(['write:regenerateSummariesBatch', { ...options, projectId: 'p', requestId: 'a' }])
    const result = { chapterNumber: 3, status: 'generated' }
    for (const requestId of ['a', 'foreign']) {
      for (const fn of listeners.get('write:batchSummaryChapterComplete')!) fn(null, { requestId, result })
      for (const fn of listeners.get('write:batchSummaryProgress')!) fn(null, { requestId, progress: { chapter: 3, index: 1, total: 8 } })
    }
    expect(a.mock.calls).toEqual([[result]])
    expect(b).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledTimes(1)
    finish({ ok: true, results: [result] }); await first
    expect(listeners.get('write:batchSummaryChapterComplete')!.size).toBe(1)
    const rejected = expect(second).rejects.toThrow('IPC失败')
    fail(new Error('IPC失败')); await rejected
    expect(listeners.get('write:batchSummaryChapterComplete')!.size).toBe(0)
    expect(listeners.get('write:batchSummaryProgress')!.size).toBe(0)
  })
})
