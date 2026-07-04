import { randomUUID } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
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
  private readonly repo: StyleProfileRepository

  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly stylesFile?: string
  ) {
    const filePath = stylesFile || join(tmpdir(), `styles-${randomUUID()}.json`)
    this.repo = new StyleProfileRepository(filePath)
  }

  async list(projectId?: string | null): Promise<StyleProfile[]> {
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
      styleConstraints: normalizeList(input.styleConstraints),
      characterConstraints: normalizeList(input.characterConstraints),
      plotConstraints: normalizeList(input.plotConstraints),
      dos: normalizeList(input.dos ?? []),
      donts: normalizeList(input.donts ?? []),
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

    const hasAny =
      patch.name !== undefined ||
      patch.identifiedStyle !== undefined ||
      patch.sentencePatterns !== undefined ||
      patch.vocabularyPreferences !== undefined ||
      patch.punctuationAndRhythm !== undefined ||
      patch.narrativePerspective !== undefined ||
      patch.tone !== undefined ||
      patch.narrativeTemplates !== undefined ||
      patch.styleConstraints !== undefined ||
      patch.characterConstraints !== undefined ||
      patch.plotConstraints !== undefined ||
      patch.stylePrompt !== undefined
    if (!hasAny) {
      throw new Error('STYLE_UPDATE_EMPTY_PATCH')
    }

    const next: StyleProfile = {
      ...current,
      name: patch.name?.trim() ? patch.name.trim() : current.name,
      identifiedStyle:
        patch.identifiedStyle?.trim() ? patch.identifiedStyle.trim() : current.identifiedStyle,
      sentencePatterns:
        patch.sentencePatterns !== undefined
          ? normalizeList(patch.sentencePatterns)
          : current.sentencePatterns,
      vocabularyPreferences:
        patch.vocabularyPreferences !== undefined
          ? normalizeList(patch.vocabularyPreferences)
          : current.vocabularyPreferences,
      punctuationAndRhythm:
        patch.punctuationAndRhythm !== undefined
          ? normalizeList(patch.punctuationAndRhythm)
          : current.punctuationAndRhythm,
      narrativePerspective:
        patch.narrativePerspective !== undefined
          ? normalizeList(patch.narrativePerspective)
          : current.narrativePerspective,
      tone: patch.tone !== undefined ? normalizeList(patch.tone) : current.tone,
      narrativeTemplates:
        patch.narrativeTemplates !== undefined
          ? normalizeList(patch.narrativeTemplates)
          : current.narrativeTemplates,
      styleConstraints:
        patch.styleConstraints !== undefined
          ? normalizeList(patch.styleConstraints)
          : current.styleConstraints,
      characterConstraints:
        patch.characterConstraints !== undefined
          ? normalizeList(patch.characterConstraints)
          : current.characterConstraints,
      plotConstraints:
        patch.plotConstraints !== undefined
          ? normalizeList(patch.plotConstraints)
          : current.plotConstraints,
      stylePrompt: patch.stylePrompt?.trim() ? patch.stylePrompt.trim() : current.stylePrompt,
      updatedAt: new Date().toISOString()
    }
    data.items[index] = next
    await repo.write(data)
    return next
  }

  async delete(projectId: string | null | undefined, styleProfileId: string): Promise<void> {
    const repo = await this.getRepo(projectId)
    const data = await repo.read()
    const nextItems = data.items.filter((item) => item.id !== styleProfileId)
    if (nextItems.length === data.items.length) {
      throw new Error(`STYLE_PROFILE_NOT_FOUND: ${styleProfileId}`)
    }
    data.items = nextItems
    await repo.write(data)

    if (projectId) {
      const project = await this.projectService.getProjectData(projectId)
      if (project.defaultStyleProfileId === styleProfileId) {
        await this.projectService.updateProjectData(projectId, {
          defaultStyleProfileId: undefined
        })
      }
    }
  }

  async extract(
    projectId: string | null | undefined,
    sampleText: string,
    name?: string,
    opts: GenerateOptions = {}
  ): Promise<StyleAnalysisResult> {
    const normalizedSample = normalizeSample(sampleText)
    const project = projectId ? await this.projectService.getProjectData(projectId) : null
    const projectName = project?.name ?? '文风库'
    const genre = project?.genre ?? '通用'
    const prompt = buildStyleExtractPrompt(projectName, genre, normalizedSample, name)
    const raw = await this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'styleExtract', projectId: projectId ?? undefined }
    })
    return parseStyleAnalysisResult(raw)
  }

  async getById(projectId: string, styleProfileId?: string | null): Promise<StyleProfile | null> {
    if (!styleProfileId) return null
    const items = await this.list(projectId)
    return items.find((item) => item.id === styleProfileId) ?? null
  }

  /**
   * 获取文风仓库。当前文风为全局共享（所有项目共用同一 styles.json），
   * projectId 仅用于 delete/extract 的项目元数据联动（如清除默认文风引用），不影响仓库选择。
   * 若未来需要按项目隔离文风，可在此处按 projectId 返回不同的 repository。
   */
  private async getRepo(_projectId?: string | null): Promise<StyleProfileRepository> {
    return this.repo
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
    '- 识别这是什么文风',
    '- 总结句式特征',
    '- 总结词汇偏好',
    '- 总结标点与节奏',
    '- 总结叙事视角与语气',
    '- 总结基础叙事模板',
    '- 只提炼可跨书复用的文风写作约束（styleConstraints）',
    '- 不要提取人物性格、人物关系、角色行为准则、剧情设定、题材套路、具体桥段等人设或剧情约束',
    '- 如果样文里出现强绑定于角色或作品设定的信息，忽略它们，不要写进输出',
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
    '  "styleConstraints": string[],',
    '  "characterConstraints": string[],',
    '  "plotConstraints": string[],',
    '  "stylePrompt": string',
    '}',
    '- styleConstraints 给 3-8 条简洁、具体、可执行的文风约束',
    '- characterConstraints 必须返回空数组 []',
    '- plotConstraints 必须返回空数组 []',
    '- stylePrompt 只描述文风层面的模仿要求与禁忌，不要写角色设定或剧情推进规则',
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
  const styleC = normalizeUnknownList(value.styleConstraints)
  const dos = normalizeUnknownList(value.dos)
  const donts = normalizeUnknownList(value.donts)
  const fallbackStyle = [...styleC]
  if (fallbackStyle.length === 0) {
    if (dos.length > 0) fallbackStyle.push(...dos)
    if (donts.length > 0) fallbackStyle.push(...donts)
  }

  const result: StyleAnalysisResult = {
    identifiedStyle: typeof value.identifiedStyle === 'string' ? value.identifiedStyle.trim() : '',
    sentencePatterns: normalizeUnknownList(value.sentencePatterns),
    vocabularyPreferences: normalizeUnknownList(value.vocabularyPreferences),
    punctuationAndRhythm: normalizeUnknownList(value.punctuationAndRhythm),
    narrativePerspective: normalizeUnknownList(value.narrativePerspective),
    tone: normalizeUnknownList(value.tone),
    narrativeTemplates: normalizeUnknownList(value.narrativeTemplates),
    styleConstraints: fallbackStyle,
    characterConstraints: [],
    plotConstraints: [],
    dos,
    donts,
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
