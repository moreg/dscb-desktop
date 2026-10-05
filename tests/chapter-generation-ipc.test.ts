import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteService } from '../src/main/data/write-service'
import type { AutoDeslopResult, ChapterStreamResult } from '../src/shared/types'
import { activeStreamCount, clearAllStreams } from '../src/main/data/stream-abort-registry'

type Handler = (event: { sender: object }, payload: unknown) => Promise<ChapterStreamResult>
const { handlers, send } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    })
  }
}))
const { registerWriteIpc } = await import('../src/main/ipc/write')

describe('正文生成 IPC 以精修最终稿交稿', () => {
  const generate = vi.fn<WriteService['generateChapterStream']>()
  const adjust = vi.fn<WriteService['adjustChapterStream']>()
  const repair = vi.fn<WriteService['repairChapterForeshadowings']>()
  const report: AutoDeslopResult = { status: 'applied', message: '已完成自动去 AI 味', remainingIssues: 0 }
  beforeEach(() => {
    handlers.clear()
    send.mockClear()
    clearAllStreams()
    generate.mockReset()
    adjust.mockReset()
    repair.mockReset().mockImplementation(async (_pid, _ch, content) => ({ content, report: { status: 'unchanged', message: '无遗漏' } }))
    registerWriteIpc({ generateChapterStream: generate, adjustChapterStream: adjust, repairChapterForeshadowings: repair } as unknown as WriteService)
  })

  it('续写返回润色片段、模式和报告，流式原稿只作预览', async () => {
    generate.mockImplementation(async (_project, _chapter, _style, opts) => {
      opts?.onGenerationStage?.('generating')
      opts?.onToken?.('原始预览')
      opts?.onGenerationStage?.('deslop')
      opts?.onAutoDeslopResult?.(report)
      opts?.onPromptMeta?.({ continueMode: 'extend', targetWords: 800, chapterTargetWords: 3000, writtenWords: 1000, fromOutline: true, bound: 'min' })
      return '最终精修片段'
    })
    const result = await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-1', existingText: '已有正文'
    })
    expect(result).toMatchObject({ ok: true, content: '最终精修片段', autoDeslop: report, continueMode: 'extend' })
    expect(send.mock.calls).toEqual([
      ['write:generationStage', { requestId: 'generation-1', stage: 'generating' }],
      ['llm:token', { requestId: 'generation-1', token: '原始预览', done: false }],
      ['write:generationStage', { requestId: 'generation-1', stage: 'deslop' }],
      ['llm:token', { requestId: 'generation-1', token: '', done: true }]
    ])
    expect(activeStreamCount()).toBe(0)
    expect(repair).toHaveBeenCalledWith('project-1', 1, '已有正文最终精修片段',
      expect.objectContaining({ partialChapter: true }))
  })

  it('完整伏笔检查和补写结束后才交稿，返回整章而不是重复拼接的增量', async () => {
    const events: string[] = []
    let finish!: () => void
    generate.mockImplementation(async (_pid, _ch, _style, opts) => {
      events.push('generated')
      opts?.onPromptMeta?.({ continueMode: 'finish', targetWords: 300, chapterTargetWords: 3000, writtenWords: 2800, fromOutline: true, bound: 'min' })
      return '本轮收尾。'
    })
    repair.mockImplementation(async (_pid, _ch, content, opts) => {
      expect(content).toBe('已有正文。\n本轮收尾。')
      opts?.onStart?.()
      events.push('checking')
      await new Promise<void>((resolve) => { finish = resolve })
      events.push('repaired')
      return { content: '已有正文。\n补入的伏笔。\n本轮收尾。', report: { status: 'applied', message: '已补写' } }
    })
    const pending = handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-repair', existingText: '已有正文。'
    })
    await vi.waitFor(() => expect(events).toEqual(['generated', 'checking']))
    expect(send).toHaveBeenCalledWith('write:generationStage', { requestId: 'generation-repair', stage: 'foreshadowRepair' })
    expect(send.mock.calls.some(([channel, payload]) => channel === 'llm:token' && payload.done)).toBe(false)
    expect(activeStreamCount()).toBe(1)
    finish()
    expect(await pending).toMatchObject({ ok: true, content: '本轮收尾。', fullContent: '已有正文。\n补入的伏笔。\n本轮收尾。',
      foreshadowRepair: { status: 'applied' } })
    expect(events).toEqual(['generated', 'checking', 'repaired'])
    expect(activeStreamCount()).toBe(0)
  })

  it('补写失败保留本轮生成片段，并将失败结论交给编辑器暂停记忆同步', async () => {
    generate.mockResolvedValue('已生成的新正文。')
    repair.mockResolvedValue({ content: '旧正文。\n已生成的新正文。', report: { status: 'failed', message: '补写未通过' } })
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-failed-repair', existingText: '旧正文。'
    })).toMatchObject({ ok: true, content: '已生成的新正文。', foreshadowRepair: { status: 'failed' } })
    expect(activeStreamCount()).toBe(0)
  })

  it('重写采用整章最终稿，润色失败报告仍以成功回包保留成稿', async () => {
    const failed: AutoDeslopResult = { status: 'failed', message: '自动去 AI 味失败，已保留生成原稿', remainingIssues: 0 }
    adjust.mockImplementation(async (_project, _chapter, _content, _instruction, _style, opts) => {
      opts?.onToken?.('重写流式成稿')
      opts?.onGenerationStage?.('deslop')
      opts?.onAutoDeslopResult?.(failed)
      return '保留的重写成稿'
    })
    expect(await handlers.get('write:adjustChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, content: '旧稿', instruction: '精修对白', requestId: 'adjust-1'
    })).toEqual({ ok: true, content: '保留的重写成稿', autoDeslop: failed })
    expect(send).toHaveBeenCalledWith('write:generationStage', { requestId: 'adjust-1', stage: 'deslop' })
    expect(activeStreamCount()).toBe(0)
  })

  it('生成失败不伪造成功稿，并释放可取消请求', async () => {
    generate.mockRejectedValue(new Error('LLM_ABORTED'))
    expect(await handlers.get('write:generateChapter')!({ sender: {} }, {
      projectId: 'project-1', chapterNumber: 1, requestId: 'generation-1'
    })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(activeStreamCount()).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
