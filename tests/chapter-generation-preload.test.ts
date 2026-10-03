import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoDeslopResult, RendererApi } from '../src/shared/types'

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

describe('正文 preload 阶段事件与最终内容', () => {
  beforeEach(() => { listeners.clear(); invoke.mockReset() })

  it.each(['generateChapterStream', 'adjustChapterStream'] as const)('%s 原稿 done 不结束最终回包等待，阶段只通知本次请求', async (method) => {
    let finish!: (value: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const onToken = vi.fn()
    const onStage = vi.fn()
    const stream = method === 'generateChapterStream'
      ? api.generateChapterStream('project-1', 1, null, undefined, '前文', onToken, onStage)
      : api.adjustChapterStream('project-1', 1, '原稿', '精修对白', null, onToken, '确认方案', onStage)
    let resolved = false
    void stream.then(() => { resolved = true })
    emit('write:generationStage', { requestId: 'other-request', stage: 'deslop' })
    emit('llm:token', { requestId: stream.requestId, token: '生成预览', done: false })
    emit('llm:token', { requestId: stream.requestId, token: '', done: true })
    emit('write:generationStage', { requestId: stream.requestId, stage: 'deslop' })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(onStage.mock.calls).toEqual([['deslop']])
    expect(listeners.get('write:generationStage')?.size).toBe(1)
    const autoDeslop: AutoDeslopResult = { status: 'applied', message: '已精修', remainingIssues: 0 }
    finish({ ok: true, content: '精修最终稿', autoDeslop })
    expect(await stream).toEqual({ ok: true, content: '精修最终稿', autoDeslop })
    expect(listeners.get('llm:token')?.size).toBe(0)
    expect(listeners.get('write:generationStage')?.size).toBe(0)
    emit('llm:token', { requestId: stream.requestId, token: '迟到的原始稿', done: true })
    emit('write:generationStage', { requestId: stream.requestId, stage: 'generating' })
    expect(onToken.mock.calls).toEqual([['生成预览', false], ['', true]])
    expect(onStage).toHaveBeenCalledTimes(1)
  })

  it('自动润色阶段仍可取消，同一请求异常后清理 token 与阶段监听', async () => {
    let fail!: (reason: Error) => void
    invoke
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockResolvedValueOnce({ ok: true })
    const stage = vi.fn()
    const stream = api.generateChapterStream('project-1', 1, null, undefined, undefined, vi.fn(), stage)
    emit('write:generationStage', { requestId: stream.requestId, stage: 'deslop' })
    await stream.abort()
    expect(invoke.mock.calls[1]).toEqual(['llm:abort', stream.requestId])
    const rejection = expect(stream).rejects.toThrow('IPC 通信失败')
    fail(new Error('IPC 通信失败'))
    await rejection
    expect(listeners.get('llm:token')?.size).toBe(0)
    expect(listeners.get('write:generationStage')?.size).toBe(0)
  })
})
