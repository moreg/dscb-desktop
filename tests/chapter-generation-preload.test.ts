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

  it.each(['repairChapterForeshadowings', 'syncChapterAfterWrite'] as const)('%s 的进度按请求隔离，异常后清理监听', async method => {
    let fail!: (error: Error) => void
    invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const progress = vi.fn()
    const task = api[method]('project-1', 1, '正文', undefined, progress)
    const requestId = (invoke.mock.calls[0][1] as { requestId: string }).requestId
    expect(requestId).toBeTruthy()
    emit('write:postWriteProgress', { requestId: 'another-request', progress: { stage: 'outline' } })
    emit('write:postWriteProgress', { requestId, progress: { stage: 'review', round: 2 } })
    expect(progress.mock.calls).toEqual([[{ stage: 'review', round: 2 }]])
    const rejected = expect(task).rejects.toThrow('任务失败')
    fail(new Error('任务失败'))
    await rejected
    expect(listeners.get('write:postWriteProgress')?.size).toBe(0)
    emit('write:postWriteProgress', { requestId, progress: { stage: 'writeMemory' } })
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it('单章续写自动强度选项传入 IPC', async () => {
    invoke.mockResolvedValue({ ok: true, content: '正文' })
    await api.generateChapterStream('project-1', 1, null, undefined, undefined, vi.fn(), undefined, true)
    expect(invoke).toHaveBeenCalledWith('write:generateChapter', expect.objectContaining({ autoStrength: true }))
  })

  it('重试修复选项及原稿透传到 IPC，仍复用可取消的阶段事件', async () => {
    invoke.mockResolvedValue({ ok: true, fullContent: '修复后的正文。' })
    await api.generateChapterStream('project-1', 1, null, '保留章末', '原稿。', vi.fn(), vi.fn(), false, true)
    expect(invoke).toHaveBeenCalledWith('write:generateChapter', expect.objectContaining({
      repairOnly: true, existingText: '原稿。', tempContext: '保留章末'
    }))
    expect(listeners.get('write:generationStage')?.size).toBe(0)
  })

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

  it('转发伏笔补写阶段和最终整章结果，并支持补跑伏笔检查', async () => {
    const fullContent = '原段落。\n补入的伏笔。\n结尾。'
    const result = { ok: true, content: '结尾。', fullContent, foreshadowRepair: { status: 'applied', message: '已补写' } }
    invoke.mockResolvedValueOnce(result)
    const stage = vi.fn()
    const stream = api.generateChapterStream('project-1', 1, null, undefined, '原段落。', vi.fn(), stage)
    emit('write:generationStage', { requestId: stream.requestId, stage: 'foreshadowRepair' })
    expect(await stream).toEqual(result)
    expect(stage).toHaveBeenCalledWith('foreshadowRepair')
    invoke.mockResolvedValueOnce({ content: fullContent, report: result.foreshadowRepair })
    await api.repairChapterForeshadowings('project-1', 1, fullContent, { partialChapter: true })
    expect(invoke.mock.calls[1]).toEqual(['write:repairChapterForeshadowings', {
      projectId: 'project-1', chapterNumber: 1, content: fullContent, partialChapter: true
    }])
  })
})
