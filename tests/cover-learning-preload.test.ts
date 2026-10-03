import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'

const { invoke, expose } = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() }
}))
await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi
beforeEach(() => invoke.mockClear())

describe('cover learning preload contract', () => {
  it.each(['male', 'female'] as const)('forwards %s channel for all prompt and generation requests', async (channel) => {
    const input = { projectId: 'p1', bookName: '夜路', authorName: '作者', platform: 'fanqie' as const, channel }
    await api.buildCoverPrompt(input)
    await api.getCoverPromptContext(input)
    await api.extractCoverPrompt(input)
    await api.generateCover(input)
    expect(invoke.mock.calls).toEqual([
      ['cover:buildPrompt', input], ['cover:getPromptContext', input],
      ['cover:extractPrompt', input], ['cover:generate', input]
    ])
  })

  it('exposes project-scoped generation recovery, cancellation and original-image crop preferences', async () => {
    const crop = { projectId: 'p1', fileName: '封面_v1.png', offsetY: 0.7, fit: 'contain' as const }
    await api.getCoverGenerationTask('p1')
    await api.cancelCoverGenerationTask('p1')
    await api.updateCoverCrop(crop)
    expect(invoke.mock.calls).toEqual([['cover:getGenerationTask', 'p1'], ['cover:cancelGenerationTask', 'p1'], ['cover:updateCrop', crop]])
  })
  it('passes learning options and defaults to an empty payload for local mode', async () => {
    await api.chooseAndLearnCoverFolder()
    expect(invoke).toHaveBeenCalledWith('cover:chooseAndLearnFolder', {})
    await api.chooseAndLearnCoverFolder({ genre: 'scifi', aiMode: 'vision' })
    expect(invoke).toHaveBeenLastCalledWith('cover:chooseAndLearnFolder', { genre: 'scifi', aiMode: 'vision' })
  })
  it('exposes task recovery, cancellation and rule rollback without page-local state', async () => {
    await api.getCoverLearningTask()
    await api.cancelCoverLearningTask()
    await api.rollbackCoverLearningRules()
    expect(invoke.mock.calls).toEqual([['cover:getLearningTask'], ['cover:cancelLearningTask'], ['cover:rollbackLearningRules']])
  })
  it('passes toggles, prompt contexts and feedback to their respective channels', async () => {
    const toggle = { id: 'rule1', enabled: false }
    const input = { projectId: 'p1', bookName: '夜路', authorName: '作者', platform: 'fanqie' as const }
    const feedback = { projectId: 'p1', fileName: '封面_v1.png', status: 'adopted' as const }
    await api.setCoverLearningRuleEnabled(toggle)
    await api.getCoverPromptContext(input)
    await api.updateCoverFeedback(feedback)
    expect(invoke.mock.calls).toEqual([['cover:setLearningRuleEnabled', toggle], ['cover:getPromptContext', input], ['cover:updateFeedback', feedback]])
  })
})
