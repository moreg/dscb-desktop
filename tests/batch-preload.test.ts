import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'

type Listener = (event: unknown, payload: unknown) => void
const { listeners, invoke, expose } = vi.hoisted(() => ({
  listeners: new Map<string, Set<Listener>>(),
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(),
  expose: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: {
    invoke,
    on: (channel: string, listener: Listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    },
    removeListener: (channel: string, listener: Listener) => listeners.get(channel)?.delete(listener)
  }
}))

await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi
function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(null, payload)
}

describe('批量 preload 的请求隔离与事件生命周期', () => {
  beforeEach(() => {
    listeners.clear()
    invoke.mockReset()
  })

  it.each(['generateBatch', 'resumeBatch'] as const)('%s 只处理本次事件，完成和异常都清理全部监听', async (method) => {
    let finishFirst!: (value: unknown) => void
    let failSecond!: (reason: Error) => void
    invoke
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject }))
    const firstChapter = vi.fn()
    const firstToken = vi.fn()
    const firstRetry = vi.fn()
    const secondChapter = vi.fn()
    const secondToken = vi.fn()
    const secondRetry = vi.fn()
    const state = { fromChapter: 1, total: 10, completed: [1], pendingPostProcessChapter: 1 }
    const first = api[method]('project-1', 1, 10, 'style-1', firstChapter, firstToken, 'batch-a', state, true, true, firstRetry)
    const second = api[method]('project-2', 1, 10, null, secondChapter, secondToken, 'batch-b', undefined, false, false, secondRetry)
    expect(invoke.mock.calls[0]).toEqual([`write:${method}`, {
      projectId: 'project-1', fromChapter: 1, toChapter: 10, styleProfileId: 'style-1',
      requestId: 'batch-a', batchState: state, autoContinue: true, autoStrength: true
    }])
    for (const requestId of ['foreign-request', 'batch-a']) {
      emit('write:batchChapterComplete', { requestId, chapter: 1, result: { chapterNumber: 1 } })
      emit('llm:token', { requestId, token: '正文', done: false })
      emit('write:batchRetryWait', { requestId, chapter: 2, attempt: 1, maxAttempts: 3, waitMs: 30_000 })
    }
    expect(firstChapter.mock.calls).toEqual([[1, { chapterNumber: 1 }]])
    expect(firstToken.mock.calls).toEqual([['正文', false]])
    expect(firstRetry.mock.calls).toEqual([[2, 1, 3, 30_000]])
    expect(secondChapter).not.toHaveBeenCalled()
    expect(secondToken).not.toHaveBeenCalled()
    expect(secondRetry).not.toHaveBeenCalled()

    finishFirst({ ok: true })
    await first
    for (const channel of ['write:batchChapterComplete', 'llm:token', 'write:batchRetryWait']) {
      expect(listeners.get(channel)?.size).toBe(1)
    }
    emit('llm:token', { requestId: 'batch-a', token: '过期事件', done: true })
    emit('llm:token', { requestId: 'batch-b', token: '第二批', done: false })
    expect(firstToken).toHaveBeenCalledTimes(1)
    expect(secondToken.mock.calls).toEqual([['第二批', false]])
    const rejection = expect(second).rejects.toThrow('IPC 通信失败')
    failSecond(new Error('IPC 通信失败'))
    await rejection
    for (const channel of ['write:batchChapterComplete', 'llm:token', 'write:batchRetryWait']) {
      expect(listeners.get(channel)?.size).toBe(0)
    }
  })
})
