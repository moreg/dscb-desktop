import { describe, expect, it, vi } from 'vitest'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService } from '../src/main/data/llm-service'
const valid = JSON.stringify({ newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] })

describe('memory analysis reuse', () => {
  it('reuses exact auto-sync extraction in manual sync, but not different prose, context, project or model', async () => {
    let identity: string | null = 'model-a'
    const generateStream = vi.fn(async () => valid)
    const service = new WriteFlowService({ generateStream, getCacheIdentity: async () => identity } as unknown as LlmService)
    const base = { meta: { projectId: 'p', feature: 'autoMemorySync' } }
    await service.extractMemoryStream('林远入城。', 1, [], base)
    const onToken = vi.fn()
    await service.extractMemoryStream('林远入城。', 1, [], { reuseMemory: true, onToken, meta: { projectId: 'p', feature: 'memoryExtract' } })
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith(valid)
    await service.extractMemoryStream('林远出城。', 1, [], { ...base, reuseMemory: true })
    await service.extractMemoryStream('林远入城。', 1, ['林远'], { ...base, reuseMemory: true })
    await service.extractMemoryStream('林远入城。', 1, [], { reuseMemory: true, meta: { projectId: 'other', feature: 'memoryExtract' } })
    identity = 'model-b'
    await service.extractMemoryStream('林远入城。', 1, [], { ...base, reuseMemory: true })
    identity = null
    await service.extractMemoryStream('林远入城。', 1, [], { ...base, reuseMemory: true })
    expect(generateStream).toHaveBeenCalledTimes(6)
  })
  it('does not reuse malformed or aborted output and allows explicit reanalysis', async () => {
    const generateStream = vi.fn().mockResolvedValueOnce('{}').mockResolvedValue(valid)
    const service = new WriteFlowService({ generateStream, getCacheIdentity: async () => 'model' } as unknown as LlmService)
    await service.extractMemoryStream('正文', 1, [], { reuseMemory: true })
    await service.extractMemoryStream('正文', 1, [], { reuseMemory: true })
    expect(generateStream).toHaveBeenCalledTimes(2)
    await service.extractMemoryStream('正文', 1, [], { reuseMemory: false })
    expect(generateStream).toHaveBeenCalledTimes(3)
    const controller = new AbortController(); controller.abort()
    await expect(service.extractMemoryStream('正文', 1, [], { reuseMemory: true, signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
  })
})
