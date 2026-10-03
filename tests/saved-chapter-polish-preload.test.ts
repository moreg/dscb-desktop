import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi, SavedChapterPolishResult } from '../src/shared/types'
type Listener = (event: unknown, payload: unknown) => void
const { listeners, invoke, expose } = vi.hoisted(() => ({
  listeners: new Map<string, Set<Listener>>(),
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(), expose: vi.fn()
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
const emit = (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(null, payload) }

describe('批量精修 preload 请求隔离与清理', () => {
  beforeEach(() => { listeners.clear(); invoke.mockReset() })

  it('事件只交给对应请求，成功和失败均清理监听', async () => {
    let finish!: (value: unknown) => void
    let reject!: (error: Error) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const completeA = vi.fn(), completeB = vi.fn(), progressA = vi.fn(), progressB = vi.fn()
    const first = api.polishChaptersBatch('p-1', 1, 10, 'style', completeA, progressA, 'polish-a')
    const second = api.polishChaptersBatch('p-2', 11, 20, null, completeB, progressB, 'polish-b')
    expect(invoke.mock.calls[0]).toEqual(['write:polishChaptersBatch', {
      projectId: 'p-1', fromChapter: 1, toChapter: 10, styleProfileId: 'style', requestId: 'polish-a'
    }])
    const result: SavedChapterPolishResult = { chapterNumber: 1, changed: true,
      autoDeslop: { status: 'applied', message: '精修已保存', remainingIssues: 0 } }
    for (const requestId of ['foreign', 'polish-a']) {
      emit('write:batchPolishChapterComplete', { requestId, chapter: 1, result })
      emit('write:batchPolishProgress', { requestId, chapter: 1, step: 'deslop' })
    }
    expect(completeA.mock.calls).toEqual([[1, result]])
    expect(progressA.mock.calls).toEqual([[1, 'deslop']])
    expect(completeB).not.toHaveBeenCalled()
    expect(progressB).not.toHaveBeenCalled()
    finish({ ok: true, results: [result] })
    expect(await first).toEqual({ ok: true, results: [result] })
    expect(listeners.get('write:batchPolishChapterComplete')?.size).toBe(1)
    expect(listeners.get('write:batchPolishProgress')?.size).toBe(1)
    emit('write:batchPolishProgress', { requestId: 'polish-a', chapter: 2, step: 'summary' })
    expect(progressA).toHaveBeenCalledTimes(1)
    const rejection = expect(second).rejects.toThrow('IPC 失败')
    reject(new Error('IPC 失败'))
    await rejection
    expect(listeners.get('write:batchPolishChapterComplete')?.size).toBe(0)
    expect(listeners.get('write:batchPolishProgress')?.size).toBe(0)
  })

  it('不传进度回调时仅注册完成监听，自动生成可识别的 requestId', async () => {
    invoke.mockResolvedValue({ ok: true, results: [] })
    await api.polishChaptersBatch('p-1', 1, 1, undefined, vi.fn())
    expect(invoke.mock.calls[0][1]).toMatchObject({ requestId: expect.any(String) })
    expect(listeners.has('write:batchPolishProgress')).toBe(false)
    expect(listeners.get('write:batchPolishChapterComplete')?.size).toBe(0)
  })
})
