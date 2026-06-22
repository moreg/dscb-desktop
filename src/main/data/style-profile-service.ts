import { randomUUID } from 'crypto'
import type { GenerateOptions, LlmService } from './llm-service'
import { ProjectService } from './project-service'
import { StyleProfileRepository } from './style-profile-repository'
import type {
  CreateStyleProfileInput,
  StyleAnalysisResult,
  StyleProfile,
  UpdateStyleProfileInput
} from '../../shared/types'

const MIN_SAMPLE_LENGTH = 300
const MAX_SAMPLE_LENGTH = 20_000

export class StyleProfileService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  async list(projectId: string): Promise<StyleProfile[]> {
    const repo = await this.getRepo(projectId)
    const data = await repo.read()
    return data.items
  }

  async create(projectId: string, input: CreateStyleProfileInput): Promise<StyleProfile> {
    const repo = await this.getRepo(projectId)
    const data = await repo.read()
    const now = new Date().toISOString()
    const profile: StyleProfile = {
      id: randomUUID(),
      name: input.name.trim(),
      sourceType: input.sourceType,
      sampleText: input.sampleText,
      identifiedStyle: input.identifiedStyle,
      sentencePatterns: normalizeList(input.sentencePatterns),
      vocabularyPreferences: normalizeList(input.vocabularyPreferences),
      punctuationAndRhythm: normalizeList(input.punctuationAndRhythm),
      narrativePerspective: normalizeList(input.narrativePerspective),
      tone: normalizeList(input.tone),
      narrativeTemplates: normalizeList(input.narrativeTemplates),
      dos: normalizeList(input.dos),
      donts: normalizeList(input.donts),
      stylePrompt: input.stylePrompt.trim(),
      createdAt: now,
      updatedAt: now
    }
    data.items.push(profile)
    await repo.write(data)
    return profile
  }

  async update(
    projectId: string,
    styleProfileId: string,
    patch: UpdateStyleProfileInput
  ): Promise<StyleProfile> {
    const repo = await this.getRepo(projectId)
    const data = await repo.read()
    const index = data.items.findIndex((item) => item.id === styleProfileId)
    if (index < 0) throw new Error(`STYLE_PROFILE_NOT_FOUND: ${styleProfileId}`)
    const current = data.items[index]
    const next: StyleProfile = {
      ...current,
      name: patch.name?.trim() ? patch.name.trim() : current.name,
      updatedAt: new Date().toISOString()
    }
    data.items[index] = next
    await repo.write(data)
    return next
  }

  async delete(projectId: string, styleProfileId: string): Promise<void> {
    const repo = await this.getRepo(projectId)
    const data = await repo.read()
    const nextItems = data.items.filter((item) => item.id !== styleProfileId)
    if (nextItems.length === data.items.length) {
      throw new Error(`STYLE_PROFILE_NOT_FOUND: ${styleProfileId}`)
    }
    data.items = nextItems
    await repo.write(data)

    const project = await this.projectService.getProjectData(projectId)
    if (project.defaultStyleProfileId === styleProfileId) {
      await this.projectService.updateProjectData(projectId, {
        defaultStyleProfileId: undefined
      })
    }
  }

  async extract(
    projectId: string,
    sampleText: string,
    name?: string,
    opts: GenerateOptions = {}
  ): Promise<StyleAnalysisResult> {
    const normalizedSample = normalizeSample(sampleText)
    const project = await this.projectService.getProjectData(projectId)
    const prompt = buildStyleExtractPrompt(project.name, project.genre, normalizedSample, name)
    const raw = await this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'styleExtract', projectId }
    })
    return parseStyleAnalysisResult(raw)
  }

  async getById(projectId: string, styleProfileId?: string | null): Promise<StyleProfile | null> {
    if (!styleProfileId) return null
    const items = await this.list(projectId)
    return items.find((item) => item.id === styleProfileId) ?? null
  }

  private async getRepo(projectId: string): Promise<StyleProfileRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new StyleProfileRepository(dir)
  }
}

function normalizeSample(sampleText: string): string {
  const trimmed = sampleText.trim()
  if (trimmed.length < MIN_SAMPLE_LENGTH) {
    throw new Error(`STYLE_SAMPLE_TOO_SHORT: 至少需要 ${MIN_SAMPLE_LENGTH} 个字符`)
  }
  if (trimmed.length <= MAX_SAMPLE_LENGTH) return trimmed
  return trimmed.slice(0, MAX_SAMPLE_LENGTH)
}

function normalizeList(values: string[]): string[] {
  return values.map((item) => item.trim()).filter(Boolean)
}

function buildStyleExtractPrompt(
  projectName: string,
  genre: string | undefined,
  sampleText: string,
  name?: string
): string {
  return [
    '请分析下面的中文小说样文，并提取可复用的文风画像。',
    `项目：${projectName}`,
    `题材参考：${genre ?? '未指定'}`,
    name?.trim() ? `期望文风名：${name.trim()}` : '',
    '',
    '分析目标：',
    '- 识别是什么文风',
    '- 总结句式特征',
    '- 总结词汇偏好',
    '- 总结标点与节奏',
    '- 总结叙事视角与语气',
    '- 总结基础叙事模板',
    '- 提炼成可直接用于续写的 stylePrompt',
    '',
    '输出要求：',
    '- 只输出严格 JSON 对象，不要 markdown，不要解释',
    '- 字段必须完整：',
    '{',
    '  "identifiedStyle": string,',
    '  "sentencePatterns": string[],',
    '  "vocabularyPreferences": string[],',
    '  "punctuationAndRhythm": string[],',
    '  "narrativePerspective": string[],',
    '  "tone": string[],',
    '  "narrativeTemplates": string[],',
    '  "dos": string[],',
    '  "donts": string[],',
    '  "stylePrompt": string',
    '}',
    '- 每个数组给 3-8 条高价值结论，简洁具体，可执行',
    '- stylePrompt 必须是写给续写模型的约束说明，强调应模仿的句式、词汇、节奏、视角、语气，以及不要做什么',
    '',
    '------ 样文开始 ------',
    sampleText,
    '------ 样文结束 ------'
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseStyleAnalysisResult(raw: string): StyleAnalysisResult {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('STYLE_EXTRACT_INVALID_JSON')
  let obj: unknown
  try {
    obj = JSON.parse(match[0])
  } catch {
    throw new Error('STYLE_EXTRACT_INVALID_JSON')
  }

  const value = obj as Partial<StyleAnalysisResult>
  const result: StyleAnalysisResult = {
    identifiedStyle: typeof value.identifiedStyle === 'string' ? value.identifiedStyle.trim() : '',
    sentencePatterns: normalizeUnknownList(value.sentencePatterns),
    vocabularyPreferences: normalizeUnknownList(value.vocabularyPreferences),
    punctuationAndRhythm: normalizeUnknownList(value.punctuationAndRhythm),
    narrativePerspective: normalizeUnknownList(value.narrativePerspective),
    tone: normalizeUnknownList(value.tone),
    narrativeTemplates: normalizeUnknownList(value.narrativeTemplates),
    dos: normalizeUnknownList(value.dos),
    donts: normalizeUnknownList(value.donts),
    stylePrompt: typeof value.stylePrompt === 'string' ? value.stylePrompt.trim() : ''
  }

  if (!result.identifiedStyle || !result.stylePrompt) {
    throw new Error('STYLE_EXTRACT_INCOMPLETE')
  }
  return result
}

function normalizeUnknownList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
}
