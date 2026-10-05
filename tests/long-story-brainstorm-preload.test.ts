import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'
import type { LongStoryBrainstormInput, LongStoryBrainstormResult } from '../src/shared/long-story-brainstorm'

const { invoke, expose, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(), expose: vi.fn(), on: vi.fn(), removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke, on, removeListener }
}))
await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi
const input: LongStoryBrainstormInput = { genre: '玄幻', direction: '以记忆为代价修行', requirements: '', targetChapters: 200 }

beforeEach(() => { invoke.mockReset(); on.mockClear(); removeListener.mockClear() })

describe('长篇脑洞 preload', () => {
  it('无需先创建项目，独立请求只接收自己的流事件并可取消', async () => {
    const pending = new Map<string, (result: LongStoryBrainstormResult) => void>()
    invoke.mockImplementation((channel: string, payload: { requestId: string }) => channel === 'longStory:brainstorm'
      ? new Promise(resolve => pending.set(payload.requestId, resolve)) : Promise.resolve({ ok: true }))
    const firstToken = vi.fn()
    const secondToken = vi.fn()
    const first = api.brainstormLongStory(input, firstToken)
    const second = api.brainstormLongStory({ ...input, targetChapters: undefined }, secondToken)
    expect(first.requestId).not.toBe(second.requestId)
    expect(invoke).toHaveBeenCalledWith('longStory:brainstorm', { ...input, requestId: first.requestId })
    expect(on.mock.calls.map(call => call[0])).toEqual(['longStory:brainstormToken', 'longStory:brainstormToken'])
    for (const [, callback] of on.mock.calls) {
      callback(null, { requestId: first.requestId, token: '第一本书', done: false })
      callback(null, { requestId: second.requestId, token: '第二本书', done: true })
    }
    expect(firstToken.mock.calls).toEqual([['第一本书', false]])
    expect(secondToken.mock.calls).toEqual([['第二本书', true]])
    await first.abort()
    expect(invoke).toHaveBeenLastCalledWith('llm:abort', first.requestId)
    pending.get(first.requestId)!({ ok: false, error: 'LLM_ABORTED' })
    pending.get(second.requestId)!({ ok: true, ideas: [], warning: '保留原始文本' })
    expect(await first).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(await second).toEqual({ ok: true, ideas: [], warning: '保留原始文本' })
    expect(removeListener.mock.calls).toEqual(on.mock.calls)
  })

  it('IPC拒绝后清理监听，不占用短篇或正文通道', async () => {
    invoke.mockRejectedValue(new Error('IPC_INPUT_INVALID'))
    const handle = api.brainstormLongStory(input, vi.fn())
    await expect(Promise.resolve(handle)).rejects.toThrow('IPC_INPUT_INVALID')
    expect(removeListener).toHaveBeenCalledWith('longStory:brainstormToken', on.mock.calls[0][1])
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
