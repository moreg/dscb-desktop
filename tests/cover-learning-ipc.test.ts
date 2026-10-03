import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverService } from '../src/main/data/cover-service'
import type { CoverPromptService } from '../src/main/data/cover-prompt-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { CoverLearningLibraryService } from '../src/main/data/cover-learning-library'

const { handlers, chooseDirectory, windows } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  chooseDirectory: vi.fn(),
  windows: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  dialog: { showOpenDialog: chooseDirectory },
  shell: { showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: windows }
}))

const { registerCoverIpc } = await import('../src/main/ipc/cover')

const cover = {
  resolvePromptWithLibrary: vi.fn().mockResolvedValue('prompt'),
  getPromptContext: vi.fn().mockResolvedValue({ rules: [] }),
  updateFeedback: vi.fn().mockResolvedValue({ fileName: '封面_v1.png' }),
  getGenerationTask: vi.fn(),
  cancelGeneration: vi.fn(),
  updateCrop: vi.fn(),
  generate: vi.fn().mockResolvedValue({ fileName: '封面_v1.png' })
}
const promptService = { extract: vi.fn().mockResolvedValue({ prompt: 'extracted' }) }
const learning = {
  initialize: vi.fn().mockResolvedValue({ directory: 'E:\\covers', status: 'ready' }),
  learnFolder: vi.fn(),
  setDirectory: vi.fn(),
  getTaskState: vi.fn(),
  cancelLearning: vi.fn(),
  rollbackLastLearningRules: vi.fn(),
  setRuleEnabled: vi.fn()
}
const coverInput = { projectId: 'p1', bookName: '夜路', authorName: '作者', platform: 'fanqie' }

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerCoverIpc(
    cover as unknown as CoverService,
    {} as SettingsRepository,
    promptService as unknown as CoverPromptService,
    learning as unknown as CoverLearningLibraryService
  )
})

