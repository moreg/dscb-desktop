import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProjectService } from '../src/main/data/project-service'
import { StyleProfileService, parseStyleAnalysisResult } from '../src/main/data/style-profile-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

describe('StyleProfileService', () => {
  let root: string
  let projectId: string
  let projectService: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-style-svc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await projectService.create({ name: '文风测试', genre: '都市' })).id
  })

  it('extract parses valid json output', async () => {
    const raw = JSON.stringify({
      identifiedStyle: '冷峻都市',
      sentencePatterns: ['短句推进'],
      vocabularyPreferences: ['冷硬动词'],
      punctuationAndRhythm: ['顿号少，句号多'],
      narrativePerspective: ['第三人称近距离'],
      tone: ['克制'],
      narrativeTemplates: ['冲突先行'],
      dos: ['多用动作反应'],
      donts: ['不要空泛抒情'],
      stylePrompt: '保持冷峻都市感。'
    })
    const service = new StyleProfileService(projectService, mockLlm(raw))
    const result = await service.extract(projectId, 'a'.repeat(500), '冷峻风')
    expect(result.identifiedStyle).toBe('冷峻都市')
    expect(result.stylePrompt).toContain('冷峻')
  })

  it('rejects samples that are too short', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    await expect(service.extract(projectId, '太短了')).rejects.toThrow(/STYLE_SAMPLE_TOO_SHORT/)
  })

  it('deleting the default style clears project defaultStyleProfileId', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const created = await service.create(projectId, {
      name: '默认风格',
      sourceType: 'sampleText',
      sampleText: 'a'.repeat(500),
      identifiedStyle: '冷峻',
      sentencePatterns: ['短句'],
      vocabularyPreferences: ['克制'],
      punctuationAndRhythm: ['停顿多'],
      narrativePerspective: ['第三人称'],
      tone: ['冷静'],
      narrativeTemplates: ['冲突先行'],
      dos: ['多写动作'],
      donts: ['不要空话'],
      stylePrompt: '保持冷峻。'
    })
    await projectService.updateProjectData(projectId, { defaultStyleProfileId: created.id })

    await service.delete(projectId, created.id)

    const project = await projectService.getProjectData(projectId)
    expect(project.defaultStyleProfileId).toBeUndefined()
  })
})

describe('parseStyleAnalysisResult', () => {
  it('tolerates wrapped json text', () => {
    const result = parseStyleAnalysisResult(
      `这里是解释\n${JSON.stringify({
        identifiedStyle: '冷峻',
        sentencePatterns: ['短句'],
        vocabularyPreferences: ['克制'],
        punctuationAndRhythm: ['停顿'],
        narrativePerspective: ['第三人称'],
        tone: ['冷静'],
        narrativeTemplates: ['冲突推进'],
        dos: ['多写动作'],
        donts: ['不要抒情'],
        stylePrompt: '保持冷峻。'
      })}\n结束`
    )
    expect(result.identifiedStyle).toBe('冷峻')
  })
})
