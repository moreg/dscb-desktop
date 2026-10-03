import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteService } from '../src/main/data/write-service'
import type { BatchProgress, ChapterFlowResult } from '../src/shared/types'
import {
  abortStream,
  activeStreamCount,
  clearAllStreams,
  pendingAbortCount
} from '../src/main/data/stream-abort-registry'

type BatchReply = { ok: boolean; progress?: BatchProgress; error?: string }
type Sender = EventEmitter & { isDestroyed: () => boolean }
type Handler = (event: { sender: Sender }, payload: unknown) => Promise<BatchReply>
const { handlers, send } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: {
    fromWebContents: (sender: Sender) => ({
      isDestroyed: sender.isDestroyed,
      webContents: { isDestroyed: sender.isDestroyed, send }
    })
  }
}))

const { registerWriteIpc } = await import('../src/main/ipc/write')
const channels = ['write:generateBatch', 'write:resumeBatch'] as const
const progress: BatchProgress = {
  total: 10, current: 1, currentChapter: 1,
  fromChapter: 1, toChapter: 10, status: 'paused', completed: [1]
}

function makeSender(): Sender {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false })
}

describe('批量 IPC 的范围、并发和取消边界', () => {
  const generate = vi.fn<WriteService['generateChaptersBatch']>()
  const resume = vi.fn<WriteService['resumeChaptersBatch']>()
  let sender: Sender

  const invoke = (channel: string, overrides: Record<string, unknown> = {}, eventSender = sender) =>
    handlers.get(channel)!({ sender: eventSender }, {
      projectId: 'project-1', fromChapter: 1, toChapter: 10, requestId: 'batch-1', ...overrides
    })

  beforeEach(() => {
    handlers.clear()
    send.mockClear()
    clearAllStreams()
    generate.mockReset().mockResolvedValue(progress)
    resume.mockReset().mockResolvedValue(progress)
    sender = makeSender()
    registerWriteIpc({ generateChaptersBatch: generate, resumeChaptersBatch: resume } as unknown as WriteService)
  })

  it.each(channels)('%s 拒绝非法范围和伪造进度，且不开始写作', async (channel) => {
    for (const input of [
      { fromChapter: 0 },
      { fromChapter: 2, toChapter: 1 },
      { toChapter: 101 },
      { toChapter: Number.MAX_SAFE_INTEGER + 1 },
      { batchState: { fromChapter: 1, total: 5, completed: [1] } },
      { batchState: { fromChapter: 1, total: 10, completed: [11] } },
      { batchState: { fromChapter: 1, total: 10, completed: [], pendingPostProcessChapter: 1 } }
    ]) {
      const result = await invoke(channel, input)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('IPC_INPUT_INVALID')
    }
    expect(generate).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it.each(channels)('%s 接受上限、单章和最后一章后处理恢复', async (channel) => {
    expect((await invoke(channel, { toChapter: 100 })).ok).toBe(true)
    expect((await invoke(channel, { fromChapter: 10, toChapter: 10 })).ok).toBe(true)
    const batchState = {
      fromChapter: 1, total: 10, completed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pendingPostProcessChapter: 10
    }
    expect((await invoke(channel, { fromChapter: 10, batchState })).ok).toBe(true)
    const mock = channel === channels[0] ? generate : resume
    expect(mock.mock.calls.at(-1)?.[6]).toEqual(batchState)
  })

  it.each(channels)('%s 向事件携带 requestId 并完整透传运行选项', async (channel) => {
    const mock = channel === channels[0] ? generate : resume
    const chapterResult = { chapterNumber: 1, content: '正文' } as ChapterFlowResult
    mock.mockImplementation(async (_project, _from, _to, onChapter, _style, opts, _state, _run, onRetry) => {
      opts?.onToken?.('测试正文')
      opts?.onGenerationStage?.('deslop', 1)
      opts?.onAutoDeslopResult?.({ status: 'applied', message: '已精修', remainingIssues: 0 }, 1)
      onChapter(1, chapterResult)
      onRetry?.(2, 1, 3, 30_000)
      return progress
    })
    expect(await invoke(channel, { autoContinue: true, autoStrength: true, styleProfileId: 'style-1' }))
      .toEqual({ ok: true, progress })
    expect(mock.mock.calls[0][4]).toBe('style-1')
    expect(mock.mock.calls[0][7]).toEqual({ autoContinue: true, autoStrength: true })
    expect(send.mock.calls).toEqual([
      ['llm:token', { requestId: 'batch-1', token: '测试正文', done: false }],
      ['write:batchGenerationStage', { requestId: 'batch-1', chapterNumber: 1, stage: 'deslop' }],
      ['write:batchAutoDeslopResult', { requestId: 'batch-1', chapterNumber: 1, result: { status: 'applied', message: '已精修', remainingIssues: 0 } }],
      ['write:batchChapterComplete', { requestId: 'batch-1', chapter: 1, result: chapterResult }],
      ['write:batchRetryWait', { requestId: 'batch-1', chapter: 2, attempt: 1, maxAttempts: 3, waitMs: 30_000 }],
      ['llm:token', { requestId: 'batch-1', token: '', done: true }]
    ])
    expect(activeStreamCount()).toBe(0)
    expect(sender.listenerCount('destroyed')).toBe(0)
  })

  it('跨窗口 generate/resume 共享项目锁，另一项目可独立运行', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = invoke(channels[0])
    const firstSignal = generate.mock.calls[0][5]?.signal
    const duplicate = await invoke(channels[1], { requestId: 'batch-2' }, makeSender())
    expect(duplicate.error).toContain('BATCH_ALREADY_RUNNING')
    expect(resume).not.toHaveBeenCalled()
    expect(firstSignal?.aborted).toBe(false)
    expect((await invoke(channels[1], { projectId: 'project-2', requestId: 'batch-2' })).ok).toBe(true)
    finish(progress)
    await first
    expect((await invoke(channels[1], { requestId: 'batch-3' })).ok).toBe(true)
  })

  it('重复 requestId 不会取消另一项目正在运行的批次', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = invoke(channels[0])
    const signal = generate.mock.calls[0][5]?.signal
    expect((await invoke(channels[1], { projectId: 'project-2' })).error)
      .toContain('BATCH_REQUEST_ALREADY_RUNNING')
    expect(signal?.aborted).toBe(false)
    finish(progress)
    await first
  })

  it.each(channels)('%s 异常时释放锁、流与窗口监听，可再次运行', async (channel) => {
    const mock = channel === channels[0] ? generate : resume
    mock.mockRejectedValueOnce(new Error('测试异常'))
    expect(await invoke(channel)).toEqual({ ok: false, error: '测试异常' })
    expect(activeStreamCount()).toBe(0)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect((await invoke(channel)).ok).toBe(true)
  })

  it('用户取消和关闭发起窗口都能中止当前任务，关闭其他窗口不会干扰', async () => {
    let finish!: (value: BatchProgress) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = invoke(channels[0])
    const signal = generate.mock.calls[0][5]?.signal
    makeSender().emit('destroyed')
    expect(signal?.aborted).toBe(false)
    sender.emit('destroyed')
    expect(signal?.aborted).toBe(true)
    finish(progress)
    await first
    expect(sender.listenerCount('destroyed')).toBe(0)

    const second = invoke(channels[0], { requestId: 'batch-2' })
    abortStream('batch-2')
    expect(generate.mock.calls[1][5]?.signal?.aborted).toBe(true)
    finish(progress)
    await second
    expect(activeStreamCount()).toBe(0)
  })

  it('开始之前取消会透传已取消信号，结束后清理 pending abort', async () => {
    abortStream('batch-1')
    await invoke(channels[0])
    expect(generate.mock.calls[0][5]?.signal?.aborted).toBe(true)
    expect(pendingAbortCount()).toBe(0)
  })
})
