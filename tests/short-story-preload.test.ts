import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'
import type { ShortStoryBrainstormInput, ShortStoryBrainstormResult, ShortStoryGenerationInput } from '../src/shared/short-story'

const { invoke, expose, on, removeListener } = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke, on, removeListener } }))
await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi
beforeEach(() => { invoke.mockReset(); on.mockClear(); removeListener.mockClear() })

describe('中短篇 preload', () => {
  it('保存位置读取和选择使用独立通道，取消结果保持原样', async () => {
    invoke.mockResolvedValueOnce('D:\\作品').mockResolvedValueOnce({ canceled: true })
    expect(await api.getShortStoryStorageLocation()).toBe('D:\\作品')
    expect(await api.chooseShortStoryStorageLocation()).toEqual({ canceled: true })
    expect(invoke.mock.calls).toEqual([['shortStory:getStorageLocation'], ['shortStory:chooseStorageLocation']])
  })

  it('同步其他窗口的保存位置，并在页面离开后移除监听', () => {
    const listener = vi.fn()
    const dispose = api.onShortStoryStorageLocationChanged(listener)
    const handler = on.mock.calls[0][1] as (event: unknown, path: unknown) => void
    handler(null, 'D:\\作品')
    handler(null, { invalid: true })
    expect(listener.mock.calls).toEqual([['D:\\作品']])
    dispose()
    expect(removeListener).toHaveBeenCalledWith('shortStory:storageLocationChanged', handler)
  })

  it('作品与导出通道可独立访问', async () => {
    await api.listShortStories()
    await api.getShortStory('story-id')
    await api.exportShortStory('story-id')
    await api.openShortStoryDirectory('story-id')
    expect(invoke.mock.calls).toEqual([
      ['shortStory:list'], ['shortStory:get', 'story-id'], ['shortStory:export', 'story-id'], ['shortStory:openDirectory', 'story-id']
    ])
  })

  it('流式事件只交给自己的请求，完成后移除监听且可取消', async () => {
    let finish!: (value: { ok: boolean }) => void
    invoke.mockImplementation((channel: string) => channel === 'shortStory:generate'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true }))
    const input = { task: 'outline', story: { id: 'story-id' } } as ShortStoryGenerationInput
    const token = vi.fn()
    const handle = api.generateShortStory(input, token)
    const callback = on.mock.calls[0][1] as (event: unknown, payload: { requestId: string; token: string; done: boolean }) => void
    callback(null, { requestId: 'different-request', token: '不应出现', done: false })
    callback(null, { requestId: handle.requestId, token: '本作大纲', done: false })
    expect(token.mock.calls).toEqual([['本作大纲', false]])
    await handle.abort()
    expect(invoke).toHaveBeenLastCalledWith('llm:abort', handle.requestId)
    finish({ ok: true })
    await handle
    expect(removeListener).toHaveBeenCalledWith('shortStory:token', callback)
  })

  it('不创建作品即可生成脑洞，候选结果与正文流隔离并可取消', async () => {
    let finish!: (value: ShortStoryBrainstormResult) => void
    invoke.mockImplementation((channel: string) => channel === 'shortStory:brainstorm'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true }))
    const input = { genre: '悬疑', direction: '失踪的账本', requirements: '', targetWords: 8000 }
    const token = vi.fn()
    const handle = api.brainstormShortStory(input, token)
    expect(invoke).toHaveBeenCalledWith('shortStory:brainstorm', { ...input, requestId: handle.requestId })
    const callback = on.mock.calls[0][1] as (event: unknown, payload: { requestId: string; token: string; done: boolean }) => void
    expect(on.mock.calls[0][0]).toBe('shortStory:brainstormToken')
    callback(null, { requestId: 'unrelated', token: '别的作品', done: false })
    callback(null, { requestId: handle.requestId, token: '新点子', done: false })
    expect(token.mock.calls).toEqual([['新点子', false]])
    await handle.abort()
    expect(invoke).toHaveBeenLastCalledWith('llm:abort', handle.requestId)
    const ideas = [{ title: '账本', premise: '找回记录', hook: '账本消失', twist: '账本在主角手中', ending: '真相公开' }]
    finish({ ok: true, ideas })
    expect(await handle).toEqual({ ok: true, ideas })
    expect(removeListener).toHaveBeenCalledWith('shortStory:brainstormToken', callback)
  })

  it('保留完整历史指纹和单方案改写条件，支持部分可用方案的提示', async () => {
    const idea = { title: '账本', premise: '找回记录', hook: '账本消失', twist: '账本在主角手中', ending: '真相公开' }
    const input: ShortStoryBrainstormInput = {
      genre: '悬疑', direction: '', requirements: '', targetWords: 8000,
      previousIdeas: [{ title: idea.title, premise: idea.premise }],
      rewrite: { idea, focus: 'ending', instruction: '用一次具体行动结束误会' }
    }
    const result: ShortStoryBrainstormResult = { ok: true, ideas: [idea], warning: '保留了一个有效方案' }
    invoke.mockResolvedValue(result)
    const handle = api.brainstormShortStory(input, vi.fn())
    expect(invoke).toHaveBeenCalledWith('shortStory:brainstorm', { ...input, requestId: handle.requestId })
    expect(await handle).toEqual(result)
    expect(removeListener).toHaveBeenCalledWith('shortStory:brainstormToken', on.mock.calls[0][1])
  })
})
