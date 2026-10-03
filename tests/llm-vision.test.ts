import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '../src/main/data/llm-service'
import type { ProviderConfig } from '../src/shared/types'

const { runCodex } = vi.hoisted(() => ({ runCodex: vi.fn() }))
vi.mock('../src/main/data/codex-runner', () => ({ runCodex, probeCodex: vi.fn() }))

const image = 'data:image/png;base64,iVBORw0KGgo='

function service(protocol: ProviderConfig['protocol']): LlmService {
  return new LlmService({ read: async () => ({
    activeId: 'writing',
    providers: [
      { id: 'writing', label: 'writing', baseUrl: 'https://writing.example/v1', model: 'text', apiKey: 'test' },
      { id: 'vision', label: 'vision', baseUrl: 'https://vision.example/v1', model: 'default-model', apiKey: 'test', protocol }
    ],
    featureRouting: { library: { providerId: 'vision', model: 'cover-model' } }
  }) } as never)
}

function response(protocol: ProviderConfig['protocol']): Response {
  const data = protocol === 'anthropic'
    ? 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"分析"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    : protocol === 'openai-responses'
      ? 'data: {"type":"response.output_text.delta","delta":"分析"}\n\ndata: {"type":"response.completed","response":{}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"分析"}}]}\n\ndata: [DONE]\n\n'
  return new Response(data)
}

afterEach(() => { vi.restoreAllMocks(); runCodex.mockReset() })

describe('cover vision model inputs', () => {
  it.each(['openai', 'openai-responses', 'anthropic'] as const)(
    '%s sends actual image blocks through the library model route', async (protocol) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(protocol))
      expect(await service(protocol).generateStream('看封面', {
        images: [image], systemPrompt: '只描述可见证据', maxTokens: 800, meta: { feature: 'coverLearn' }
      })).toBe('分析')
      const [url, request] = fetch.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(request.body as string)
      expect(url).toContain('https://vision.example/v1/')
      expect(body.model).toBe('cover-model')
      if (protocol === 'openai-responses') {
        expect(body.input[1].content).toEqual([
          { type: 'input_text', text: '看封面' },
          { type: 'input_image', image_url: image, detail: 'high' }
        ])
        expect(body.max_output_tokens).toBe(800)
      } else if (protocol === 'anthropic') {
        expect(body.messages[0].content[1]).toEqual({
          type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
        })
        expect(body.system).toBe('只描述可见证据')
      } else {
        expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: image, detail: 'high' } })
      }
    }
  )

  it('passes images natively to Codex without inserting base64 into prose', async () => {
    runCodex.mockResolvedValue({ full: '分析', usage: null })
    await service('codex').generateStream('看封面', { images: [image], meta: { feature: 'coverLearn' } })
    expect(runCodex).toHaveBeenCalledWith(expect.stringContaining('看封面'), expect.objectContaining({ images: [image], model: 'cover-model' }))
    expect(runCodex.mock.calls[0][0]).not.toContain(image)
  })

  it.each(['grok', 'claude', 'antigravity'] as const)('%s reports unsupported vision instead of silently ignoring images', async (protocol) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(service(protocol).generateStream('看封面', { images: [image], meta: { feature: 'coverLearn' } })).rejects.toThrow('LLM_VISION_UNSUPPORTED')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed and oversized input before any network request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const svc = service('openai')
    for (const images of [['https://example.com/photo.png'], ['data:image/png;base64,%%%'], Array(7).fill(image), ['data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)]]) {
      await expect(svc.generateStream('看封面', { images, meta: { feature: 'coverLearn' } })).rejects.toThrow('LLM_VISION_INVALID')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps ordinary text requests unchanged', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('openai'))
    await service('openai').generateStream('总结', { meta: { feature: 'coverLearn' } })
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages).toEqual([{ role: 'user', content: '总结' }])
  })
})
