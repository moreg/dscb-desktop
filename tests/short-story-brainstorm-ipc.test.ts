import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import type { ShortStoryBrainstormInput, ShortStoryIdea } from '../src/shared/short-story'
import { abortStream, activeStreamCount, clearAllStreams, pendingAbortCount } from '../src/main/data/stream-abort-registry'

const { handlers, send, writeJsonAtomic, writeTextAtomic } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(), writeJsonAtomic: vi.fn(), writeTextAtomic: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }) }
}))
vi.mock('../src/main/data/atomic', () => ({ writeJsonAtomic, writeTextAtomic }))
const { registerShortStoryBrainstormIpc } = await import('../src/main/ipc/short-story-brainstorm')

const requestId = '7b186965-dacb-4e52-9bf4-476cc87a6502'
const input: ShortStoryBrainstormInput = { genre: '悬疑', direction: '寻找失踪的账本', requirements: '', targetWords: 8000 }
const ideas: ShortStoryIdea[] = [1, 2, 3].map(index => ({
  title: `账本的第${index}页`, premise: `第${index}页指向不同人物的秘密。`, hook: '收到一个没有封面的账本。',
  twist: '页码的字迹提前暗示有人调换了账本。', ending: '找回原账本并偿还欠债，误会得到解决。'
}))
const output = JSON.stringify({ ideas })
const event = (destroyed = false) => ({ sender: Object.assign(new EventEmitter(), { isDestroyed: () => destroyed }) })

