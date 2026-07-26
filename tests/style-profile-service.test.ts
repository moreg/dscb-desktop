import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProjectService } from '../src/main/data/project-service'
import { StyleProfileService, parseStyleAnalysisResult } from '../src/main/data/style-profile-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import { makeStyleInput } from './helpers/style-fixtures'

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

  it('extract parses valid json output but drops character and plot constraints', async () => {
    const raw = JSON.stringify({
      identifiedStyle: '冷峻都市',
      sentencePatterns: ['短句推进'],
      vocabularyPreferences: ['冷硬动词'],
      punctuationAndRhythm: ['顿号少，句号多'],
      narrativePerspective: ['第三人称近距离'],
      tone: ['克制'],
      narrativeTemplates: ['冲突先行'],
      styleConstraints: ['保持现实质感', '对话口语化'],
      characterConstraints: ['保持主角冷静'],
      plotConstraints: ['避免金手指'],
      stylePrompt: '保持冷峻都市感。'
    })
    const service = new StyleProfileService(projectService, mockLlm(raw))
    const result = await service.extract(projectId, 'a'.repeat(500), '冷峻风')
    expect(result.identifiedStyle).toBe('冷峻都市')
    expect(result.stylePrompt).toContain('冷峻')
    expect(result.styleConstraints).toEqual(['保持现实质感', '对话口语化'])
    expect(result.characterConstraints).toEqual([])
    expect(result.plotConstraints).toEqual([])
  })

  it('falls back dos/donts into styleConstraints when new buckets are absent', async () => {
    const raw = JSON.stringify({
      identifiedStyle: '冷峻',
      sentencePatterns: [],
      vocabularyPreferences: [],
      punctuationAndRhythm: [],
      narrativePerspective: [],
      tone: [],
      narrativeTemplates: [],
      dos: ['用短句推进'],
      donts: ['不要抒情泛滥'],
      stylePrompt: '保持冷峻。'
    })
    const service = new StyleProfileService(projectService, mockLlm(raw))
    const result = await service.extract(projectId, 'a'.repeat(500))
    expect(result.styleConstraints).toEqual(['用短句推进', '不要抒情泛滥'])
    expect(result.characterConstraints).toEqual([])
    expect(result.plotConstraints).toEqual([])
  })

  it('rejects samples that are too short', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    await expect(service.extract(projectId, '太短了')).rejects.toThrow(/STYLE_SAMPLE_TOO_SHORT/)
  })

  it('deleting a style clears defaults across every project that referenced it', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const other = await projectService.create({ name: '另一本书', genre: '玄幻' })
    const created = await service.create(makeStyleInput('共享风格'))
    await projectService.updateProjectData(projectId, { defaultStyleProfileId: created.id })
    await projectService.updateProjectData(other.id, { defaultStyleProfileId: created.id })

    // 文风库是全局的：删除一张卡要清掉所有项目的悬空默认引用，而不只是"当前"项目
    await service.delete(created.id)

    expect((await projectService.getProjectData(projectId)).defaultStyleProfileId).toBeUndefined()
    expect((await projectService.getProjectData(other.id)).defaultStyleProfileId).toBeUndefined()
  })

  it('deleting a style leaves unrelated project defaults untouched', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const keep = await service.create(makeStyleInput('保留'))
    const drop = await service.create(makeStyleInput('删除'))
    await projectService.updateProjectData(projectId, { defaultStyleProfileId: keep.id })

    await service.delete(drop.id)

    expect((await projectService.getProjectData(projectId)).defaultStyleProfileId).toBe(keep.id)
  })

  it('update patches single field and preserves others', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const created = await service.create(
      makeStyleInput('原名', {
        identifiedStyle: '冷峻',
        styleConstraints: ['用短句推进'],
        characterConstraints: ['保持冷静'],
        plotConstraints: ['避免金手指'],
        stylePrompt: '保持冷峻。'
      })
    )

    const updated = await service.update(created.id, { name: '新名' })
    expect(updated.name).toBe('新名')
    expect(updated.identifiedStyle).toBe('冷峻')
    expect(updated.styleConstraints).toEqual(['用短句推进'])
    expect(updated.characterConstraints).toEqual(['保持冷静'])
    expect(updated.plotConstraints).toEqual(['避免金手指'])
    expect(updated.stylePrompt).toBe('保持冷峻。')
    expect(updated.updatedAt >= created.createdAt).toBe(true)
  })

  it('update can replace three constraint buckets atomically', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const created = await service.create(
      makeStyleInput('测试', {
        sentencePatterns: ['短句'],
        styleConstraints: ['用短句推进'],
        characterConstraints: ['保持冷静'],
        plotConstraints: ['避免金手指']
      })
    )

    const updated = await service.update(created.id, {
      styleConstraints: ['保持现实质感', '对话口语化', '节奏紧张-缓和交替'],
      characterConstraints: ['主角保持冷静', '避免冗长内心独白'],
      plotConstraints: ['避免金手指', '穿插过去闪回'],
      identifiedStyle: '冷峻重生都市',
      stylePrompt: '保持冷峻重生都市感。'
    })

    expect(updated.styleConstraints).toEqual(['保持现实质感', '对话口语化', '节奏紧张-缓和交替'])
    expect(updated.characterConstraints).toEqual(['主角保持冷静', '避免冗长内心独白'])
    expect(updated.plotConstraints).toEqual(['避免金手指', '穿插过去闪回'])
    expect(updated.identifiedStyle).toBe('冷峻重生都市')
    expect(updated.stylePrompt).toBe('保持冷峻重生都市感。')
    expect(updated.name).toBe(created.name)
    expect(updated.sentencePatterns).toEqual(['短句'])
  })

  it('update normalizes whitespace and filters empty strings in arrays', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const created = await service.create(makeStyleInput('测试', { styleConstraints: [] }))

    const updated = await service.update(created.id, {
      styleConstraints: ['  保留 ', '', '  ', ' 也保留 '],
      name: '  前后空格  '
    })
    expect(updated.styleConstraints).toEqual(['保留', '也保留'])
    expect(updated.name).toBe('前后空格')
  })

  it('update throws STYLE_UPDATE_EMPTY_PATCH when no field provided', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    const created = await service.create(makeStyleInput('测试'))
    await expect(service.update(created.id, {})).rejects.toThrow(/STYLE_UPDATE_EMPTY_PATCH/)
  })

  it('update throws STYLE_PROFILE_NOT_FOUND for unknown id', async () => {
    const service = new StyleProfileService(projectService, mockLlm('{}'))
    await expect(service.update('non-existent', { name: 'x' })).rejects.toThrow(
      /STYLE_PROFILE_NOT_FOUND/
    )
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
        styleConstraints: ['避免华丽修辞'],
        characterConstraints: ['保持主角冷静'],
        plotConstraints: ['避免巧合推进'],
        stylePrompt: '保持冷峻。'
      })}\n结束`
    )
    expect(result.identifiedStyle).toBe('冷峻')
    expect(result.styleConstraints).toEqual(['避免华丽修辞'])
    expect(result.characterConstraints).toEqual([])
    expect(result.plotConstraints).toEqual([])
  })
})
