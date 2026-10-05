import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileBrainstormService,
  mobileBrainstormInputSchema,
  type MobileBrainstormInput
} from '../src/main/mobile/mobile-brainstorm-service'
import { LlmService, type GenerateOptions } from '../src/main/data/llm-service'
import type { SecretStore } from '../src/main/data/secret-store'
import { buildLongStoryBrainstormPrompt } from '../src/main/data/skill-prompts/long-story-brainstorm'
import type { LongStoryIdea } from '../src/shared/long-story-brainstorm'
import type { ShortStoryIdea } from '../src/shared/short-story'

const base = { genre: '悬疑', direction: '雨夜收到陌生来信', requirements: '' }
const shortIdeas: ShortStoryIdea[] = [1, 2, 3].map((number) => ({
  title: `第${number}封来信`, premise: `第${number}位寄信人藏着不同的秘密。`,
  hook: '主角收到一封寄给自己的信。', twist: '信纸上的水印留下了公平线索。', ending: '主角找到寄信人，作出自己的选择。'
}))
const longIdeas: LongStoryIdea[] = shortIdeas.map((idea, index) => ({
  ...idea,
  mainLine: `循着第${index + 1}位寄信人的线索，主动查明各地来信的关联。`,
  progression: '先找到一位同行者，再凭前期积累深入新区域，最终解开来信的根源。'
}))

describe('MobileBrainstormService', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reuses the desktop long-story prompt and delivers parsed ideas with the raw output', async () => {
    const input: MobileBrainstormInput = {
      ...base, kind: 'long', targetChapters: 120, sourceBrief: '一座只在雨夜开放的邮局', variationSeed: 'another-batch'
    }
    const rawText = JSON.stringify({ ideas: longIdeas })
    const generateStream = vi.fn(async (_prompt: string, _options: GenerateOptions) => rawText)
    const service = new MobileBrainstormService({ generateStream })
    const signal = new AbortController().signal

    await expect(service.generate(input, signal)).resolves.toEqual({ ok: true, ideas: longIdeas, rawText })
    const prompt = buildLongStoryBrainstormPrompt(input)
    expect(generateStream).toHaveBeenCalledWith(prompt.user, expect.objectContaining({
      systemPrompt: prompt.system, maxTokens: prompt.maxTokens, meta: { feature: 'outline-generate' }, signal
    }))
  })

  it.each([['short', 8_000], ['medium', 30_000]] as const)(
    'generates %s ideas using its default word budget', async (kind, budget) => {
      const rawText = JSON.stringify({ ideas: shortIdeas })
      const generateStream = vi.fn(async (_prompt: string, _options: GenerateOptions) => rawText)
      const service = new MobileBrainstormService({ generateStream })

      await expect(service.generate({ ...base, kind }, new AbortController().signal))
        .resolves.toEqual({ ok: true, ideas: shortIdeas, rawText })
      expect(generateStream.mock.calls[0][0]).toContain(`"全文字数预算": ${budget}`)
      expect(generateStream.mock.calls[0][1]).toMatchObject({ meta: { feature: 'outline-generate' }, maxTokens: 8_192 })
    }
  )

  it('includes history in the prompt and filters duplicate and incomplete ideas without another AI call', async () => {
    const rawText = JSON.stringify({ ideas: [shortIdeas[0], { ...shortIdeas[1], ending: '' }, shortIdeas[2]] })
    const generateStream = vi.fn(async (_prompt: string, _options: GenerateOptions) => rawText)
    const service = new MobileBrainstormService({ generateStream })

    await expect(service.generate({ ...base, kind: 'short', previousIdeas: [shortIdeas[0]] }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, ideas: [shortIdeas[2]], warning: expect.stringContaining('保留 1 个'), rawText })
    expect(generateStream.mock.calls[0][0]).toContain(shortIdeas[0].premise)
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('preserves malformed model output for recovery', async () => {
    const rawText = '一个可继续使用的故事设想，模型没有按照 JSON 输出。'
    const service = new MobileBrainstormService({ generateStream: vi.fn(async () => rawText) })
    await expect(service.generate({ ...base, kind: 'long' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, rawText, error: expect.stringContaining('无法解析') })
  })

  it('recovers complete long-story ideas from a timed-out stream and retains its partial raw text', async () => {
    const rawText = `{"ideas":[${JSON.stringify(longIdeas[0])},${JSON.stringify(longIdeas[1])},{"title":"截断`
    const generateStream = vi.fn(async (_prompt: string, options: GenerateOptions): Promise<string> => {
      options.onToken?.(rawText)
      throw new Error('LLM_TIMEOUT')
    })
    const service = new MobileBrainstormService({ generateStream })

    await expect(service.generate({ ...base, kind: 'long' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, ideas: longIdeas.slice(0, 2), rawText, warning: expect.stringContaining('超时') })
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it('keeps partial raw output on transport failure without exposing private error details', async () => {
    const rawText = '已收到的开篇灵感'
    const generateStream = vi.fn(async (_prompt: string, options: GenerateOptions): Promise<string> => {
      options.onToken?.(rawText)
      throw new Error('C:\\private\\config.json secret credential')
    })
    const service = new MobileBrainstormService({ generateStream })
    const result = await service.generate({ ...base, kind: 'medium' }, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, rawText })
    expect(result.error).not.toContain('private')
    expect(result.error).not.toContain('credential')
  })

  it('skips a pre-cancelled request and rejects late model output after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const generateStream = vi.fn(async () => JSON.stringify({ ideas: shortIdeas }))
    const service = new MobileBrainstormService({ generateStream })
    await expect(service.generate({ ...base, kind: 'short' }, controller.signal))
      .resolves.toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(generateStream).not.toHaveBeenCalled()

    const during = new AbortController()
    generateStream.mockImplementationOnce(async () => {
      during.abort()
      return JSON.stringify({ ideas: shortIdeas })
    })
    await expect(service.generate({ ...base, kind: 'short' }, during.signal))
      .resolves.toEqual({ ok: false, error: 'LLM_ABORTED' })
  })

  it('passes cancellation through the real LlmService to its HTTP request', async () => {
    let markStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => { markStarted = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const signal = options!.signal!
      markStarted(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const secret = { read: async () => ({ activeId: 'mobile-test', providers: [{
      id: 'mobile-test', label: 'test', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-credential'
    }] }) } as unknown as SecretStore
    const service = new MobileBrainstormService(new LlmService(secret))
    const controller = new AbortController()
    const pending = service.generate({ ...base, kind: 'short' }, controller.signal)
    const requestSignal = await started

    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, error: 'LLM_ABORTED' })
    expect(requestSignal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('validates all bounds before occupying the model', async () => {
    const generateStream = vi.fn(async () => '')
    const service = new MobileBrainstormService({ generateStream })
    await expect(service.generate({ ...base, kind: 'short', targetWords: 999 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false })
    expect(generateStream).not.toHaveBeenCalled()
    expect(mobileBrainstormInputSchema.safeParse({ ...base, kind: 'long', targetChapters: 100_001 }).success).toBe(false)
    expect(mobileBrainstormInputSchema.safeParse({ ...base, kind: 'short', variationSeed: 'a'.repeat(101) }).success).toBe(false)
  })
})
