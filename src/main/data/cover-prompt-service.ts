import { CharacterRepository } from './character-repository'
import { createHash } from 'crypto'
import { analyzeCoverVisualDirection } from './cover-visual-direction'
import { applyCoverChannelToCharacter, applyCoverChannelToStyle, resolveCoverChannelComposition } from './cover-channel'
import {
  buildCoverPrompt,
  compileCoverLearningRules,
  COVER_STYLE_MEDIUM_REQUIREMENTS,
  COVER_STYLE_PRESETS,
  inferGenre,
  migrateBuiltinCoverStyle,
  type CoverStyleDefinition
} from './skill-prompts/cover/cover-styles'
import type { ChapterService } from './chapter-service'
import type { LlmService } from './llm-service'
import type { OutlineService } from './outline-service'
import type { ProjectService } from './project-service'
import type { CoverLearningLibraryService } from './cover-learning-library'
import type {
  Character,
  CoverComposition,
  CoverGenre,
  CoverPromptDraft,
  CoverScene,
  CoverLearningContext,
  ExtractCoverPromptInput
} from '../../shared/types'

/** 合法题材（校验模型返回值） */
const GENRES: readonly CoverGenre[] = [
  'xianxia',
  'urban',
  'ancient_romance',
  'modern_romance',
  'mystery',
  'scifi',
  'western_fantasy',
  'historical',
  'supernatural',
  'light_novel'
]

/** 合法构图 */
const COMPOSITIONS: readonly CoverComposition[] = ['closeup', 'fullbody', 'scene', 'duo']

/**
 * 提炼结果的 JSON Schema。
 *
 * 传给支持结构化输出的 provider（目前是 grok CLI 的 `--json-schema`），
 * 由服务端强制约束返回形状，省掉「模型多说两句话导致解析失败」这类失败。
 * 不支持的 provider 会忽略它 —— 所以提示词里的 JSON 格式要求必须保留，
 * parseDraftJson 的容错也必须保留。
 *
 * 字段名与枚举保持稳定，说明明确要求中文画面描述。
 * 经 argv 下发时由 runner 的 toAsciiJson 转义，兼容 Windows 命令行。
 */
export const COVER_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    genre: { type: 'string', enum: [...GENRES] },
    composition: { type: 'string', enum: [...COMPOSITIONS] },
    characterDesc: {
      type: 'string',
      description: '使用自然简体中文描述人物外貌、服饰、神态和手持物；composition 为 scene 时留空。'
    },
    backgroundDesc: { type: 'string', description: '使用自然简体中文描述具体地点与环境细节，例如雪山脚下破旧的石堡。' },
    colorPalette: { type: 'string', description: '使用自然简体中文描述主色和点缀色，例如铁灰为主、暗红点缀。' },
    lighting: { type: 'string', description: '使用自然简体中文描述光源、方向和氛围，例如左侧冷月光照亮残破城墙。' },
    keyProps: { type: 'string', description: '使用自然简体中文描述标志性道具或符号，没有则留空。' },
    styleHintZh: { type: 'string', description: '使用自然简体中文，以逗号分隔的短语概括风格，供作者调整。' },
    summaryZh: { type: 'string', description: '使用自然简体中文，用一句话概括封面画面。' }
  },
  required: [
    'genre',
    'composition',
    'characterDesc',
    'backgroundDesc',
    'colorPalette',
    'lighting',
    'keyProps',
    'styleHintZh',
    'summaryZh'
  ],
  additionalProperties: false
} as const

/** 送进模型的素材上限，防止长篇把上下文撑爆 */
const MAX_CHARACTERS = 4
const MAX_DETAILED_OUTLINES = 5
const MAX_CHAPTER_EXCERPT = 1200
const MAX_SYNOPSIS = 2000

/** 人物卡里可能承载外貌信息的字段名（rawFields / customFields 是自由键值） */
const APPEARANCE_KEYS = [
  '外貌',
  '外形',
  '形象',
  '长相',
  '容貌',
  '穿着',
  '服饰',
  '衣着',
  '装扮',
  '标志',
  '气质',
  '武器',
  '法宝',
  '道具'
]

