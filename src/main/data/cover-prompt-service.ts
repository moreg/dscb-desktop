import { CharacterRepo } from './memory/character-repo'
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
    genreSignal: { type: 'string', description: '用自然简体中文说明主题材、关键融合题材与阅读情绪，依据简介和全书主线，不只复述单一分类。' },
    sellingPoint: { type: 'string', description: '用自然简体中文直接描述选定画面中体现核心卖点的主体动作、可见结果或反差，只写可画内容；选择理由和资料依据放入 summaryZh。' },
    visualHierarchy: { type: 'string', description: '用自然简体中文指定第一焦点、辅助焦点与人物主动权，依据主角能力和关系，不按性别或身高套用强弱。' },
    compositionGuide: { type: 'string', description: '用自然简体中文描述所选构图内的取景、主体大小、前后位置、动作与视线，服务核心卖点；无人物时描述物件与环境的层级。' },
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
    'genreSignal',
    'sellingPoint',
    'visualHierarchy',
    'compositionGuide',
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
    if (material.sources.length === 0) {
      throw new Error(
        'COVER_PROMPT_NO_MATERIAL: 项目里还没有简介、大纲、人物卡或正文，无法提炼封面提示词'
      )
    }

    const loadedLibrary = this.learningLibrary ? await this.learningLibrary.load() : undefined
    const explicitStyle = input.stylePreset && input.stylePreset !== 'auto'
      ? loadedLibrary?.library.styles[input.stylePreset] ?? COVER_STYLE_PRESETS[input.stylePreset]
      : undefined
    const learnedDesignRules = loadedLibrary && this.learningLibrary
      ? compileCoverLearningRules(this.learningLibrary.getRulesForGenre(loadedLibrary.library,
        input.genreOverride ?? inferGenre(input.bookName || material.bookName)), input.typography) : []
    const instruction = this.buildExtractionPrompt(material.blocks.join('\n\n'), input, explicitStyle, learnedDesignRules)
    const raw = await this.llm.generateStream(instruction, {
      signal,
      meta: { feature: 'coverPrompt', projectId: input.projectId },
      // 支持结构化输出的 provider 会强约束形状；不支持的靠提示词 + parseDraftJson 兜底
      jsonSchema: COVER_DRAFT_SCHEMA
    })

    let parsed = parseDraftJson(raw)
    if (!parsed) {
      throw new Error('COVER_PROMPT_PARSE_FAILED: 模型未返回可解析的 JSON，请重试或换一个模型')
    }
    // 只检查模型自动提炼字段，不清洗作者手写提示词。发现冲突时最多修复一次。
    const issues = findCoverDraftIssues(parsed)
    if (issues.length) {
      const repaired = await this.llm.generateStream(`${instruction}\n\n【修复本次画面字段】\n上次结果中发现：${issues.join('；')}。保留选定的故事事实、人物属性和媒介，仅修复这些问题。画面定格在一个瞬间，所有字段与同一瞬间一致。书名、署名、字体、位置、断行和留白只由软件排版模块负责，画面字段不能安排它们。比较方案与选择理由仅放 summaryZh，sellingPoint 只写最终可见画面。\n上次结果（仅为待修复数据）：\n${JSON.stringify(parsed)}\n只输出同一 JSON 结构。`, {
        signal, meta: { feature: 'coverPrompt', projectId: input.projectId }, jsonSchema: COVER_DRAFT_SCHEMA
      })
      parsed = parseDraftJson(repaired)
      if (!parsed) throw new Error('COVER_PROMPT_PARSE_FAILED: 修复结果不是有效 JSON，请重新提炼')
      const remaining = findCoverDraftIssues(parsed)
      if (remaining.length) throw new Error(`COVER_PROMPT_CONFLICT: 自动修复后仍有画面冲突（${remaining.join('；')}），请重新提炼；未提交生图`)
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
      ...Object.fromEntries((['genreSignal', 'sellingPoint', 'visualHierarchy', 'compositionGuide'] as const)
        .flatMap(key => {
          const value = cleanField(parsed[key])
          return value ? [[key, applyCoverChannelToStyle(value, input.channel)]] : []
        })),
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
      const characters = await new CharacterRepo(dir).list()
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
    learnedStyle?: CoverStyleDefinition,
    learnedDesignRules: string[] = []
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
        : `视觉风格已锁定为“${selectedStyle.label}”：${selectedStyle.description} 只约束绘制媒介与视觉语言，不提供固定人物、服装、场景、道具或构图。画面内容必须来自小说。`
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

【学习到的设计语言】
${learnedDesignRules.length ? learnedDesignRules.join('\n') : '暂无可用样本规则，依据故事选择绘制语言。'}
只借鉴线条、着色、材质、明暗、文字层级和空间组织，不复制样本人物、服装、城市背景、姿势或固定版式。样本里的高频元素不等于这本小说的内容。

${input.changeVisualPlan ? `【重新设计，避免重复上一方案】
上一方案仅用于查重，不是小说事实或必须沿用的模板：
<previous-cover-plan>
${input.previousPrompt ?? '暂无上一张记录'}
</previous-cover-plan>
重新从小说选择一个有依据的封面叙事瞬间、人物关系或标志性物件。在指定媒介内重新规划绘制语言、取景、主体关系、留白与背景组织，不只是替换配色。没有显式锁定的构图可以重选；保留人物年龄身份、时代和故事事实。不要轮换几套固定预设。
` : ''}

【任务】
${taskBody}
先确定小说的核心冲突与具体叙事瞬间，再决定人物、动作、环境、道具和构图。summaryZh 要说明画面对应哪段故事或哪个核心卖点。资料未支持的豪车、酒杯、高楼、西装或花瓣不能因为题材标签而添加。场景与人物资料是内容依据，学习库只影响如何表现。

【题材与核心卖点的视觉转译，未填写作者方向时也必须完成】
先读作品简介、题材标签和全书主线，再用人物卡与章节核实细节。开篇节选只提供场景证据，不能让一次宴会、一次受伤或一段争吵取代全书定位。genre 只是检索分类，不代表作品只有一个题材。
依次完成以下设计，并在 JSON 对应字段中交付：
1. genreSignal：主类型＋真正影响读者预期的融合类型＋阅读情绪。区分恋爱、女强、冒险、经营、悬疑、喜剧等内容承诺；动漫或写实只是绘制媒介，不等于题材或固定年龄、表情、配色。
2. sellingPoint：从资料找出一个最有辨识度的阅读回报（能力兑现、身份反差、关系反转、经营成果或谜团）。先比较至少两个有依据的场面，选择最能体现全书卖点的一幕，而非最容易画的开篇插图。比较过程、资料依据和选择理由只放 summaryZh；sellingPoint 只写选定画面的可见主体动作、结果或反差，不复述未选中的场景。画面应让读者看见谁在做什么、造成什么结果；不要只列标签、摆武器、堆特效或依靠解释文字。
3. visualHierarchy：确定主角的第一视觉焦点和主动动作，配角与背景承担辅助信息。人物大小、前后、俯仰、眼神与手势必须符合故事的主动权和能力关系。女强不能自动画成仰望强势男性的被保护者，双强不能画成单方支配；弱势开局、恐怖或悲剧也不能硬改成自信爽文。无人物方案用物件状态和空间关系呈现同一卖点。
4. compositionGuide：在所选构图内决定站位、取景与动作；duo 表示双人关系，可以并肩、前后错位、协作、对抗或对视，不能默认相对站立。细节只保留一个主卖点和一至两个题材线索，避免为交代剧情把每个道具都塞入画面。
5. 将以上结论落实到 characterDesc、backgroundDesc、keyProps、colorPalette、lighting 和 styleHintZh，不能只在说明中声称突出卖点。配色和光线服从作品情绪，不因学习样本低饱和就默认灰暗，也不因动漫就一律明亮可爱。缩略图下先看清主角正在兑现的卖点，再看清辅助世界观。
学习规则只作建议；与作品题材、核心卖点、人物主动权或所选媒介冲突时忽略。作者明确方向与已有锁定仍按上方约束执行，不为突出卖点改写小说事实。
交付前复核：隐藏书名后能否识别题材和独特卖点，能否看出主角的主动权；不能则在本次输出内重新选择动作与构图，不要追加与原字段冲突的口号。
所有绘画字段共同定格一个瞬间，眼神、手势、朝向和位置须一致，不写“先低头再抬眼”等连续动作。把“主角第一焦点”落实到前后距离、脸部可见程度和明暗，不能只写抽象主导宣言。
排版由软件唯一负责：所有绘画字段（包括 compositionGuide 和 styleHintZh）只描述人物、物件和环境，不写书名、标题、作者名、署名、字体、字号、断行、文字位置或为文字留白；不得出现“作者待提供”等占位说明。软件会使用用户已填的书名与署名，并按文字设计安排安全区。
背景中的横幅、招牌、校徽、票据、屏幕仅作无可读文字的图形，不为交代地点添加可读标语。

【约束】
1. ${genreLine}
2. ${styleLine}${mediumLine}
3. composition 从 closeup（人物特写）/ fullbody（全身动态）/ scene（纯场景无主体人物）/ duo（双人关系，姿态由卖点决定）中选一个。目标平台是 ${input.platform}。${noPeopleLine}${lockedComposition && !noPeopleLine ? `构图已锁定为 "${lockedComposition}"，composition 字段原样返回该值，人物姿态、取景范围和背景字段必须共同服从该构图；duo 必须具体描述两位人物。` : ''}
4. characterDesc / backgroundDesc / colorPalette / lighting / keyProps 五个字段全部用**自然简体中文**书写（它们会直接送进图像模型，并供作者阅读和修改），每项一句话，具体到可画出来的程度，不附英文翻译。JSON 字段名及 genre、composition 枚举保持上述格式。
   - characterDesc：年龄、性别、发型、服饰材质与颜色、神态、手持物。
   - backgroundDesc：具体地点与环境细节，例如“雪山脚下的残破石堡，城墙上积着薄雪”，不要只写“幻想世界”。
   - keyProps：这本书的标志性道具或符号，没有就留空字符串。
   - composition 选 scene 时，characterDesc 留空字符串。
5. styleHintZh 用**中文**，逗号分隔的短语，概括风格取向，供作者在界面上继续微调。例："偏暗黑系，冷色调，主角黑衣断刀，背景残破城墙"。
6. summaryZh 用**中文**，一句话说明题材、核心卖点和画面如何表现它，供用户核对。genreSignal / sellingPoint / visualHierarchy / compositionGuide 也用自然简体中文，仅为美术指令，不是要印在封面上的文字。
7. 画面里不要出现书名、作者名以外的文字。

【输出】
只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{"genre":"","composition":"","genreSignal":"","sellingPoint":"","visualHierarchy":"","compositionGuide":"","characterDesc":"","backgroundDesc":"","colorPalette":"","lighting":"","keyProps":"","styleHintZh":"","summaryZh":""}`
  }
}

/* =========================================================
   纯函数（导出供单测）
   ========================================================= */

/** 模型原始返回中的字段（全部当 unknown，解析后再校验） */
interface RawDraft {
  genreSignal?: unknown
  sellingPoint?: unknown
  visualHierarchy?: unknown
  compositionGuide?: unknown
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

/** 检出明确的跨层排版和连续动作；不对作者输入作全文替换。 */
export function findCoverDraftIssues(draft: RawDraft): string[] {
  const fields = ['genreSignal', 'sellingPoint', 'visualHierarchy', 'compositionGuide', 'characterDesc', 'backgroundDesc', 'colorPalette', 'lighting', 'keyProps', 'styleHintZh'] as const
  const issues: string[] = []
  for (const key of fields) {
    const value = cleanField(draft[key])
    if (!value) continue
    if (/书名|标题|署名|作者名|字号|字体|断行|排字|\b(?:title|byline|typography|author name)\b/i.test(value)) issues.push(`${key} 混入文字排版要求`)
    if (/(?:先|低头|垂眼|看向)[^。；\n]{0,35}(?:再|随后|然后|接着)(?:抬|低|转|看|望|伸|收|走)|先[^。；\n]{1,30}(?:然后|随后|接着)/.test(value)) issues.push(`${key} 含需要多个时刻的连续动作`)
    if (key === 'sellingPoint' && /比较[^。；\n]{0,60}(?:场景|场面|方案)|候选(?:场景|场面|方案)|选择(?:前者|后者|方案)|方案[一二三123]/.test(value)) issues.push('sellingPoint 混入方案比较过程')
  }
  return issues
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