describe('cover IPC boundaries', () => {
  it.each(['male', 'female'] as const)('passes the %s channel through build, context, extraction and generation', async (channel) => {
    const input = { ...coverInput, channel }
    await handlers.get('cover:buildPrompt')!(null, input)
    await handlers.get('cover:getPromptContext')!(null, input)
    await handlers.get('cover:extractPrompt')!(null, input)
    await handlers.get('cover:generate')!(null, input)
    expect(cover.resolvePromptWithLibrary).toHaveBeenCalledWith({ ...input, promptOverride: undefined })
    expect(cover.getPromptContext).toHaveBeenCalledWith(input)
    expect(promptService.extract).toHaveBeenCalledWith(input)
    expect(cover.generate).toHaveBeenCalledWith(input)
  })

  it('rejects an unsupported channel before any prompt or image request', async () => {
    for (const name of ['cover:buildPrompt', 'cover:getPromptContext', 'cover:extractPrompt', 'cover:generate']) {
      await expect(handlers.get(name)!(null, { ...coverInput, channel: 'auto' })).rejects.toThrow()
    }
    expect(cover.resolvePromptWithLibrary).not.toHaveBeenCalled()
    expect(cover.getPromptContext).not.toHaveBeenCalled()
    expect(promptService.extract).not.toHaveBeenCalled()
    expect(cover.generate).not.toHaveBeenCalled()
  })

  it('validates project identity for generation task recovery and cancellation', async () => {
    cover.getGenerationTask.mockReturnValue({ projectId: 'p1', phase: 'generating' })
    cover.cancelGeneration.mockReturnValue({ ok: true })
    expect(await handlers.get('cover:getGenerationTask')!(null, 'p1')).toMatchObject({ phase: 'generating' })
    expect(await handlers.get('cover:cancelGenerationTask')!(null, 'p1')).toEqual({ ok: true })
    await expect(handlers.get('cover:getGenerationTask')!(null, 123)).rejects.toThrow()
    await expect(handlers.get('cover:cancelGenerationTask')!(null, '')).rejects.toThrow()
    expect(cover.getGenerationTask).toHaveBeenCalledOnce()
    expect(cover.cancelGeneration).toHaveBeenCalledOnce()
  })
  it('passes crop preferences while rejecting traversal, invalid offsets and unknown fitting modes', async () => {
    const input = { projectId: 'p1', fileName: '封面_v1.png', offsetX: 0.25, offsetY: 0.75, fit: 'contain' }
    await handlers.get('cover:updateCrop')!(null, input)
    expect(cover.updateCrop).toHaveBeenCalledWith(input)
    for (const change of [{ fileName: '../image.png' }, { offsetX: -0.1 }, { offsetY: 1.1 }, { offsetX: NaN }, { fit: 'stretch' }]) {
      await expect(handlers.get('cover:updateCrop')!(null, { ...input, ...change })).rejects.toThrow()
    }
    expect(cover.updateCrop).toHaveBeenCalledOnce()
  })
  it('preserves more than twelve rules including a long user rule and the newest AI rule', async () => {
    const rules = [...Array.from({ length: 20 }, (_, index) => `USER_RULE_${index}`), 'Keep the exact title readable. '.repeat(30), 'LATEST_AI_RULE']
    const learningContext = { libraryVersion: 'v2', sourceSampleCount: 143, resolvedStylePreset: 'auto', rules }
    await handlers.get('cover:buildPrompt')!(null, { ...coverInput, learningContext })
    expect(cover.resolvePromptWithLibrary).toHaveBeenCalledWith(expect.objectContaining({ learningContext }))
    expect(cover.resolvePromptWithLibrary.mock.calls[0][0].learningContext.rules.at(-1)).toBe('LATEST_AI_RULE')
  })
  it('preserves a typography base while clearing an old full prompt override', async () => {
    await handlers.get('cover:buildPrompt')!(null, {
      ...coverInput,
      promptOverride: 'old full prompt',
      typographyBasePrompt: 'author edited scene'
    })
    expect(cover.resolvePromptWithLibrary).toHaveBeenCalledWith({
      ...coverInput,
      promptOverride: undefined,
      typographyBasePrompt: 'author edited scene'
    })
  })

  it('validates the context request before calling the cover service', async () => {
    await handlers.get('cover:getPromptContext')!(null, coverInput)
    expect(cover.getPromptContext).toHaveBeenCalledWith(coverInput)
    await expect(handlers.get('cover:getPromptContext')!(null, { ...coverInput, platform: 'invalid' })).rejects.toThrow()
    expect(cover.getPromptContext).toHaveBeenCalledTimes(1)
  })

  it('rejects traversal paths and unknown feedback states', async () => {
    await expect(handlers.get('cover:updateFeedback')!(null, { projectId: 'p1', fileName: '../secret.png', status: 'adopted' })).rejects.toThrow()
    await expect(handlers.get('cover:updateFeedback')!(null, { projectId: 'p1', fileName: '封面_v1.png', status: 'deleted' })).rejects.toThrow()
    expect(cover.updateFeedback).not.toHaveBeenCalled()
    await handlers.get('cover:updateFeedback')!(null, { projectId: 'p1', fileName: '封面_v1.png', status: 'rejected', reason: '  标题不清晰  ' })
    expect(cover.updateFeedback).toHaveBeenCalledWith({ projectId: 'p1', fileName: '封面_v1.png', status: 'rejected', reason: '标题不清晰' })
  })

  it('defaults folder learning to local analysis and preserves an explicit genre and vision mode', async () => {
    chooseDirectory.mockResolvedValue({ canceled: false, filePaths: ['E:\\covers'] })
    await handlers.get('cover:chooseAndLearnFolder')!(null)
    expect(learning.learnFolder).toHaveBeenLastCalledWith('E:\\covers', { aiMode: 'off' })
    await handlers.get('cover:chooseAndLearnFolder')!(null, { genre: 'mystery', aiMode: 'vision' })
    expect(learning.learnFolder).toHaveBeenLastCalledWith('E:\\covers', { genre: 'mystery', aiMode: 'vision' })
  })

  it('validates folder options before opening a dialog and cancellation starts no learning', async () => {
    await expect(handlers.get('cover:chooseAndLearnFolder')!(null, { aiMode: 'upload_all' })).rejects.toThrow()
    expect(chooseDirectory).not.toHaveBeenCalled()
    chooseDirectory.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await handlers.get('cover:chooseAndLearnFolder')!(null, { aiMode: 'off' })).toBeNull()
    expect(learning.learnFolder).not.toHaveBeenCalled()
  })

  it('queries the shared task, cancels it, and restores rules through the service', async () => {
    const task = { id: 'task1', phase: 'analyzing', processed: 4, scanned: 10 }
    learning.getTaskState.mockReturnValue(task)
    learning.cancelLearning.mockReturnValue({ ok: true })
    learning.rollbackLastLearningRules.mockResolvedValue({ status: 'ready' })
    expect(await handlers.get('cover:getLearningTask')!(null)).toBe(task)
    expect(await handlers.get('cover:cancelLearningTask')!(null)).toEqual({ ok: true })
    expect(await handlers.get('cover:rollbackLearningRules')!(null)).toEqual({ status: 'ready' })
  })

  it('allows boolean rule state changes and rejects invalid toggle payloads', async () => {
    await handlers.get('cover:setLearningRuleEnabled')!(null, { id: ' rule1 ', enabled: false })
    expect(learning.setRuleEnabled).toHaveBeenCalledWith('rule1', false)
    await expect(handlers.get('cover:setLearningRuleEnabled')!(null, { id: 'rule1', enabled: 'false' })).rejects.toThrow()
    expect(learning.setRuleEnabled).toHaveBeenCalledTimes(1)
  })

  it('keeps scene data, prompt provenance and the actual learning context across IPC', async () => {
    const input = {
      ...coverInput,
      scene: { characterDesc: 'a woman with a red umbrella', backgroundDesc: 'foggy lane' },
      promptSource: 'edited',
      learningContext: { libraryVersion: 'v1', rules: ['Keep title readable.'], sourceSampleCount: 3, resolvedStylePreset: 'dark_suspense', sources: ['statistics:3'] }
    }
    await handlers.get('cover:buildPrompt')!(null, input)
    expect(cover.resolvePromptWithLibrary).toHaveBeenCalledWith({ ...input, promptOverride: undefined })
    await expect(handlers.get('cover:buildPrompt')!(null, { ...input, learningContext: { ...input.learningContext, sourceSampleCount: -1 } })).rejects.toThrow()
  })
})