/** 主角优先级关键词（role / tags 命中即视为主角） */
const PROTAGONIST_HINTS = ['主角', '主人公', '男主', '女主', '主视角']

/**
 * 封面提示词提炼服务。
 *
 * 和 CoverService 分开：这一步只调**文本**模型，读大纲/人物卡/正文提炼画面要素，
 * 不碰图像 API。因此没有配置图像 Key 的用户也能先把提示词调好，
 * 且可以走 codex / grok CLI 这类靠本机登录、无需 API Key 的 provider。
 *
 * 产出 CoverPromptDraft：题材 + 构图 + 中文画面要素 + 中文风格补充，
 * 由 CoverService.buildCoverPrompt 逐字段覆盖题材模板。
 */
export class CoverPromptService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly outlineService: OutlineService,
    private readonly chapterService: ChapterService,
    private readonly learningLibrary?: CoverLearningLibraryService
  ) {}

  /**
   * 读项目素材 → 调文本模型提炼画面要素 → 拼成完整中文提示词。
   *
   * 结构化的画面要素只是中间产物：拼完就丢，界面拿到的是可直接编辑的整段提示词。
   * 拆成字段问模型是为了让它逐项想清楚（人物/场景/色调/光效），
   * 比让它一口气写一大段更不容易漏要素。
   *
   * @throws COVER_PROMPT_NO_MATERIAL 项目里没有任何可提炼的内容
   */
  async extract(
    input: ExtractCoverPromptInput,
    signal?: AbortSignal
  ): Promise<CoverPromptDraft> {
    const material = await this.collectMaterial(input.projectId)
    if (material.blocks.length === 0) {
      throw new Error(
        'COVER_PROMPT_NO_MATERIAL: 项目里还没有简介、大纲、人物卡或正文，无法提炼封面提示词'
      )
    }

    const loadedLibrary = this.learningLibrary ? await this.learningLibrary.load() : undefined
    const explicitStyle = input.stylePreset && input.stylePreset !== 'auto'
      ? loadedLibrary?.library.styles[input.stylePreset] ?? COVER_STYLE_PRESETS[input.stylePreset]
      : undefined
    const instruction = this.buildExtractionPrompt(material.blocks.join('\n\n'), input, explicitStyle)
    const raw = await this.llm.generateStream(instruction, {
      signal,
      meta: { feature: 'coverPrompt', projectId: input.projectId },
      // 支持结构化输出的 provider 会强约束形状；不支持的靠提示词 + parseDraftJson 兜底
      jsonSchema: COVER_DRAFT_SCHEMA
    })

    const parsed = parseDraftJson(raw)
    if (!parsed) {
      throw new Error('COVER_PROMPT_PARSE_FAILED: 模型未返回可解析的 JSON，请重试或换一个模型')
    }

    // 题材：用户锁定 > 模型判定 > 书名关键词兜底
    const genre =
      input.genreOverride ??
      (GENRES.includes(parsed.genre as CoverGenre)
        ? (parsed.genre as CoverGenre)
        : inferGenre(input.bookName || material.bookName))

    // 构图：用户锁定 > 模型判定 > closeup 兜底
    const learned = loadedLibrary && this.learningLibrary
      ? this.learningLibrary.resolveStyle(loadedLibrary.library, input.stylePreset, genre)
      : undefined
    const selectedPreset = learned?.definition ?? explicitStyle
    const direction = input.extraHint?.trim() ?? ''
    const visual = analyzeCoverVisualDirection(direction)
    const modelComposition = COMPOSITIONS.includes(parsed.composition as CoverComposition)
      ? (parsed.composition as CoverComposition)
      : undefined
    const requestedComposition = visual.noPeople === true && input.channel
      ? input.compositionOverride ?? modelComposition ?? 'closeup'
      : visual.composition ?? input.compositionOverride ?? modelComposition ?? 'closeup'
    const composition = input.channel && requestedComposition === 'duo' ? 'duo' : resolveCoverChannelComposition(visual.composition ?? (visual.noPeople === true
      ? 'scene'
      : selectedPreset?.noPeople && visual.noPeople !== false
        ? 'scene'
        : input.compositionOverride ?? modelComposition ?? 'closeup'), input.channel)

    const characterDesc = cleanField(parsed.characterDesc)
    const scene: CoverScene = {
      characterDesc: characterDesc ? applyCoverChannelToCharacter(characterDesc, input.channel, composition) : undefined,
      backgroundDesc: cleanField(parsed.backgroundDesc),
      colorPalette: cleanField(parsed.colorPalette),
      lighting: cleanField(parsed.lighting),
      keyProps: cleanField(parsed.keyProps)
    }
    const missing = [!scene.backgroundDesc ? '背景场景' : '', composition !== 'scene' && !scene.characterDesc ? '人物外貌与服饰' : ''].filter(Boolean)
    if (missing.length) {
      throw new Error(`COVER_PROMPT_INCOMPLETE: 模型未返回必要画面字段（${missing.join('、')}），已保留当前提示词，请重新提炼；不会替换成通用题材人物。`)
    }
    const rawStyleHint = cleanField(parsed.styleHintZh)
    const styleHint = rawStyleHint ? applyCoverChannelToStyle(rawStyleHint, input.channel) : undefined
    const rules = loadedLibrary && this.learningLibrary
      ? compileCoverLearningRules(this.learningLibrary.getRulesForGenre(loadedLibrary.library, genre), input.typography)
      : []
    const learningContext: CoverLearningContext | undefined = loadedLibrary ? {
      libraryVersion: `${loadedLibrary.library.updatedAt}@${createHash('sha256').update(JSON.stringify([learned?.definition, rules])).digest('hex').slice(0, 12)}`,
      rules,
      sourceSampleCount: loadedLibrary.library.source.sampleCount,
      resolvedStylePreset: learned?.key ?? input.stylePreset ?? 'auto',
      sources: [...material.sources, ...new Set((loadedLibrary.summary.rules ?? [])
        .filter((rule) => rules.includes(rule.text))
        .map((rule) => `${rule.source}${rule.genre ? `:${rule.genre}` : ''}${rule.evidence?.length ? ` · ${rule.evidence.slice(0, 2).join(', ')}` : ''}`))].slice(0, 30)
    } : undefined
    const prompt = buildCoverPrompt({
      bookName: input.bookName,
      authorName: input.authorName,
      platform: input.platform,
      genre,
      composition,
      channel: input.channel,
      stylePreset: learned?.key ?? input.stylePreset,
      learningPreset: learned?.definition,
      learningRules: rules,
      typography: input.typography,
      styleHint,
      ...(direction ? { visualDirection: direction } : {}),
      scene
    })

    return {
      prompt,
      genre,
      composition,
      scene,
      styleHint,
      learningContext,
      summary: applyCoverChannelToStyle(cleanField(parsed.summaryZh) ?? '', input.channel),
      sources: material.sources
    }
  }

  /* =========================================================
     素材采集
     ========================================================= */

  /**
   * 汇总项目内可用素材。任一环节缺失都跳过，不阻断整体提炼
   * （新项目往往只有简介，老项目才有正文）。
   */
  private async collectMaterial(
    projectId: string
  ): Promise<{ bookName: string; blocks: string[]; sources: string[] }> {
    const blocks: string[] = []
    const sources: string[] = []
    let bookName = ''

    // 项目元信息
    try {
      const project = await this.projectService.getProjectData(projectId)
      bookName = project.name ?? ''
      const meta = [
        `书名：${project.name}`,
        project.genre ? `题材标签：${project.genre}` : '',
        project.description ? `简介：${project.description}` : ''
      ].filter(Boolean)
      blocks.push(`【作品信息】\n${meta.join('\n')}`)
      if (project.description) sources.push('作品简介')
    } catch (err) {
      console.warn('[cover-prompt] 读取项目信息失败:', err)
    }

    // 主线大纲
    try {
      const main = await this.outlineService.getMain(projectId)
      const parts = [
        main?.synopsis ? `故事梗概：${truncate(main.synopsis, MAX_SYNOPSIS)}` : '',
        main?.theme ? `主题：${main.theme}` : '',
        main?.mainLine ? `主线：${main.mainLine}` : ''
      ].filter(Boolean)
      if (parts.length > 0) {
        blocks.push(`【大纲】\n${parts.join('\n')}`)
        sources.push('大纲')
      }
    } catch (err) {
      console.warn('[cover-prompt] 读取大纲失败:', err)
    }

    // 开篇细纲（前几章最能代表封面要传达的「第一印象」）
    try {
      const details = await this.outlineService.listDetailed(projectId)
      const head = details.slice(0, MAX_DETAILED_OUTLINES)
      if (head.length > 0) {
        const text = head
          .map((d) =>
            [
              `第${d.chapterNumber}章 ${d.title ?? ''}`.trim(),
              d.plotSummary ? `  剧情：${d.plotSummary}` : '',
              d.coolPoint ? `  爽点：${d.coolPoint}` : '',
              d.hook ? `  钩子：${d.hook}` : ''
            ]
              .filter(Boolean)
              .join('\n')
          )
          .join('\n')
        blocks.push(`【开篇细纲】\n${text}`)
        sources.push(`开篇细纲 ${head.length} 章`)
      }
    } catch (err) {
      console.warn('[cover-prompt] 读取细纲失败:', err)
    }

    // 人物卡（主角优先）
    try {
      const dir = await this.projectService.resolveDir(projectId)
      const characters = await new CharacterRepository(dir).list()
      const picked = pickProtagonists(characters, MAX_CHARACTERS)
      if (picked.length > 0) {
        blocks.push(`【人物卡】\n${picked.map(formatCharacter).join('\n\n')}`)
        sources.push(`人物卡 ${picked.length} 张`)
      }
    } catch (err) {
      console.warn('[cover-prompt] 读取人物卡失败:', err)
    }

    // 第一章开头（最能体现实际笔下的画面感与时代背景）
    try {
      const chapters = await this.chapterService.listChapters(projectId)
      const first = chapters.find((c) => c.wordCount > 0) ?? chapters[0]
      if (first) {
        const { content } = await this.chapterService.getChapter(projectId, first.chapterNumber)
        const excerpt = truncate(content.trim(), MAX_CHAPTER_EXCERPT)
        if (excerpt) {
          blocks.push(`【第${first.chapterNumber}章开头节选】\n${excerpt}`)
          sources.push(`第 ${first.chapterNumber} 章正文`)
        }
      }
    } catch (err) {
      console.warn('[cover-prompt] 读取正文失败:', err)
    }

    return { bookName, blocks, sources }
  }

  /* =========================================================
     提示词
     ========================================================= */

  /**
   * 构建提炼指令。要求严格 JSON，所有画面与说明字段都用自然中文，
   * 直接进入可编辑的生图提示词。
   */
  private buildExtractionPrompt(
    material: string,
    input: ExtractCoverPromptInput,
    learnedStyle?: CoverStyleDefinition
  ): string {
    const genreLine = input.genreOverride
      ? `题材已由用户锁定为 "${input.genreOverride}"，genre 字段原样返回该值。`
      : `从下列题材中选最贴切的一个填入 genre：${GENRES.join(' / ')}。`
    const selectedStyle = learnedStyle ? migrateBuiltinCoverStyle(input.stylePreset, learnedStyle) : (input.stylePreset && input.stylePreset !== 'auto'
      ? COVER_STYLE_PRESETS[input.stylePreset]
      : undefined)
    const direction = input.extraHint?.trim() ?? ''
    const visual = analyzeCoverVisualDirection(direction)
    const styleLine = selectedStyle
      ? visual.medium
        ? `界面当前视觉风格是“${selectedStyle.label}”（${selectedStyle.description}），只给方向没写到的细节做参考，优先级低于作者画面方向。`
        : `视觉风格已锁定为“${selectedStyle.label}”：${selectedStyle.description} 除作者方向明确修改的属性外，配色、光线和画面组织符合该风格，不要另选画风。`
      : '视觉风格未锁定，请按作品题材和目标平台选择最合适的商业封面表达。'
    const baseMediumRequirement = !visual.medium && input.stylePreset
      ? COVER_STYLE_MEDIUM_REQUIREMENTS[input.stylePreset]
      : undefined
    const mediumRequirement = visual.subjectFields.length && baseMediumRequirement
      ? baseMediumRequirement.replace(/Preserve the story characters ages, identities and period-appropriate clothing|保留故事(?:人物|角色)的年龄、身份和符合时代的服饰/gi,
        '保留作者方向未明确修改的全部人物属性')
      : baseMediumRequirement
    const mediumLine = mediumRequirement
      ? `\n   媒介要求：${mediumRequirement}。所有画面字段与 styleHintZh 都必须遵守该媒介，不得因题材或平台改成另一种画风。${visual.subjectFields.length ? '只修改作者方向明确指定的角色属性，其余年龄、身份、体型和服饰仍遵循小说资料。' : '人物年龄、身份、体型和服饰遵循小说资料；更换画风不等于更换角色，不要擅自改成少年、学生、Q版人物或现代装。'}`
      : ''
    const noPeopleLine = !input.channel && (visual.noPeople === true || (visual.noPeople !== false && selectedStyle?.noPeople))
      ? '当前风格要求无人物，composition 必须返回 scene，characterDesc 必须留空。'
      : ''
    const requestedComposition = visual.noPeople === true && input.channel
      ? input.compositionOverride
      : visual.composition ?? input.compositionOverride
    const lockedComposition = requestedComposition
      ? resolveCoverChannelComposition(requestedComposition, input.channel)
      : input.channel && selectedStyle?.noPeople ? 'closeup' : undefined
    const channelBlock = input.channel
      ? `【封面主体选择，人物性别和存在的最终优先级】
用户明确选择${input.channel === 'male' ? '男频，封面主体必须是男性（male）' : '女频，封面主体必须是女性（female）'}，人物性别和可见存在优先于下方资料、方向及预设。只校正冲突的性别或人物缺席，其余年龄、族裔、身份、身体特征、服饰、道具、姿态、环境和画风保留，不套读者或题材刻板印象。无人物要求回退 closeup；duo 保留，两位主体均为${input.channel === 'male' ? '男性' : '女性'}并具体描述。characterDesc 不得留空；styleHintZh 与 summaryZh 同步这一主体选择。

`
      : ''
    const fieldLabels = { age: '年龄', gender: '性别', ethnicity: '族裔', identity: '身份', pose: '姿态', clothing: '服饰' }
    const directedSubjectFields = visual.subjectFields.filter((field) => !input.channel || field !== 'gender').map((field) => fieldLabels[field])
    const directionBlock = direction
      ? `【作者画面方向，仅覆盖指定维度】
${direction}
仅在明确指定的维度覆盖小说资料或预设。${input.channel ? '人物性别和存在仍服从上方频道选择。' : ''}${directedSubjectFields.length ? `它压过小说资料里的主角属性：${directedSubjectFields.join('、')}；这些已指定的属性不要改回小说主角。` : '人物未被明确更换，必须保留小说资料中的角色。'}${visual.medium ? '作者明确指定了画风，覆盖冲突的媒介锁。' : '作者没有要求更换画风，必须保持当前媒介锁。'}方向没有写到的年龄、性别、身份、姿态、服饰、构图、场景、道具和情节，仍服从已锁定的选择与小说资料。否定某画风不代表要求采用该画风。

`
      : ''
    const taskBody = direction
      ? '封面要在一眼之内传达这本书的题材与卖点。仅更改作者方向明确指定的维度；其余人物属性、画风和构图保留。场景、道具和背景仍从资料里补。'
      : `封面要在一眼之内传达这本书的题材与卖点。请判断：主角长什么样、穿什么、拿什么，站在什么场景里，整体什么色调和光线。
必须基于上面的资料，不要套用泛泛的题材模板——如果资料写了主角是断臂的中年刀客，就不要写成白衣少年剑仙。`

    return `你是中文网文封面美术指导。请阅读下面这本小说的资料，提炼出**这本书专属**的封面画面要素。

${channelBlock}${directionBlock}${material}

【任务】
${taskBody}

【约束】
1. ${genreLine}
2. ${styleLine}${mediumLine}
3. composition 从 closeup（人物特写）/ fullbody（全身动态）/ scene（纯场景无主体人物）/ duo（双人对视）中选一个。目标平台是 ${input.platform}。${noPeopleLine}${lockedComposition && !noPeopleLine ? `构图已锁定为 "${lockedComposition}"，composition 字段原样返回该值，人物姿态、取景范围和背景字段必须共同服从该构图；duo 必须具体描述两位人物。` : ''}
4. characterDesc / backgroundDesc / colorPalette / lighting / keyProps 五个字段全部用**自然简体中文**书写（它们会直接送进图像模型，并供作者阅读和修改），每项一句话，具体到可画出来的程度，不附英文翻译。JSON 字段名及 genre、composition 枚举保持上述格式。
   - characterDesc：年龄、性别、发型、服饰材质与颜色、神态、手持物。
   - backgroundDesc：具体地点与环境细节，例如“雪山脚下的残破石堡，城墙上积着薄雪”，不要只写“幻想世界”。
   - keyProps：这本书的标志性道具或符号，没有就留空字符串。
   - composition 选 scene 时，characterDesc 留空字符串。
5. styleHintZh 用**中文**，逗号分隔的短语，概括风格取向，供作者在界面上继续微调。例："偏暗黑系，冷色调，主角黑衣断刀，背景残破城墙"。
6. summaryZh 用**中文**，一句话描述这张封面画的是什么。
7. 画面里不要出现书名、作者名以外的文字。

【输出】
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{"genre":"","composition":"","characterDesc":"","backgroundDesc":"","colorPalette":"","lighting":"","keyProps":"","styleHintZh":"","summaryZh":""}`
  }
}