describe('短篇脑洞 IPC', () => {
  let generateStream: ReturnType<typeof vi.fn>
  beforeEach(() => {
    handlers.clear()
    clearAllStreams()
    vi.clearAllMocks()
    generateStream = vi.fn(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.(output)
      return output
    })
    registerShortStoryBrainstormIpc({ generateStream } as unknown as LlmService)
  })

  it('独立生成三个方案，使用大纲模型并按请求推送原文，不写盘', async () => {
    const e = event()
    expect(await handlers.get('shortStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: true, ideas })
    expect(generateStream.mock.calls[0][1]).toMatchObject({ meta: { feature: 'outline-generate' }, maxTokens: 8192, systemPrompt: expect.stringContaining('短篇') })
    expect(send.mock.calls).toEqual([
      ['shortStory:brainstormToken', { requestId, token: output, done: false }],
      ['shortStory:brainstormToken', { requestId, token: '', done: true }]
    ])
    expect(writeJsonAtomic).not.toHaveBeenCalled()
    expect(writeTextAtomic).not.toHaveBeenCalled()
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('提前取消或窗口已销毁时跳过模型，清理流与关闭监听', async () => {
    abortStream(requestId)
    for (const e of [event(), event(true)]) {
      expect(await handlers.get('shortStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
      expect(e.sender.listenerCount('destroyed')).toBe(0)
      expect(activeStreamCount()).toBe(0)
      expect(pendingAbortCount()).toBe(0)
    }
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('生成过程中取消保留已推送的原文并停止后续 token', async () => {
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('已收到的脑洞片段')
      abortStream(requestId)
      expect(opts.signal?.aborted).toBe(true)
      opts.onToken?.('取消后不应推送')
      return output
    })
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(send.mock.calls.map(call => call[1].token)).toEqual(['已收到的脑洞片段', ''])
    expect(activeStreamCount()).toBe(0)
  })

  it('关窗中止底层模型请求且清理监听与登记', async () => {
    const e = event()
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      e.sender.emit('destroyed')
      expect(opts.signal?.aborted).toBe(true)
      throw new Error('网络连接已取消')
    })
    expect(await handlers.get('shortStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
  })

  it('无 token 回调仍交付原始文本；解析失败可恢复原文', async () => {
    generateStream.mockResolvedValueOnce(output).mockResolvedValueOnce('模型未遵守 JSON：这是一个可保留的脑洞。')
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: true, ideas })
    expect(send).toHaveBeenCalledWith('shortStory:brainstormToken', { requestId, token: output, done: false })
    send.mockClear()
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toMatchObject({ ok: false, error: expect.stringContaining('原始内容仍保留') })
    expect(send.mock.calls.map(call => call[1].token)).toEqual(['模型未遵守 JSON：这是一个可保留的脑洞。', ''])
  })

  it('空结果或模型错误返回失败结果并结束流', async () => {
    generateStream.mockResolvedValueOnce('  ').mockRejectedValueOnce(new Error('没有配置大纲模型'))
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toMatchObject({ ok: false, error: expect.stringContaining('未返回脑洞') })
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: false, error: '没有配置大纲模型' })
    expect(activeStreamCount()).toBe(0)
    expect(send.mock.calls.every(call => call[1].done)).toBe(true)
  })

  it('普通生成过滤跨批重复和坏项，仍交付可用脑洞并带 warning', async () => {
    generateStream.mockResolvedValue(JSON.stringify({ ideas: [ideas[0], { ...ideas[1], ending: '' }, ideas[2]] }))
    const result = await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId, previousIdeas: [{ title: ideas[0].title, premise: ideas[0].premise }] })
    expect(result).toMatchObject({ ok: true, ideas: [ideas[2]], warning: expect.stringContaining('保留 1 个') })
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(activeStreamCount()).toBe(0)
  })

  it('模型返回截断批次时保留完整方案和原文，不自动重试', async () => {
    const truncated = `{"ideas":[${JSON.stringify(ideas[0])},${JSON.stringify(ideas[1])},{"title":"第三项截断`
    generateStream.mockResolvedValue(truncated)
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId })).toEqual({
      ok: true, ideas: ideas.slice(0, 2), warning: expect.stringContaining('输出被截断')
    })
    expect(send).toHaveBeenCalledWith('shortStory:brainstormToken', { requestId, token: truncated, done: false })
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(activeStreamCount()).toBe(0)
  })

  it('改写允许沿用历史标题和设定，但后端锁住不允许改的字段', async () => {
    const rewritten = { ...ideas[0], title: '模型乱改标题', premise: '模型乱改设定', hook: '模型乱改开篇', twist: '新反转有更早的邮戳铺垫。', ending: '模型乱改结局' }
    generateStream.mockResolvedValue(JSON.stringify({ ideas: [rewritten] }))
    const result = await handlers.get('shortStory:brainstorm')!(event(), {
      ...input, requestId, previousIdeas: [{ title: ideas[0].title, premise: ideas[0].premise }],
      rewrite: { idea: ideas[0], focus: 'twist', instruction: '' }
    })
    expect(result).toEqual({ ok: true, ideas: [{ ...ideas[0], twist: rewritten.twist }] })
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(writeTextAtomic).not.toHaveBeenCalled()
  })

  it('改写只接受一个完整方案，未变化结果失败且不自动额外调用模型', async () => {
    const rewrite = { idea: ideas[0], focus: 'ending', instruction: '' }
    generateStream.mockResolvedValueOnce(JSON.stringify({ ideas: [ideas[0]] })).mockResolvedValueOnce(output)
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId, rewrite })).toMatchObject({ ok: false, error: expect.stringContaining('没有改变') })
    expect(await handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId, rewrite })).toMatchObject({ ok: false, error: expect.stringContaining('需要 1 个') })
    expect(generateStream).toHaveBeenCalledTimes(2)
  })

  it.each([{ requestId: '../invalid' }, { targetWords: 999 }, { direction: 1 }, { excludedIdeas: Array(31).fill('脑洞') }, { variationSeed: 'x'.repeat(101) }])('非法输入在调用模型前拒绝 %j', async invalid => {
    await expect(handlers.get('shortStory:brainstorm')!(event(), { ...input, requestId, ...invalid })).rejects.toThrow('IPC_INPUT_INVALID')
    expect(generateStream).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
