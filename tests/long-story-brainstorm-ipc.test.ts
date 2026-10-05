import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmService, type GenerateOptions } from '../src/main/data/llm-service'
import type { SecretStore } from '../src/main/data/secret-store'
import type { LongStoryBrainstormInput, LongStoryIdea } from '../src/shared/long-story-brainstorm'
import { abortStream, activeStreamCount, clearAllStreams, pendingAbortCount } from '../src/main/data/stream-abort-registry'

const { handlers, send } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(), send: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }) }
}))
const { registerLongStoryBrainstormIpc } = await import('../src/main/ipc/long-story-brainstorm')

const requestId = '7b186965-dacb-4e52-9bf4-476cc87a6502'
const input: LongStoryBrainstormInput = { genre: '玄幻', direction: '一个没有灵根的土地神', requirements: '', targetChapters: 300 }
const ideas: LongStoryIdea[] = [1, 2, 3].map(index => ({
  title: `神庙的第${index}份账本`, premise: `第${index}份账本引出不同村落的百年旧债。`, hook: '债主要求主角偿还一场雨。',
  mainLine: '重建村落自治，打破宗门对神力契约的垄断。', progression: '从一村水渠到多村互助，再到整个流域，神力增长依赖居民信任。',
  twist: '最早的无息账目证明旧债其实是互助金，宗门伪造了历史。', ending: '主角归还神权并失去神位，乡民取得管理水利的权利。'
}))
const output = JSON.stringify({ ideas })
const event = (destroyed = false) => ({ sender: Object.assign(new EventEmitter(), { isDestroyed: () => destroyed }) })

