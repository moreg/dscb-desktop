import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShortStoryDocument } from '../src/shared/short-story'
import type { ShortStoryService } from '../src/main/data/short-story-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import { clearAllStreams, abortStream, activeStreamCount } from '../src/main/data/stream-abort-registry'

const { handlers, send, showSaveDialog, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(), showSaveDialog: vi.fn(), openPath: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }) },
  dialog: { showSaveDialog }, shell: { openPath }
}))
const { registerShortStoryIpc } = await import('../src/main/ipc/short-story')

function fixture(): ShortStoryDocument {
  return {
    id: 'e7b21d95-7815-4dd2-9bc5-947b4b944b03', revision: 1,
    sourceFingerprint: 'a'.repeat(64),
    title: '测试作品', kind: 'short', genre: '悬疑', brief: '寻找失踪的账本', requirements: '',
    targetWords: 2000, sectionCount: 2, outline: '第1节发现线索，第2节揭晓答案，主线完结。',
    sections: [{ number: 1, title: '', content: '' }, { number: 2, title: '', content: '' }], review: '',
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z'
  }
}
const requestId = '7b186965-dacb-4e52-9bf4-476cc87a6502'
const event = () => ({ sender: Object.assign(new EventEmitter(), { isDestroyed: () => false }) })

describe('中短篇 IPC', () => {
  let story: ShortStoryDocument
  let store: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; export: ReturnType<typeof vi.fn>; getDirectory: ReturnType<typeof vi.fn> }
  let generateStream: ReturnType<typeof vi.fn>
  beforeEach(() => {
    handlers.clear()
    clearAllStreams()
    send.mockClear()
    story = fixture()
    store = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), get: vi.fn().mockImplementation(async () => story), save: vi.fn(), export: vi.fn(), getDirectory: vi.fn() }
    generateStream = vi.fn(async (_prompt: string, opts: GenerateOptions) => {
      opts.onToken?.('他找到了账本。')
      return '他找到了账本。'
    })
    registerShortStoryIpc(store as unknown as ShortStoryService, { generateStream } as unknown as LlmService)
  })

  it('流式正文采用正文模型路由，按请求推送，不直接改稿', async () => {
    const result = await handlers.get('shortStory:generate')!(event(), { story, task: 'section', sectionNumber: 1, requestId })
    expect(result).toEqual({ ok: true })
    expect(generateStream.mock.calls[0][1]).toMatchObject({ meta: { feature: 'chapter' }, maxTokens: expect.any(Number) })
    expect(send.mock.calls.map(call => call[1])).toEqual([
      { requestId, token: '他找到了账本。', done: false }, { requestId, token: '', done: true }
    ])
    expect(store.save).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('根据完结检查修订指定节，输出替换候选且不直接保存原稿', async () => {
    story.sections = story.sections.map(section => ({ ...section, content: `第${section.number}节已有完整原稿。` }))
    story.outline = ''
    story.review = '第 1 节线索来源不明，请补充具体行动。'
    const original = structuredClone(story)
    expect(await handlers.get('shortStory:generate')!(event(), {
      story, task: 'revise', sectionNumber: 1, instruction: '保留原有人物关系', requestId
    })).toEqual({ ok: true })
    const [prompt, options] = generateStream.mock.calls[0]
    expect(prompt).toContain(story.review)
    for (const section of story.sections) expect(prompt).toContain(section.content)
    expect(prompt).toContain('保留原有人物关系')
    expect(prompt).toContain('采用时将替换原节，不追加到末尾')
    expect(options).toMatchObject({ meta: { feature: 'chapter' }, maxTokens: expect.any(Number) })
    expect(options.systemPrompt).toContain('完整修订正文')
    expect(story).toEqual(original)
    expect(store.save).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('修订缺少已采用报告、有效节号或完整正文时在IPC边界拒绝', async () => {
    story.sections = story.sections.map(section => ({ ...section, content: '已经写完的正文。' }))
    story.review = '检查结果。'
    const invalidInputs = [
      { story: { ...story, review: ' ' }, sectionNumber: 1 },
      { story, sectionNumber: undefined },
      { story, sectionNumber: 3 },
      { story: { ...story, sections: [story.sections[0], { ...story.sections[1], content: ' ' }] }, sectionNumber: 1 },
      { story: { ...story, sections: [{ ...story.sections[0], content: '' }, story.sections[1]] }, sectionNumber: 1 }
    ]
    for (const input of invalidInputs) {
      await expect(handlers.get('shortStory:generate')!(event(), { ...input, task: 'revise', requestId }))
        .rejects.toThrow('IPC_INPUT_INVALID')
    }
    expect(generateStream).not.toHaveBeenCalled()
    expect(store.get).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('修订报告与原稿合计超出上下文上限时拒绝生成且不截断资料', async () => {
    story.sectionCount = 8
    story.targetWords = 48000
    story.sections = Array.from({ length: 8 }, (_, index) => ({
      number: index + 1, title: '', content: '文'.repeat(35000)
    }))
    story.review = '查'.repeat(30000)
    const result = await handlers.get('shortStory:generate')!(event(), {
      story, task: 'revise', sectionNumber: 1, requestId
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('未截断前文') })
    expect(generateStream).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('过期revision拒绝生成，避免其他窗口改稿后继续用旧稿', async () => {
    store.get.mockResolvedValue({ ...story, revision: 2 })
    const result = await handlers.get('shortStory:generate')!(event(), { story, task: 'outline', requestId })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('其他窗口') })
    expect(generateStream).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('同revision但Markdown已被外部修改时拒绝使用旧稿生成', async () => {
    store.get.mockResolvedValue({ ...story, sourceFingerprint: 'b'.repeat(64) })
    const result = await handlers.get('shortStory:generate')!(event(), { story, task: 'outline', requestId })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('重新打开') })
    expect(generateStream).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('提前取消不调用模型', async () => {
    abortStream(requestId)
    const result = await handlers.get('shortStory:generate')!(event(), { story, task: 'outline', requestId })
    expect(result).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(generateStream).not.toHaveBeenCalled()
    expect(activeStreamCount()).toBe(0)
  })

  it('关窗取消生成且清理监听与流', async () => {
    const e = event()
    generateStream.mockImplementation(async (_prompt: string, opts: GenerateOptions) => {
      e.sender.emit('destroyed')
      expect(opts.signal?.aborted).toBe(true)
      throw new Error('LLM_ABORTED')
    })
    expect(await handlers.get('shortStory:generate')!(e, { story, task: 'outline', requestId })).toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(e.sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it('无分块回调时仍交付返回文本，空结果明确报错', async () => {
    generateStream.mockResolvedValueOnce('整段正文').mockResolvedValueOnce('  ')
    expect(await handlers.get('shortStory:generate')!(event(), { story, task: 'outline', requestId })).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith('shortStory:token', { requestId, token: '整段正文', done: false })
    expect(await handlers.get('shortStory:generate')!(event(), { story, task: 'outline', requestId })).toMatchObject({ ok: false, error: expect.stringContaining('未返回内容') })
  })

  it('非法路径和会漏稿的分节数据在IPC边界拒绝', async () => {
    await expect(handlers.get('shortStory:get')!(event(), '../secret')).rejects.toThrow('IPC_INPUT_INVALID')
    await expect(handlers.get('shortStory:save')!(event(), { ...story, sections: [] })).rejects.toThrow('IPC_INPUT_INVALID')
    expect(store.get).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })
})
