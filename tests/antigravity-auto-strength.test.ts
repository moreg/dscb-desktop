import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmService } from '../src/main/data/llm-service'
import type { SecretStore } from '../src/main/data/secret-store'

const { runAntigravity, listAntigravityModelsLive } = vi.hoisted(() => ({
  runAntigravity: vi.fn(async (_prompt: string, _opts?: { model?: string }) => ({ full: '正文', usage: null })),
  listAntigravityModelsLive: vi.fn(async () => [
    'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.8 Flash (Low)',
    'Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)'
  ])
}))
vi.mock('../src/main/data/antigravity-runner', () => ({
  runAntigravity, listAntigravityModelsLive, probeAntigravity: vi.fn()
}))

function service(model: string): { llm: LlmService; provider: { model: string } } {
  const provider = { id: 'agy', label: 'AGY', protocol: 'antigravity' as const,
    baseUrl: 'antigravity://local', apiKey: '', model }
  const llm = new LlmService({ read: async () => ({ activeId: 'agy', providers: [provider] }) } as SecretStore)
  return { llm, provider }
}

beforeEach(() => {
  runAntigravity.mockClear()
  listAntigravityModelsLive.mockClear()
})

describe('AGY automatic writing strength', () => {
  it('switches each call using one live model lookup without changing saved provider', async () => {
    const { llm, provider } = service('Gemini 3.8 Flash (Medium)')
    await llm.generateStream('高潮章', { strengthOverride: { reasoningEffort: 'high' } })
    await llm.generateStream('过渡章', { strengthOverride: { reasoningEffort: 'low' } })
    expect(runAntigravity.mock.calls.map(([, opts]) => opts?.model)).toEqual([
      'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Low)'
    ])
    expect(listAntigravityModelsLive).toHaveBeenCalledTimes(1)
    expect(provider.model).toBe('Gemini 3.8 Flash (Medium)')
  })

  it('keeps current model when the desired tier is absent', async () => {
    const { llm } = service('Gemini 3.1 Pro (High)')
    await llm.generateStream('常规章', { strengthOverride: { reasoningEffort: 'medium' } })
    expect(runAntigravity.mock.calls[0]?.[1]?.model).toBe('Gemini 3.1 Pro (High)')
  })

  it('does not query models when automatic strength is off or model has no tier', async () => {
    const { llm } = service('Gemini 3.8 Flash (High)')
    await llm.generateStream('正文')
    const { llm: other } = service('Claude Sonnet 4.6 (Thinking)')
    await other.generateStream('正文', { strengthOverride: { reasoningEffort: 'high' } })
    expect(listAntigravityModelsLive).not.toHaveBeenCalled()
  })
})