describe('长篇脑洞 IPC', () => {
  let generateStream: ReturnType<typeof vi.fn>
  beforeEach(() => {
    handlers.clear()
    clearAllStreams()
    vi.clearAllMocks()
    generateStream = vi.fn(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.(output)
      return output
    })
    registerLongStoryBrainstormIpc({ generateStream } as unknown as LlmService)
  })

  it('调用大纲模型流式生成长篇脑洞并发送原文和完成事件', async () => {
    const e = event()
    expect(await handlers.get('longStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: true, ideas })
    expect(generateStream.mock.calls[0][1]).toMatchObject({ meta: { feature: 'outline-generate' }, maxTokens: 8192, systemPrompt: expect.stringContaining('长篇') })
    expect(send.mock.calls).toEqual([
      ['longStory:brainstormToken', { requestId, token: output, done: false }],
      ['longStory:brainstormToken', { requestId, token: '', done: true }]
    ])
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('未指定章数也允许生成', async () => {
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, targetChapters: undefined, requestId })).toEqual({ ok: true, ideas })
    expect(generateStream.mock.calls[0][0]).toContain('未指定')
  })

  it('提前取消或窗口已销毁时跳过模型，并清理登记和监听', async () => {
    abortStream(requestId)
    for (const e of [event(), event(true)]) {
      expect(await handlers.get('longStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
      expect(e.sender.listenerCount('destroyed')).toBe(0)
      expect(activeStreamCount()).toBe(0)
      expect(pendingAbortCount()).toBe(0)
    }
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('生成中取消保留已推送原文，阻止迟到 token', async () => {
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('已经收到的长篇主线')
      abortStream(requestId)
      expect(opts.signal?.aborted).toBe(true)
      opts.onToken?.('取消后不应推送')
      return output
    })
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(send.mock.calls.map(call => call[1].token)).toEqual(['已经收到的长篇主线', ''])
    expect(activeStreamCount()).toBe(0)
  })

  it('关窗中止模型请求并清理关闭监听', async () => {
    const e = event()
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      e.sender.emit('destroyed')
      expect(opts.signal?.aborted).toBe(true)
      throw new Error('连接已取消')
    })
    expect(await handlers.get('longStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
  })

  it('模型没有 token 回调也推送原文，解析错误不丢弃返回内容', async () => {
    generateStream.mockResolvedValueOnce(output).mockResolvedValueOnce('可保留的主线素材，但没有 JSON')
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: true, ideas })
    expect(send).toHaveBeenCalledWith('longStory:brainstormToken', { requestId, token: output, done: false })
    send.mockClear()
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toMatchObject({ ok: false, error: expect.stringContaining('原始内容仍保留') })
    expect(send.mock.calls.map(call => call[1].token)).toEqual(['可保留的主线素材，但没有 JSON', ''])
    expect(activeStreamCount()).toBe(0)
  })

  it('模型在已推送部分原文后失败仍保留原文并结束流', async () => {
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('尚未完成的长篇构思')
      throw new Error('网络中断')
    })
    const e = event()
    expect(await handlers.get('longStory:brainstorm')!(e, { ...input, requestId })).toEqual({ ok: false, error: '网络中断' })
    expect(send.mock.calls.map(call => call[1].token)).toEqual(['尚未完成的长篇构思', ''])
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('过滤历史重复和损坏项仍交付完整候选，只调用模型一次', async () => {
    generateStream.mockResolvedValue(JSON.stringify({ ideas: [ideas[0], { ...ideas[1], mainLine: '' }, ideas[2]] }))
    const result = await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId, previousIdeas: [{ title: ideas[0].title, premise: ideas[0].premise }] })
    expect(result).toMatchObject({ ok: true, ideas: [ideas[2]], warning: expect.stringContaining('保留 1 个') })
    expect(generateStream.mock.calls[0][0]).toContain(ideas[0].premise)
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('截断批次保留前两个完整脑洞，零个候选时返回失败', async () => {
    const truncated = `{"ideas":[${JSON.stringify(ideas[0])},${JSON.stringify(ideas[1])},{"title":"截断`
    generateStream.mockResolvedValueOnce(truncated).mockResolvedValueOnce('{"ideas":[{"title":"只返回标题"}]}')
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: true, ideas: ideas.slice(0, 2), warning: expect.stringContaining('输出被截断') })
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toMatchObject({ ok: false, error: expect.stringContaining('格式不完整') })
    expect(activeStreamCount()).toBe(0)
  })

  it('真实 LlmService 在 length 结束时抛错，IPC 仍恢复已经完整到达的候选', async () => {
    const truncated = `{"ideas":[${JSON.stringify(ideas[0])},${JSON.stringify(ideas[1])},{"title":"截断`
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: truncated }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() } })
    } as Response)
    const secret = { read: async () => ({ activeId: 'regression', providers: [{
      id: 'regression', label: 'regression', baseUrl: 'https://api.example.com/v1', model: 'regression-model', apiKey: 'regression-fake-credential'
    }] }) } as unknown as SecretStore
    registerLongStoryBrainstormIpc(new LlmService(secret))
    try {
      const result = await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })
      expect(result).toMatchObject({ ok: true, ideas: ideas.slice(0, 2), warning: expect.stringContaining('输出被截断') })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(send.mock.calls.map(call => call[1].token)).toEqual([truncated, ''])
      expect(send.mock.calls.at(-1)?.[1].done).toBe(true)
      expect(activeStreamCount()).toBe(0)
    } finally { fetchSpy.mockRestore() }
  })

  it.each(['LLM_OUTPUT_TRUNCATED', 'LLM_TIMEOUT'])('流中断错误 %s 仍按历史去重，所有候选重复则失败且不会额外调用模型', async error => {
    const truncated = `{"ideas":[${JSON.stringify(ideas[0])},${JSON.stringify(ideas[1])},{"title":"截断`
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.(truncated)
      throw new Error(error)
    })
    const handler = handlers.get('longStory:brainstorm')!
    expect(await handler(event(), { ...input, requestId, previousIdeas: [ideas[0]] })).toMatchObject({
      ok: true, ideas: [ideas[1]], warning: expect.stringContaining('历史重复方案')
    })
    expect(await handler(event(), { ...input, requestId, previousIdeas: ideas })).toEqual({ ok: false, error })
    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(activeStreamCount()).toBe(0)
  })

  it('超时前没有完整候选时保持超时失败；超长流不通过裁剪冒充有效恢复', async () => {
    generateStream.mockImplementationOnce(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('{"ideas":[{"title":"还没返回完整设定"')
      throw new Error('LLM_TIMEOUT')
    }).mockImplementationOnce(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.(output + ' '.repeat(100001))
      throw new Error('LLM_OUTPUT_TRUNCATED')
    })
    const handler = handlers.get('longStory:brainstorm')!
    expect(await handler(event(), { ...input, requestId })).toEqual({ ok: false, error: 'LLM_TIMEOUT' })
    expect(await handler(event(), { ...input, requestId })).toEqual({ ok: false, error: 'LLM_OUTPUT_TRUNCATED' })
    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(activeStreamCount()).toBe(0)
  })

  it('取消与截断同时发生时取消优先，即使原文已有完整方案也不恢复成成功', async () => {
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.(output)
      abortStream(requestId)
      throw new Error('LLM_OUTPUT_TRUNCATED')
    })
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(send.mock.calls.map(call => call[1].token)).toEqual([output, ''])
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
  })

  it('模型完成和取消相遇时先检查取消状态，结束后拒绝迟到 token', async () => {
    let complete!: (value: string) => void
    let onToken: GenerateOptions['onToken']
    generateStream.mockImplementation((_prompt: string, opts: GenerateOptions) => {
      onToken = opts.onToken
      return new Promise<string>(resolve => { complete = resolve })
    })
    const e = event()
    const pending = handlers.get('longStory:brainstorm')!(e, { ...input, requestId })
    complete(output)
    abortStream(requestId)
    expect(await pending).toEqual({ ok: false, error: 'LLM_ABORTED' })
    onToken?.('完成后的迟到片段')
    expect(send.mock.calls.map(call => call[1].token)).toEqual([''])
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('正常完成后到达的 token 不会跟在 done 事件之后继续推送', async () => {
    let onToken: GenerateOptions['onToken']
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => { onToken = opts.onToken; return output })
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: true, ideas })
    onToken?.('迟到片段')
    expect(send.mock.calls.map(call => call[1].token)).toEqual([output, ''])
    expect(send.mock.calls.filter(call => call[1].done)).toHaveLength(1)
  })

  it('空返回与未配置模型返回失败并发送完成事件', async () => {
    generateStream.mockResolvedValueOnce('  ').mockRejectedValueOnce(new Error('没有配置大纲模型'))
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toMatchObject({ ok: false, error: expect.stringContaining('未返回脑洞') })
    expect(await handlers.get('longStory:brainstorm')!(event(), { ...input, requestId })).toEqual({ ok: false, error: '没有配置大纲模型' })
    expect(send.mock.calls.every(call => call[1].done)).toBe(true)
    expect(activeStreamCount()).toBe(0)
  })

  it.each([
    { requestId: '../invalid' }, { targetChapters: 0 }, { targetChapters: 100001 }, { direction: 1 },
    { previousIdeas: Array(31).fill({ title: '标题', premise: '设定' }) }, { variationSeed: 'x'.repeat(101) },
    { previousIdeas: [{ title: '  ', premise: '设定' }] }, { previousIdeas: [{ title: '标题', premise: 1 }] },
    { sourceBrief: '简'.repeat(10001) }, { targetChapters: null }, { requirements: ['违规类型'] }
  ].map(invalid => ({ label: Object.keys(invalid).join('、'), invalid })))('非法输入在建立流和调用模型前拒绝 $label', async ({ invalid }) => {
    await expect(handlers.get('longStory:brainstorm')!(event(), { ...input, requestId, ...invalid })).rejects.toThrow('IPC_INPUT_INVALID')
    expect(generateStream).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
