import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteService } from '../src/main/data/write-service'
import { activeBatchProjects } from '../src/main/data/write-batch-lock'
import { abortStream, activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'

type Sender = EventEmitter & { isDestroyed: () => boolean }
type Handler = (event: { sender: Sender }, payload: unknown) => Promise<{ ok: boolean; error?: string }>
const { handlers, send } = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), send: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: (sender: Sender) => ({ isDestroyed: sender.isDestroyed,
    webContents: { isDestroyed: sender.isDestroyed, send } }) }
}))
const { registerWriteIpc } = await import('../src/main/ipc/write')
const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false })
const reply = { ok: true, results: [] }

describe('全书概要批量 IPC', () => {
  const regenerate = vi.fn<WriteService['regenerateSummariesBatch']>()
  let source: Sender
  function invoke(overrides = {}, channel = 'write:regenerateSummariesBatch') {
    return handlers.get(channel)!({ sender: source }, {
      projectId: 'project', requestId: 'summary-run', fromChapter: 1, toChapter: 500, onlyMissing: false, ...overrides
    })
  }
  beforeEach(() => {
    handlers.clear(); send.mockClear(); clearAllStreams(); activeBatchProjects.clear()
    regenerate.mockReset().mockResolvedValue(reply)
    source = sender()
    registerWriteIpc({ regenerateSummariesBatch: regenerate } as unknown as WriteService)
  })
  it('全书范围不限100章，非法输入不会启动模型任务', async () => {
    for (const invalid of [{ fromChapter: 0 }, { fromChapter: 501 }, { toChapter: 1.5 },
      { toChapter: Number.MAX_SAFE_INTEGER + 1 }, { onlyMissing: 'yes' }, { requestId: '' },
      { completed: [{ chapterNumber: 1, sourceHash: 'fake' }] }]) {
      expect((await invoke(invalid)).error).toContain('IPC_INPUT_INVALID')
    }
    expect(regenerate).not.toHaveBeenCalled()
    expect((await invoke()).ok).toBe(true)
  })
  it('按requestId推送实时进度与逐章结果，结束后清理监听与锁', async () => {
    regenerate.mockImplementationOnce(async (_id, _options, onChapter, opts) => {
      opts?.onProgress?.({ chapter: 201, index: 2, total: 3 })
      onChapter({ chapterNumber: 201, status: 'generated', continuityCount: 2 })
      return reply
    })
    await invoke()
    expect(send.mock.calls).toEqual([
      ['write:batchSummaryProgress', { requestId: 'summary-run', progress: { chapter: 201, index: 2, total: 3 } }],
      ['write:batchSummaryChapterComplete', { requestId: 'summary-run', result: { chapterNumber: 201, status: 'generated', continuityCount: 2 } }]
    ])
    expect(activeStreamCount()).toBe(0)
    expect(activeBatchProjects.size).toBe(0)
    expect(source.listenerCount('destroyed')).toBe(0)
  })
  it('与写作/精修共用锁，停止或关闭窗口中断请求，失败也释放锁', async () => {
    let finish!: (value: typeof reply) => void
    regenerate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const task = invoke()
    const signal = regenerate.mock.calls[0][3]!.signal!
    expect((await invoke({ requestId: 'another' })).error).toContain('BATCH_ALREADY_RUNNING')
    expect((await invoke({ requestId: 'another', toChapter: 10 }, 'write:polishChaptersBatch')).error).toContain('BATCH_ALREADY_RUNNING')
    abortStream('summary-run')
    expect(signal.aborted).toBe(true)
    finish(reply); await task
    regenerate.mockRejectedValueOnce(new Error('服务失败'))
    expect((await invoke()).error).toBe('服务失败')
    expect(activeStreamCount()).toBe(0)
    expect(activeBatchProjects.size).toBe(0)
    regenerate.mockImplementationOnce(async (_id, _options, _onChapter, opts) => {
      source.emit('destroyed')
      expect(opts?.signal?.aborted).toBe(true)
      return reply
    })
    expect((await invoke()).ok).toBe(true)
    expect(source.listenerCount('destroyed')).toBe(0)
  })
})
