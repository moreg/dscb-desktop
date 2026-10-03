import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteService } from '../src/main/data/write-service'
import type { SavedChapterPolishResult } from '../src/shared/types'
import { abortStream, activeStreamCount, clearAllStreams, pendingAbortCount } from '../src/main/data/stream-abort-registry'

type Sender = EventEmitter & { isDestroyed: () => boolean }
type Reply = { ok: boolean; results?: SavedChapterPolishResult[]; error?: string }
type Handler = (event: { sender: Sender }, payload: unknown) => Promise<Reply>
const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), send: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: (sender: Sender) => ({ isDestroyed: sender.isDestroyed,
    webContents: { isDestroyed: sender.isDestroyed, send } }) }
}))
const { registerWriteIpc } = await import('../src/main/ipc/write')
const chapterResult: SavedChapterPolishResult = {
  chapterNumber: 1, changed: true,
  autoDeslop: { status: 'applied', message: '事实核验通过，精修已保存', remainingIssues: 0 }
}
const reply = { ok: true, results: [chapterResult] }
const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false })

describe('已有正文批量精修 IPC', () => {
  const polish = vi.fn<WriteService['polishChaptersBatch']>()
  const generate = vi.fn<WriteService['generateChaptersBatch']>()
  let source: Sender
  function invoke(overrides: Record<string, unknown> = {}, channel = 'write:polishChaptersBatch', eventSender = source) {
    return handlers.get(channel)!({ sender: eventSender }, {
      projectId: 'project-1', fromChapter: 1, toChapter: 10, requestId: 'polish-1', ...overrides
    })
  }
  beforeEach(() => {
    handlers.clear()
    send.mockClear()
    clearAllStreams()
    source = sender()
    polish.mockReset().mockResolvedValue(reply)
    generate.mockReset()
    registerWriteIpc({ polishChaptersBatch: polish, generateChaptersBatch: generate } as unknown as WriteService)
  })

  it('范围、请求和文风均经过验证，拒绝非法输入不启动任务', async () => {
    for (const overrides of [{ fromChapter: 0 }, { fromChapter: 2, toChapter: 1 }, { toChapter: 101 },
      { toChapter: Number.MAX_SAFE_INTEGER + 1 }, { projectId: '' }, { requestId: '' }, { styleProfileId: '' }]) {
      expect((await invoke(overrides)).error).toContain('IPC_INPUT_INVALID')
    }
    expect(polish).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
    expect((await invoke({ toChapter: 100 })).ok).toBe(true)
  })

  it('向进度与完成事件携带 requestId，最终回复保留每章结论', async () => {
    polish.mockImplementation(async (_project, _from, _to, _style, onChapter, opts) => {
      opts?.onProgress?.(1, 'deslop')
      opts?.onProgress?.(1, 'summary')
      onChapter(1, chapterResult)
      return reply
    })
    expect(await invoke({ styleProfileId: 'chosen' })).toEqual(reply)
    expect(polish.mock.calls[0].slice(0, 4)).toEqual(['project-1', 1, 10, 'chosen'])
    expect(send.mock.calls).toEqual([
      ['write:batchPolishProgress', { requestId: 'polish-1', chapter: 1, step: 'deslop' }],
      ['write:batchPolishProgress', { requestId: 'polish-1', chapter: 1, step: 'summary' }],
      ['write:batchPolishChapterComplete', { requestId: 'polish-1', chapter: 1, result: chapterResult }]
    ])
    expect(activeStreamCount()).toBe(0)
    expect(source.listenerCount('destroyed')).toBe(0)
    expect(generate).not.toHaveBeenCalled()
  })

  it.each(['write:polishChaptersBatch', 'write:generateBatch'])('正在精修时 %s 共享项目锁与请求锁', async (channel) => {
    let finish!: (value: typeof reply) => void
    polish.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const task = invoke()
    const signal = polish.mock.calls[0][5]?.signal
    expect((await invoke({ requestId: 'polish-2' }, channel, sender())).error).toContain('BATCH_ALREADY_RUNNING')
    expect((await invoke({ projectId: 'project-2' }, channel, sender())).error).toContain('BATCH_REQUEST_ALREADY_RUNNING')
    expect(signal?.aborted).toBe(false)
    finish(reply)
    await task
    expect((await invoke()).ok).toBe(true)
  })

  it('写作正在运行时精修也不能启动，等待同项目任务结束', async () => {
    let finish!: (value: never) => void
    generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const task = invoke({}, 'write:generateBatch')
    expect((await invoke({ requestId: 'polish-2' })).error).toContain('BATCH_ALREADY_RUNNING')
    expect(polish).not.toHaveBeenCalled()
    finish({ status: 'completed', completed: [] } as never)
    await task
    expect((await invoke()).ok).toBe(true)
  })

  it('运行异常时清理流、窗口监听与锁，后续可再运行', async () => {
    polish.mockRejectedValueOnce(new Error('服务异常'))
    expect(await invoke()).toEqual({ ok: false, error: '服务异常' })
    expect(activeStreamCount()).toBe(0)
    expect(source.listenerCount('destroyed')).toBe(0)
    expect((await invoke()).ok).toBe(true)
  })

  it('关闭发起窗口或用户停止均中断 signal，预先取消也不丢失', async () => {
    let finish!: (value: typeof reply) => void
    polish.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const task = invoke()
    const signal = polish.mock.calls[0][5]?.signal
    sender().emit('destroyed')
    expect(signal?.aborted).toBe(false)
    source.emit('destroyed')
    expect(signal?.aborted).toBe(true)
    finish(reply)
    await task
    abortStream('polish-1')
    await invoke()
    expect(polish.mock.calls[1][5]?.signal?.aborted).toBe(true)
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
    expect(source.listenerCount('destroyed')).toBe(0)
  })
})