/* =========================================================
   纯函数（导出供单测）
   ========================================================= */

/** 模型原始返回中的字段（全部当 unknown，解析后再校验） */
interface RawDraft {
  genre?: unknown
  composition?: unknown
  characterDesc?: unknown
  backgroundDesc?: unknown
  colorPalette?: unknown
  lighting?: unknown
  keyProps?: unknown
  styleHintZh?: unknown
  summaryZh?: unknown
}

/**
 * 从模型输出里抠出 JSON 对象。
 * 兼容三种常见形态：裸 JSON、```json 围栏、前后带解释文字。
 * @returns 解析成功的对象；失败返回 null
 */
export function parseDraftJson(raw: string): RawDraft | null {
  if (!raw) return null
  // 去 markdown 围栏
  const unfenced = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(unfenced.slice(start, end + 1)) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return obj as RawDraft
  } catch {
    return null
  }
}

/** 非空字符串才留下，顺带去掉模型爱加的首尾引号 */
function cleanField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^["'"']|["'"']$/g, '').trim()
  return trimmed ? trimmed : undefined
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/** 主角排前面，再按原顺序补齐到 limit 张 */
export function pickProtagonists(characters: Character[], limit: number): Character[] {
  const isProtagonist = (c: Character): boolean => {
    const haystack = [c.role ?? '', ...(c.tags ?? [])].join(' ')
    return PROTAGONIST_HINTS.some((h) => haystack.includes(h))
  }
  const leads = characters.filter(isProtagonist)
  const rest = characters.filter((c) => !isProtagonist(c))
  return [...leads, ...rest].slice(0, limit)
}

/** 人物卡 → 纯文本。优先保留外貌类字段，那才是画封面用得上的 */
function formatCharacter(c: Character): string {
  const lines = [`- ${c.name}${c.role ? `（${c.role}）` : ''}`]
  if (c.identity) lines.push(`  身份：${c.identity}`)
  if (c.personality) lines.push(`  性格：${c.personality}`)
  if (c.abilities) lines.push(`  能力：${c.abilities}`)
  if (c.synopsis) lines.push(`  简介：${truncate(c.synopsis, 300)}`)

  const extra = { ...(c.rawFields ?? {}), ...(c.customFields ?? {}) }
  for (const [key, value] of Object.entries(extra)) {
    if (!APPEARANCE_KEYS.some((k) => key.includes(k))) continue
    const text = Array.isArray(value) ? value.join('；') : value
    if (text?.trim()) lines.push(`  ${key}：${truncate(text.trim(), 200)}`)
  }
  return lines.join('\n')
}
