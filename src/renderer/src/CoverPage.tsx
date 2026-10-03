import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type {
  CoverFile,
  CoverGenre,
  CoverImageConfigSummary,
  CoverPlatform,
  CoverChannel,
  CoverComposition,
  CoverStylePreset,
  CoverTypographyOptions,
  CoverTitleFontStyle,
  CoverTitlePosition,
  CoverTitleEffect,
  CoverAuthorFontStyle,
  CoverAuthorPosition,
  CoverLearningContext,
  CoverScene,
  CoverFeedback,
  CoverGenerationTaskState,
  GenerateCoverInput
} from '../../shared/types'
import { CoverPromptRequestGuard, coverTextSettingsKey, coverCustomTextConfirmationKey, inspectCoverPromptText, isCoverGenerationActive, describeCoverGenerationPhase, coverCropObjectPosition, coverChannelFields, resolveCoverChannelComposition } from './cover-page-state'

const PLATFORM_OPTIONS: { value: CoverPlatform; label: string }[] = [
  { value: 'fanqie', label: '番茄小说（默认 3:4）' },
  { value: 'qidian', label: '起点（默认 3:4）' },
  { value: 'jjwxc', label: '晋江（默认 3:4）' },
  { value: 'zhihu', label: '知乎盐言（默认 3:4）' },
  { value: 'qimao', label: '七猫（默认 3:4）' },
  { value: 'ciweimao', label: '刺猬猫（默认 3:4）' },
  { value: 'other', label: '其他（默认 3:4）' }
]

const GENRE_OPTIONS: { value: CoverGenre; label: string }[] = [
  { value: 'xianxia', label: '玄幻/仙侠' },
  { value: 'urban', label: '都市' },
  { value: 'ancient_romance', label: '古言/宫斗' },
  { value: 'modern_romance', label: '现言/甜宠' },
  { value: 'mystery', label: '悬疑/推理' },
  { value: 'scifi', label: '科幻/末世' },
  { value: 'western_fantasy', label: '西幻' },
  { value: 'historical', label: '历史/军事' },
  { value: 'supernatural', label: '灵异/恐怖' },
  { value: 'light_novel', label: '轻小说' }
]

const COMPOSITION_OPTIONS: { value: CoverComposition; label: string }[] = [
  { value: 'closeup', label: '人物特写（通用）' },
  { value: 'fullbody', label: '全身动态' },
  { value: 'scene', label: '纯场景/氛围' },
  { value: 'duo', label: '双人（言情）' }
]
const CHANNEL_OPTIONS: { value: CoverChannel | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动（按小说内容）' },
  { value: 'male', label: '男频（男性人物）' },
  { value: 'female', label: '女频（女性人物）' }
]
const MAX_COVER_PROMPT_CHARACTERS = 8000

/** 先读取规则快照，再按该版本构建，避免学习恰好完成时提示词与来源对不上。 */
async function buildPromptSnapshot(input: GenerateCoverInput): Promise<{ text: string; context: CoverLearningContext }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await window.api.getCoverPromptContext(input)
    try {
      const text = await window.api.buildCoverPrompt({ ...input, learningContext: context })
      return { text, context }
    } catch (error) {
      if (attempt > 0 || !String(error).includes('COVER_LIBRARY_CHANGED')) throw error
    }
  }
  throw new Error('学习规则正在更新，请重新构建提示词')
}

const STYLE_PRESET_OPTIONS: Array<{
  value: CoverStylePreset
  label: string
  description: string
  swatch: string
}> = [
  {
    value: 'auto',
    label: '智能匹配',
    description: '按平台、题材和小说内容自动选择视觉表达',
    swatch: 'linear-gradient(135deg, #24364b, #d7a24a, #f2e7d2)'
  },
  {
    value: 'photorealistic',
    label: '真人写实封面',
    description: '真人摄影质感、自然肤质与电影光影，适合古装和现代人物',
    swatch: 'linear-gradient(135deg, #17293d, #d99b55 55%, #f2e7d2)'
  },
  {
    value: 'anime_illustration',
    label: '二次元动漫封面',
    description: '二维动漫人物、清晰线稿与赛璐璐上色，适合国漫和日漫风格',
    swatch: 'linear-gradient(135deg, #49c8ff, #f3eee3 52%, #f05038)'
  },
  {
    value: 'fanqie_impact',
    label: '高饱和爽文海报',
    description: '强对比、主体醒目、超大标题，适合脑洞与逆袭',
    swatch: 'linear-gradient(135deg, #ff5a2a, #ffc400 52%, #1167d8)'
  },
  {
    value: 'ancient_romance',
    label: '古风人物言情',
    description: '古装人物、红金华服与情绪关系',
    swatch: 'linear-gradient(135deg, #611016, #d13a32 52%, #d9ad58)'
  },
  {
    value: 'ink_minimal',
    label: '国风水墨留白',
    description: '宣纸、水墨山水、花枝与书法标题',
    swatch: 'linear-gradient(135deg, #f3ead6, #c7c1a8 55%, #27302d)'
  },
  {
    value: 'dark_suspense',
    label: '暗黑悬疑电影',
    description: '低照度、强阴影与局部红色警示',
    swatch: 'linear-gradient(135deg, #080b12, #253b51 65%, #a10f1a)'
  },
  {
    value: 'urban_cinematic',
    label: '都市电影感',
    description: '写实人物、城市空间与高级电影光影',
    swatch: 'linear-gradient(135deg, #17293d, #436f8e 55%, #d99b55)'
  },
  {
    value: 'anime_light',
    label: '二次元轻小说',
    description: '角色立绘、明亮配色和图形贴纸感',
    swatch: 'linear-gradient(135deg, #49c8ff, #f47cc2 55%, #8b68e8)'
  },
  {
    value: 'retro_period',
    label: '年代复古宣传画',
    description: '旧海报质感、年代建筑与暖色印刷色',
    swatch: 'linear-gradient(135deg, #a83428, #d1a64b 52%, #52776d)'
  },
  {
    value: 'epic_fantasy',
    label: '玄幻史诗大片',
    description: '宏大世界、英雄主体与克制能量特效',
    swatch: 'linear-gradient(135deg, #111833, #4d3480 52%, #d89d39)'
  },
  {
    value: 'concept_symbol',
    label: '无人物概念符号',
    description: '用关键物、徽记或空间表达故事核心',
    swatch: 'linear-gradient(135deg, #161513, #655542 58%, #dfd0ad)'
  },
  {
    value: 'glamour_romance',
    label: '女频精致人像',
    description: '柔光人像、时尚质感与装饰字，适合现言豪门',
    swatch: 'linear-gradient(135deg, #f5d9d3, #a33d56 55%, #d8b16b)'
  },
  {
    value: 'cute_doodle',
    label: '沙雕简笔脑洞',
    description: '白底手绘、表情包角色与超大手写标题',
    swatch: 'linear-gradient(135deg, #fffdf5, #f05038 62%, #ffd43b)'
  },
  {
    value: 'warm_period_life',
    label: '年代生活群像',
    description: '年代服装、家庭群像与温暖金色日光',
    swatch: 'linear-gradient(135deg, #53664b, #d4a15e 55%, #9e3e31)'
  },
  {
    value: 'rural_healing',
    label: '田园种田治愈',
    description: '乡野、作物、美食和有烟火气的日常生活',
    swatch: 'linear-gradient(135deg, #759447, #e4bd63 58%, #bd5b36)'
  },
  {
    value: 'male_power_type',
    label: '男频强字效爽文',
    description: '英雄主体、强透视和粗黑堆叠标题',
    swatch: 'linear-gradient(135deg, #10151e, #ef6b25 52%, #1b7acb)'
  },
  {
    value: 'folk_horror',
    label: '中式民俗灵异',
    description: '纸扎、棺木、古宅和红黑禁忌物',
    swatch: 'linear-gradient(135deg, #100c0b, #8e1118 58%, #b49154)'
  },
  {
    value: 'war_spy_epic',
    label: '战争谍战纪实',
    description: '战场、列车、密信与孤胆行动人物',
    swatch: 'linear-gradient(135deg, #30352f, #ae6d35 58%, #d4c09b)'
  },
  {
    value: 'game_neon',
    label: '游戏科幻霓虹',
    description: '全身角色、技能光效与蓝橙游戏标题',
    swatch: 'linear-gradient(135deg, #071b37, #087fd3 52%, #ff7832)'
  },
  {
    value: 'western_adventure',
    label: '西幻冒险轻快',
    description: '异世界角色、城镇、工坊与冒险道具',
    swatch: 'linear-gradient(135deg, #e8d5a9, #57a4c8 55%, #a34d36)'
  },
  {
    value: 'minimal_typographic',
    label: '纯字极简概念',
    description: '用书名排版、色块和单一符号完成封面',
    swatch: 'linear-gradient(135deg, #f3eee3 48%, #c42e25 49%, #171717 72%)'
  }
]

const TITLE_FONT_OPTIONS: Array<{ value: CoverTitleFontStyle; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'impact', label: '粗黑堆叠大字' },
  { value: 'brush', label: '国风毛笔书法' },
  { value: 'elegant', label: '雅致宋体/楷体' },
  { value: 'modern', label: '现代几何黑体' },
  { value: 'suspense', label: '悬疑窄体锐字' },
  { value: 'anime', label: '二次元描边字' },
  { value: 'retro', label: '年代复古印刷字' }
]

const TITLE_POSITION_OPTIONS: Array<{ value: CoverTitlePosition; label: string }> = [
  { value: 'auto', label: '自动布局' },
  { value: 'top', label: '顶部横排' },
  { value: 'center', label: '中央主视觉' },
  { value: 'lower_third', label: '下三分之一横排' },
  { value: 'vertical_left', label: '左侧竖排' },
  { value: 'vertical_right', label: '右侧竖排' }
]

const TITLE_EFFECT_OPTIONS: Array<{ value: CoverTitleEffect; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'flat', label: '纯色平面' },
  { value: 'outline_shadow', label: '描边立体阴影' },
  { value: 'metallic', label: '金属金/银质感' },
  { value: 'ink', label: '水墨飞白' },
  { value: 'glow', label: '克制发光' },
  { value: 'embossed', label: '浮雕刻字' }
]

const AUTHOR_FONT_OPTIONS: Array<{ value: CoverAuthorFontStyle; label: string }> = [
  { value: 'auto', label: '跟随封面风格' },
  { value: 'sans', label: '简洁现代黑体' },
  { value: 'serif', label: '雅致宋体' },
  { value: 'seal', label: '印章/篆刻感' },
  { value: 'handwritten', label: '自然手写体' },
  { value: 'metallic', label: '纤细金属字' }
]

const AUTHOR_POSITION_OPTIONS: Array<{ value: CoverAuthorPosition; label: string }> = [
  { value: 'auto', label: '自动布局' },
  { value: 'bottom_center', label: '底部居中' },
  { value: 'bottom_right', label: '右下角' },
  { value: 'vertical_side', label: '标题侧边竖排' }
]

const GENRE_LABELS: Record<CoverGenre, string> = {
  xianxia: '玄幻/仙侠',
  urban: '都市',
  ancient_romance: '古言',
  modern_romance: '现言',
  mystery: '悬疑',
  scifi: '科幻',
  western_fantasy: '西幻',
  historical: '历史',
  supernatural: '灵异',
  light_novel: '轻小说'
}

/** 把主进程抛回的错误码翻成人话（safeHandle 会带 "Error: " 前缀） */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('COVER_PROMPT_NO_MATERIAL')) {
    return '这本书还没有简介、大纲、人物卡或正文，先写一点再来提炼。'
  }
  if (raw.includes('COVER_PROMPT_PARSE_FAILED')) {
    return '模型没有按要求返回 JSON。重试一次，或在设置里给「辅助提取」换一个更稳的模型。'
  }
  if (raw.includes('LLM_NOT_CONFIGURED')) {
    return '还没有可用的文本模型。到全局设置里配置 API Key，或接入 codex / grok / claude CLI。'
  }
  if (raw.includes('LLM_TIMEOUT')) {
    return '提炼超时。素材较多时可先精简大纲，或换一个更快的模型。'
  }
  if (raw.includes('IMAGE_NOT_CONFIGURED')) {
    return '请先配置图像生成（点右上「封面配置」填写 API Key，或选用 codex / grok CLI 通道）。'
  }
  if (raw.includes('IMAGE_TIMEOUT')) {
    const detail = raw.replace(/^.*IMAGE_TIMEOUT[（(]?/, '').replace(/[）)]?$/, '').trim()
    return detail || '出图超时（服务端耗时较长）。请重试一次，或检查 API 状态。'
  }
  if (raw.includes('IMAGE_NETWORK_ERROR')) {
    const detail = raw.replace(/^.*IMAGE_NETWORK_ERROR[（(]?/, '').replace(/[）)]?$/, '').trim()
    return detail || '网络连接失败：无法访问图像 API 服务器。请检查 Base URL、网络连接或代理设置。'
  }
  if (raw.includes('IMAGE_EMPTY_RESPONSE')) {
    return '出图失败：API 成功响应但未返回图片数据（b64_json），请确认该模型是否支持图像生成。'
  }
  if (raw.includes('IMAGE_CLI_NOT_FOUND')) {
    return '未检测到本机 codex / grok CLI。请先安装并完成登录（终端运行 codex login 或 grok login）。'
  }
  if (raw.includes('IMAGE_CLI_TIMEOUT')) {
    return 'CLI 生图超时（上限 10 分钟）。请重试一次；反复超时可改用「API」通道。'
  }
  if (raw.includes('IMAGE_CLI_GENERATE_FAILED')) {
    return 'CLI 生图失败：模型没有产出图片文件。请确认 CLI 登录态有效后重试（详情见原始报错）。'
  }
  if (raw.includes('fetch failed')) {
    return '网络请求失败：无法连接到图像 API 服务器。请检查「封面配置」中的 Base URL 是否正确、网络是否通畅或代理是否已开启。'
  }
  return raw.replace(/^Error:\s*/, '')
}

interface Props {
  projectId: string
}

export default function CoverPage({ projectId }: Props): React.ReactElement {
  return <CoverPageContent key={projectId} projectId={projectId} />
}

function CoverPageContent({ projectId }: Props): React.ReactElement {
  const [covers, setCovers] = useState<CoverFile[]>([])
  const [config, setConfig] = useState<CoverImageConfigSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [buildingPrompt, setBuildingPrompt] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [configError, setConfigError] = useState('')
  const [coverRevision, setCoverRevision] = useState(0)
  const [generationTask, setGenerationTask] = useState<CoverGenerationTaskState | null>(null)
  const [generationTaskReady, setGenerationTaskReady] = useState(false)
  const [generationTaskError, setGenerationTaskError] = useState('')
  const [cancellingGeneration, setCancellingGeneration] = useState(false)
  const [generationNotice, setGenerationNotice] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const activeProject = useRef(projectId)
  activeProject.current = projectId
  const historyRequest = useRef(0)
  const configRequest = useRef(0)
  const handledGenerationTask = useRef('')
  const promptWork = useRef(new CoverPromptRequestGuard())
  const appliedBuildKey = useRef('')

  // 表单
  const [bookName, setBookName] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [platform, setPlatform] = useState<CoverPlatform>('fanqie')
  const [genreOverride, setGenreOverride] = useState<CoverGenre | ''>('')
  const [channel, setChannel] = useState<CoverChannel | 'auto'>('auto')
  const [composition, setComposition] = useState<CoverComposition | 'auto'>('auto')
  const [automaticComposition, setAutomaticComposition] = useState<CoverComposition>('closeup')
  const [stylePreset, setStylePreset] = useState<CoverStylePreset>('fanqie_impact')
  const [typography, setTypography] = useState<CoverTypographyOptions>({
    titleFont: 'auto',
    titlePosition: 'auto',
    titleEffect: 'auto',
    authorFont: 'auto',
    authorPosition: 'auto'
  })
  const [extraHint, setExtraHint] = useState('')

  /**
   * 保留编辑框原文；明确选择的人物频道和提炼方向由后端处理冲突约束。
   * 未手改时跟随上方表单自动重拼；手改后停止自动覆盖（否则会吞掉用户的编辑）。
   */
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  /** 拼出当前提示词时用的平台，用于提示「改了平台但提示词没跟着变」 */
  const [promptPlatform, setPromptPlatform] = useState<CoverPlatform | null>(null)
  const [summary, setSummary] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [scene, setScene] = useState<CoverScene | undefined>()
  const [sceneStyleHint, setSceneStyleHint] = useState<string | undefined>()
  const [promptContext, setPromptContext] = useState<CoverLearningContext | undefined>()
  const [availableContext, setAvailableContext] = useState<CoverLearningContext | undefined>()
  const [promptNotice, setPromptNotice] = useState('')
  const [appliedTextKey, setAppliedTextKey] = useState('')
  const [customTextConfirmation, setCustomTextConfirmation] = useState('')

  // 配置弹窗
  const [showConfig, setShowConfig] = useState(false)

  const refreshHistory = useCallback(async (): Promise<void> => {
    const request = ++historyRequest.current
    setLoading(true)
    setHistoryError('')
    try {
      const list = await window.api.listCovers(projectId)
      if (!mounted.current || activeProject.current !== projectId || request !== historyRequest.current) return
      setCovers(list)
      setCoverRevision((revision) => revision + 1)
    } catch (err) {
      if (mounted.current && activeProject.current === projectId && request === historyRequest.current) setHistoryError(describeError(err))
    } finally {
      if (mounted.current && activeProject.current === projectId && request === historyRequest.current) setLoading(false)
    }
  }, [projectId])

  const refreshConfig = useCallback(async (): Promise<void> => {
    const request = ++configRequest.current
    setConfigError('')
    try {
      const cfg = await window.api.getCoverImageConfig()
      if (mounted.current && request === configRequest.current) setConfig(cfg)
    } catch (err) {
      if (mounted.current && request === configRequest.current) setConfigError(describeError(err))
    }
  }, [])

  const invalidatePromptWork = useCallback((): void => {
    promptWork.current.invalidate()
    setBuildingPrompt(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    const promptGuard = promptWork.current
    void refreshHistory()
    void refreshConfig()
    setGenerationTaskReady(false)
    let querying = false
    let active = true
    const pollTask = async (): Promise<void> => {
      if (querying) return
      querying = true
      try {
        const task = await window.api.getCoverGenerationTask(projectId)
        if (!active) return
        setGenerationTask(task)
        setGenerationTaskReady(true)
        setGenerationTaskError('')
        if (task && !isCoverGenerationActive(task.phase) && handledGenerationTask.current !== task.id + task.phase) {
          handledGenerationTask.current = task.id + task.phase
          setCancellingGeneration(false)
          setGenerationNotice(describeCoverGenerationPhase(task.phase))
          if (task.phase === 'completed') void refreshHistory()
          if (task.phase === 'failed') setError(describeError(task.error ?? '封面生成失败'))
        }
      } catch (err) {
        if (active) { setGenerationTaskReady(false); setGenerationTaskError(describeError(err)) }
      } finally { querying = false }
    }
    void pollTask()
    const timer = window.setInterval(() => void pollTask(), 900)
    return () => {
      active = false
      mounted.current = false
      promptGuard.invalidate()
      window.clearInterval(timer)
    }
  }, [projectId, refreshHistory, refreshConfig])

  // 书名默认取项目名，省得每次手打；用户改过就不再覆盖
  const bookNamePrefilled = useRef(false)
  useEffect(() => {
    bookNamePrefilled.current = false
    let active = true
    void window.api
      .getProject(projectId)
      .then((project) => {
        if (!active || bookNamePrefilled.current || !project?.name) return
        bookNamePrefilled.current = true
        setBookName((prev) => (prev.trim() ? prev : project.name))
      })
      .catch(() => {
        /* 项目信息读不到不影响手填 */
      })
    return () => {
      active = false
    }
  }, [projectId])

  const trimmedBook = bookName.trim()
  const trimmedAuthor = authorName.trim()
  const canBuild = Boolean(trimmedBook && trimmedAuthor)
  const textSettingsKey = coverTextSettingsKey(trimmedBook, trimmedAuthor, typography)
  const promptTextState = inspectCoverPromptText(prompt, trimmedBook, trimmedAuthor)
  const customTextConfirmed = customTextConfirmation === coverCustomTextConfirmationKey(prompt, textSettingsKey)
  const textMismatch = promptTextState === 'mismatch' || (promptTextState === 'custom' && !customTextConfirmed)
  const textSettingsPending = !!prompt.trim() && appliedTextKey !== textSettingsKey && !customTextConfirmed
  const generationBusy = generating || isCoverGenerationActive(generationTask?.phase)

  /** 当前表单折算成出图入参（拼装与生成共用，保证所见即所发） */
  const buildInput = useCallback(
    (overrides?: Partial<GenerateCoverInput>): GenerateCoverInput => ({
      projectId,
      bookName: trimmedBook,
      authorName: trimmedAuthor,
      platform,
      composition: resolveCoverChannelComposition(composition === 'auto' ? automaticComposition : composition, channel === 'auto' ? undefined : channel),
      ...coverChannelFields(channel),
      stylePreset,
      typography,
      scene,
      styleHint: sceneStyleHint,
      ...(genreOverride ? { genreOverride } : {}),
      ...overrides
    }),
    [projectId, trimmedBook, trimmedAuthor, platform, composition, automaticComposition, channel, stylePreset, typography, genreOverride, scene, sceneStyleHint]
  )
  const inputBuildKey = JSON.stringify(buildInput())
  const templateBuildPending = !promptDirty && !!prompt.trim() && appliedBuildKey.current !== inputBuildKey

  const selectChannel = (next: CoverChannel | 'auto'): void => {
    invalidatePromptWork()
    setChannel(next)
    if (next !== 'auto') {
      if (composition === 'scene') setComposition('closeup')
      setAutomaticComposition((current) => resolveCoverChannelComposition(current, next))
    }
    if (promptDirty) {
      setPromptNotice(next === 'auto'
        ? '已解除人物频道锁，并保留当前提示词与画面资料。原文自身的人物性别要求仍会生效；重新提炼或重置为模板可按小说内容更新。'
        : `已保留当前提示词；生成时将按${next === 'male' ? '男性' : '女性'}人物处理，覆盖原文或提炼方向中冲突的性别、无人物要求。重新提炼可同步更新画面描述。`)
    }
    setError('')
  }

  const selectStylePreset = (next: CoverStylePreset): void => {
    invalidatePromptWork()
    setStylePreset(next)
    if (next === 'concept_symbol' && composition === 'auto') setAutomaticComposition(resolveCoverChannelComposition('scene', channel === 'auto' ? undefined : channel))
    if (promptDirty) setPromptNotice('已保留当前提示词。要应用新风格，请重新提炼，或重置为模板。')
    setError('')
  }

  const updateTypography = (patch: Partial<CoverTypographyOptions>): void => {
    invalidatePromptWork()
    setTypography({ ...typography, ...patch })
    setError('')
  }

  // 未手改时跟随表单重拼提示词；手改后不再自动覆盖，改由「重置」显式放弃编辑
  useEffect(() => {
    if (promptDirty || !canBuild || appliedBuildKey.current === inputBuildKey) return
    const token = promptWork.current.begin()
    setBuildingPrompt(true)
    void buildPromptSnapshot(buildInput())
      .then(({ text, context }) => {
        if (mounted.current && promptWork.current.isCurrent(token)) {
          setPrompt(text)
          setPromptPlatform(platform)
          setPromptContext(context)
          setAvailableContext(context)
          setAppliedTextKey(textSettingsKey)
          appliedBuildKey.current = inputBuildKey
        }
      })
      .catch((err) => {
        if (mounted.current && promptWork.current.isCurrent(token)) setError(describeError(err))
      })
      .finally(() => {
        if (mounted.current && promptWork.current.isCurrent(token)) setBuildingPrompt(false)
      })
  }, [promptDirty, canBuild, buildInput, platform, inputBuildKey, textSettingsKey])

  const recompileText = useCallback(async (): Promise<void> => {
    if (!canBuild || !prompt.trim()) return
    if (inspectCoverPromptText(prompt, trimmedBook, trimmedAuthor) === 'custom') {
      setPromptNotice('当前自定义提示词没有完整的标准文字层。请手动同步书名、署名和文字设计，再确认。')
      return
    }
    const token = promptWork.current.begin()
    const original = prompt
    const input = buildInput({ typographyBasePrompt: original, learningContext: promptContext })
    setBuildingPrompt(true)
    try {
      const context = await window.api.getCoverPromptContext(input)
      const text = await window.api.buildCoverPrompt({ ...input, learningContext: context })
      if (!mounted.current || !promptWork.current.isCurrent(token)) return
      setPrompt(text)
      setPromptDirty(true)
      setAppliedTextKey(textSettingsKey)
      setPromptContext(context)
      setAvailableContext(context)
      setPromptNotice('已同步书名、署名与文字设计，保留画面、其余手改内容和原学习规则快照。')
    } catch (err) {
      if (mounted.current && promptWork.current.isCurrent(token)) setError(describeError(err))
    } finally {
      if (mounted.current && promptWork.current.isCurrent(token)) setBuildingPrompt(false)
    }
  }, [canBuild, prompt, trimmedBook, trimmedAuthor, buildInput, promptContext, textSettingsKey])

  useEffect(() => {
    if (!promptDirty || !canBuild || appliedTextKey === textSettingsKey || customTextConfirmed) return
    void recompileText()
  }, [promptDirty, canBuild, appliedTextKey, textSettingsKey, customTextConfirmed, recompileText])

  const refreshLearningContext = async (): Promise<void> => {
    if (!canBuild) return
    try {
      const context = await window.api.getCoverPromptContext(buildInput())
      setAvailableContext(context)
      setPromptNotice(context.libraryVersion === promptContext?.libraryVersion
        ? '当前题材的学习规则已是最新。'
        : '学习规则已更新；当前提示词保留原快照。重新提炼或重置为模板后应用新规则。')
    } catch (err) {
      setError(describeError(err))
    }
  }

  /**
   * 手改过的提示词里也包含平台风格。之后改平台不会覆盖手改内容，
   * 因此提醒用户重置提示词，避免新平台和旧风格互相冲突。
   */
  const platformStale = promptDirty && promptPlatform !== null && promptPlatform !== platform
  const promptOverBudget = prompt.length > MAX_COVER_PROMPT_CHARACTERS

  const handleGenerate = async (): Promise<void> => {
    if (!generationTaskReady || generationBusy) {
      setError('正在确认或执行已有生成任务，请稍候。')
      return
    }
    if (!canBuild) {
      setError('书名和作者名必填')
      return
    }
    if (!prompt.trim()) {
      setError('提示词不能为空')
      return
    }
    if (buildingPrompt || extracting || textSettingsPending || templateBuildPending) {
      setError('最新提示词或文字设计尚未就绪，请等待更新完成。')
      return
    }
    if (textMismatch) {
      setError(promptTextState === 'custom' ? '无法识别自定义提示词中的书名和署名。请手动同步后确认。' : '提示词中的书名或署名与表单不一致，请先同步文字层。')
      return
    }
    if (promptOverBudget) {
      setError(`提示词共 ${prompt.length} 字符，超过 ${MAX_COVER_PROMPT_CHARACTERS} 字符预算。请手动精简，或在学习库停用部分规则后重新提炼或重置。`)
      return
    }
    if (!config || (config.channel === 'api' && !config.hasKey)) {
      setError('请先配置图像生成（点右上「封面配置」：API Key 或 codex / grok CLI 通道）')
      return
    }
    setGenerating(true)
    setError('')
    setGenerationNotice('')
    const scope = projectId
    try {
      // 编辑框原样提交；后端先处理提炼方向，再落实明确选择的人物频道。
      const direction = extraHint.trim()
      await window.api.generateCover(buildInput({
        promptOverride: prompt,
        promptSource: promptDirty ? 'edited' : 'template',
        learningContext: promptContext,
        ...(direction ? { visualDirection: direction } : {})
      }))
      if (mounted.current && activeProject.current === scope) {
        setGenerationNotice('封面生成完成')
        await refreshHistory()
      }
    } catch (err) {
      if (mounted.current && activeProject.current === scope) {
        if (String(err).includes('IMAGE_ABORTED') || String(err).includes('COVER_GENERATION_CANCELLED')) setGenerationNotice('封面生成已取消')
        else setError(describeError(err))
      }
    } finally {
      if (mounted.current && activeProject.current === scope) setGenerating(false)
    }
  }

  const cancelGeneration = async (): Promise<void> => {
    setCancellingGeneration(true)
    try {
      const result = await window.api.cancelCoverGenerationTask(projectId)
      if (mounted.current && !result.ok) {
        setCancellingGeneration(false)
        setGenerationNotice('任务已结束或正在保存，正在刷新状态。')
      }
    } catch (err) {
      if (mounted.current) { setCancellingGeneration(false); setError(describeError(err)) }
    }
  }

  /**
   * 读项目的大纲 / 人物卡 / 正文提炼画面要素，拼成整段提示词填进框里。
   * 只调文本模型（走 auxiliary 路由），没配图像 Key 也能先把提示词调好。
   */
  const handleExtractPrompt = async (): Promise<void> => {
    if (!canBuild) {
      setError('书名和作者名必填')
      return
    }
    const token = promptWork.current.begin()
    setExtracting(true)
    setBuildingPrompt(true)
    setError('')
    try {
      const hasLlm = await window.api.hasLlmKey()
      if (!mounted.current || !promptWork.current.isCurrent(token)) return
      if (!hasLlm) {
        throw new Error('请先在全局设置中配置文本模型（API Key 或 codex / grok / claude CLI 均可）')
      }
      const draft = await window.api.extractCoverPrompt({
        projectId,
        bookName: trimmedBook,
        authorName: trimmedAuthor,
        platform,
        ...coverChannelFields(channel),
        stylePreset,
        typography,
        ...(composition !== 'auto' ? { compositionOverride: composition } : {}),
        ...(genreOverride ? { genreOverride } : {}),
        ...(extraHint.trim() ? { extraHint: extraHint.trim() } : {})
      })
      if (!mounted.current || !promptWork.current.isCurrent(token)) return
      setPrompt(draft.prompt)
      // 提炼结果视同手改：后续改平台/题材不该把它冲掉
      setPromptDirty(true)
      setPromptPlatform(platform)
      setSummary(draft.summary)
      setSources(draft.sources)
      setScene(draft.scene)
      setSceneStyleHint(draft.styleHint)
      setPromptContext(draft.learningContext)
      setAvailableContext(draft.learningContext)
      setPromptNotice('已保留提炼画面；后续文字调整只更新文字层。')
      setAppliedTextKey(textSettingsKey)
      setAutomaticComposition(resolveCoverChannelComposition(draft.composition, channel === 'auto' ? undefined : channel))
      if (!genreOverride) setGenreOverride(draft.genre)
    } catch (err) {
      if (mounted.current && promptWork.current.isCurrent(token)) setError(describeError(err))
    } finally {
      if (mounted.current) setExtracting(false)
      if (mounted.current && promptWork.current.isCurrent(token)) setBuildingPrompt(false)
    }
  }

  /** 丢弃提炼与手改，回到当前平台/题材/构图的模板提示词 */
  const handleResetPrompt = async (): Promise<void> => {
    const token = promptWork.current.begin()
    setBuildingPrompt(true)
    setError('')
    if (!canBuild) {
      setPrompt('')
      setPromptPlatform(null)
      setPromptDirty(false)
      setSummary('')
      setSources([])
      setScene(undefined)
      setSceneStyleHint(undefined)
      setPromptContext(undefined)
      setAvailableContext(undefined)
      setPromptNotice('')
      setAppliedTextKey('')
      appliedBuildKey.current = ''
      setBuildingPrompt(false)
      return
    }
    try {
      const resetInput = buildInput({ scene: undefined, styleHint: undefined })
      const { text, context } = await buildPromptSnapshot(resetInput)
      if (!mounted.current || !promptWork.current.isCurrent(token)) return
      appliedBuildKey.current = JSON.stringify(resetInput)
      setSummary('')
      setSources([])
      setScene(undefined)
      setSceneStyleHint(undefined)
      setPromptNotice('')
      setPromptDirty(false)
      setPrompt(text)
      setPromptContext(context)
      setAvailableContext(context)
      setPromptPlatform(platform)
      setAppliedTextKey(textSettingsKey)
    } catch (err) {
      if (mounted.current && promptWork.current.isCurrent(token)) setError(describeError(err))
    } finally {
      if (mounted.current && promptWork.current.isCurrent(token)) setBuildingPrompt(false)
    }
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>封面设计</h1>
            <p className="desc">一眼传达题材与氛围 · 调用图像模型生成含书名署名的专业封面</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setShowConfig(true)}>
              ⚙ 封面配置
              {config?.channel === 'codex' ? (
                <span style={{ marginLeft: 6, color: 'var(--success)' }}>●codex CLI</span>
              ) : config?.channel === 'grok' ? (
                <span style={{ marginLeft: 6, color: 'var(--success)' }}>●grok CLI</span>
              ) : config?.hasKey ? (
                <span style={{ marginLeft: 6, color: 'var(--success)' }}>●已配置</span>
              ) : (
                <span style={{ marginLeft: 6, color: 'var(--danger)' }}>●未配置</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {configError ? <div className="placeholder" role="alert" style={{ marginTop: 12, textAlign: 'left' }}><p className="diag-msg" style={{ color: 'var(--danger)' }}>图像配置读取失败：{configError}</p><button className="btn btn-ghost" onClick={() => void refreshConfig()}>重试读取配置</button><button className="btn btn-ghost" onClick={() => setShowConfig(true)}>重新配置</button></div> : null}
      {generationTaskError ? <p role="alert" className="diag-msg" style={{ color: 'var(--danger)' }}>无法确认生成任务：{generationTaskError}。恢复读取后才能开始新任务。</p> : null}
      {generationBusy ? <div className="placeholder" role="status" style={{ marginTop: 12, textAlign: 'left' }}><div className="row row-wrap"><strong>{describeCoverGenerationPhase(generationTask?.phase ?? 'preparing')}</strong><button className="btn btn-ghost" disabled={cancellingGeneration || generationTask?.phase === 'saving'} onClick={() => void cancelGeneration()}>{cancellingGeneration ? '正在取消…' : '取消生成'}</button></div><p className="meta" style={{ marginBottom: 0 }}>耗时取决于图像模型和通道，可以切换页面，返回后会恢复状态。保存阶段请等待写入完成。</p></div> : generationNotice ? <p role="status" className="meta">{generationNotice}</p> : null}

      {config && !config.hasKey && config.channel === 'api' ? (
        <div className="placeholder" style={{ marginTop: 16 }}>
          <p style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--danger)' }}>
            图像生成 API 未配置。出图需要 OpenAI Images API 或兼容代理的 Key（gpt-image-2），
            或直接改用本机 codex / grok CLI（登录态即可，无需 Key）。
          </p>
          <p className="meta" style={{ margin: '0 0 12px' }}>
            推荐流程：1）先用 codex / grok / claude 这类 CLI（或任意文本模型）点「提炼画面要素」把提示词调好；
            2）点「前往配置」选「codex CLI」或「grok CLI」通道（无需 Key），或填入任一兼容图像的 API Key；
            3）最后点「生成封面」出图。
          </p>
          <button className="btn btn-primary" onClick={() => setShowConfig(true)}>
            前往配置
          </button>
        </div>
      ) : null}

      {/* 生成表单 */}
        <div className="dialog" style={{ maxWidth: 'none', width: '100%', margin: '12px 0', boxShadow: 'none' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '2 1 200px' }}>
            <label htmlFor="cover-book-name">书名 *</label>
            <input
              id="cover-book-name"
              className="input"
              value={bookName}
              onChange={(e) => { invalidatePromptWork(); bookNamePrefilled.current = true; setBookName(e.target.value) }}
              maxLength={120}
              placeholder="《剑道独尊》"
            />
          </div>
          <div className="field" style={{ flex: '1 1 120px' }}>
            <label htmlFor="cover-author">作者名（笔名）*</label>
            <input
              id="cover-author"
              className="input"
              value={authorName}
              onChange={(e) => { invalidatePromptWork(); setAuthorName(e.target.value) }}
              maxLength={60}
              placeholder="青椒炒肉"
            />
          </div>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-platform">目标平台</label>
            <select id="cover-platform" className="input" value={platform} onChange={(e) => { invalidatePromptWork(); setPlatform(e.target.value as CoverPlatform) }}>
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-genre">题材（留空自动推断）</label>
            <select
              id="cover-genre"
              className="input"
              value={genreOverride}
              onChange={(e) => { invalidatePromptWork(); setGenreOverride(e.target.value as CoverGenre | '') }}
            >
              <option value="">自动推断</option>
              {GENRE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-channel">封面人物频道</label>
            <select
              id="cover-channel"
              className="input"
              value={channel}
              onChange={(event) => selectChannel(event.target.value as CoverChannel | 'auto')}
            >
              {CHANNEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="cover-composition">构图</label>
            <select
              id="cover-composition"
              className="input"
              value={composition}
              onChange={(e) => { invalidatePromptWork(); setComposition(e.target.value as CoverComposition | 'auto'); if (promptDirty) setPromptNotice('已保留当前画面。应用新的构图时，请重新提炼或重置为模板。') }}
            >
              <option value="auto">自动构图（提炼时由内容决定）</option>
              {COMPOSITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={channel !== 'auto' && o.value === 'scene'}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="meta" style={{ margin: '0 0 12px' }} role="status">
          {channel === 'auto'
            ? '自动频道不锁定人物性别，按小说内容提炼人物；手写提示词保留原有的人物要求。'
            : `已锁定${channel === 'male' ? '男频（男性人物）' : '女频（女性人物）'}，双人构图的两个人物均按所选性别生成。频道选择会覆盖提炼方向和提示词中冲突的性别或无人物要求；男/女频需人物，纯场景不可选。`}
        </p>
        <div className="field cover-style-field">
          <label>
            封面风格
            <span className="meta" style={{ marginLeft: 6 }}>
              已分析番茄 23 个题材、138 张榜单封面的共性，不复刻具体作品
            </span>
          </label>
          <div className="cover-style-grid" role="radiogroup" aria-label="封面风格">
            {STYLE_PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={stylePreset === option.value}
                className={`cover-style-card ${stylePreset === option.value ? 'active' : ''}`}
                onClick={() => selectStylePreset(option.value)}
              >
                <span className="cover-style-swatch" style={{ background: option.swatch }} aria-hidden />
                <span className="cover-style-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="cover-style-check" aria-hidden>{stylePreset === option.value ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="cover-typography-panel">
          <div className="cover-typography-head">
            <div>
              <strong>文字设计</strong>
              <span>分别控制小说书名与作者名的字体、位置和效果</span>
            </div>
            <span className="chip chip-muted">文字只出现一次 · 保持安全边距</span>
          </div>
          <div className="cover-typography-grid">
            <div className="field">
              <label htmlFor="cover-title-font">书名字体</label>
              <select
                id="cover-title-font"
                className="select"
                value={typography.titleFont ?? 'auto'}
                onChange={(event) => updateTypography({ titleFont: event.target.value as CoverTitleFontStyle })}
              >
                {TITLE_FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-title-position">书名位置</label>
              <select
                id="cover-title-position"
                className="select"
                value={typography.titlePosition ?? 'auto'}
                onChange={(event) => updateTypography({ titlePosition: event.target.value as CoverTitlePosition })}
              >
                {TITLE_POSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-title-effect">书名效果</label>
              <select
                id="cover-title-effect"
                className="select"
                value={typography.titleEffect ?? 'auto'}
                onChange={(event) => updateTypography({ titleEffect: event.target.value as CoverTitleEffect })}
              >
                {TITLE_EFFECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-author-font">作者名字体</label>
              <select
                id="cover-author-font"
                className="select"
                value={typography.authorFont ?? 'auto'}
                onChange={(event) => updateTypography({ authorFont: event.target.value as CoverAuthorFontStyle })}
              >
                {AUTHOR_FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cover-author-position">作者名位置</label>
              <select
                id="cover-author-position"
                className="select"
                value={typography.authorPosition ?? 'auto'}
                onChange={(event) => updateTypography({ authorPosition: event.target.value as CoverAuthorPosition })}
              >
                {AUTHOR_POSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 4 }}>
          <label
            htmlFor="cover-prompt"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
          >
            <span>
              封面提示词
              <span className="meta" style={{ marginLeft: 6 }}>
                {channel !== 'auto'
                  ? `${channel === 'male' ? '男性' : '女性'}人物已锁定，冲突要求会按频道调整`
                  : extraHint.trim()
                  ? '提炼方向优先级最高，压过这段提示词里冲突的人物和画风'
                  : promptDirty
                    ? '已手改，保留画面内容并应用文字安全区'
                    : '按平台/题材生成中文提示词，可直接编辑'}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn"
                style={{
                  fontSize: 12,
                  padding: '2px 10px',
                  height: 24,
                  borderRadius: 12,
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  border: '1px solid var(--line-strong)',
                  cursor: extracting ? 'wait' : 'pointer',
                  opacity: extracting ? 0.7 : 1
                }}
                onClick={() => void handleExtractPrompt()}
                disabled={extracting || buildingPrompt || generationBusy || !canBuild}
                title="读本书的简介、大纲、人物卡与开篇正文，提炼出专属画面后重写为中文提示词（只调文本模型，不消耗图像额度）"
              >
                {extracting ? (
                  <>
                    <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>{' '}
                    提炼中…
                  </>
                ) : (
                  '✦ 从小说内容生成提示词'
                )}
              </button>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '2px 10px', height: 24 }}
                onClick={() => void handleResetPrompt()}
                disabled={extracting || generationBusy}
                title="丢弃提炼与手改，回到当前平台/题材/构图的中文模板提示词"
              >
                ↺ 重置为模板
              </button>
            </span>
          </label>
          <textarea
            id="cover-prompt"
            className="input"
            value={prompt}
            onChange={(e) => {
              invalidatePromptWork()
              setPrompt(e.target.value)
              setPromptDirty(true)
            }}
            placeholder={canBuild ? '' : '填写书名与作者名后自动生成'}
            spellCheck={false}
            style={{
              resize: 'vertical',
              minHeight: 200,
              padding: '10px 12px',
              lineHeight: 1.6,
              fontSize: 12,
              fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)'
            }}
            rows={10}
          />
          <p className="meta" style={{ margin: '6px 0 0', color: promptOverBudget ? 'var(--danger)' : undefined }}>
            提示词 {prompt.length} / {MAX_COVER_PROMPT_CHARACTERS} 字符
            {promptOverBudget ? ' · 内容完整保留，请手动精简或停用部分学习规则后重建。' : ''}
          </p>
          {platformStale ? (
            <p className="meta" style={{ margin: '6px 0 0', color: 'var(--danger)' }}>
              平台已改为「{PLATFORM_OPTIONS.find((o) => o.value === platform)?.label}」，
              但提示词还是上一个平台的风格。点「重置」重新生成，或直接手动调整。
            </p>
          ) : null}
          {promptNotice ? <p className="meta" style={{ margin: '6px 0 0' }}>{promptNotice}</p> : null}
          {buildingPrompt ? <p role="status" className="meta">正在更新最新提示词和文字设计，完成后可生成封面。</p> : null}
          {textMismatch && prompt.trim() ? <div role="alert" style={{ marginTop: 8 }}>
            <p className="meta" style={{ color: 'var(--danger)' }}>{promptTextState === 'custom' ? '无法确认自定义提示词中的书名、署名和文字设置。请在正文中手动同步，确认后才能生成。' : '提示词中的书名或作者名与上方表单不一致，生成已暂停。'}</p>
            {promptTextState === 'custom' ? <button className="btn btn-ghost" onClick={() => { invalidatePromptWork(); setCustomTextConfirmation(coverCustomTextConfirmationKey(prompt, textSettingsKey)); setAppliedTextKey(textSettingsKey); setPromptNotice('已确认自定义提示词中的书名、署名与文字设计；后续修改会重新要求确认。') }}>已手动同步书名与署名</button> : <button className="btn btn-ghost" disabled={buildingPrompt || extracting} onClick={() => void recompileText()}>同步书名与署名</button>}
          </div> : null}
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12 }}>学习规则与版本</summary>
            <p className="meta">当前提示词使用：{promptContext?.libraryVersion ?? '未记录'} · 学习库来源总数 {promptContext?.sourceSampleCount ?? 0} 张（含历史记录）</p>
            <p className="meta">生成会使用编辑框中的现有提示词，并应用所选人物频道、提炼方向和裁剪后的文字安全区。学习库更新后，重新提炼或重置为模板才会应用新规则。</p>
            <button type="button" className="btn btn-ghost" onClick={() => void refreshLearningContext()} disabled={!canBuild}>
              检查最新学习规则
            </button>
            {availableContext && availableContext.libraryVersion !== promptContext?.libraryVersion ? (
              <p className="meta">可用版本：{availableContext.libraryVersion}</p>
            ) : null}
            {(availableContext?.rules ?? promptContext?.rules)?.length ? (
              <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 12 }}>
                {(availableContext?.rules ?? promptContext?.rules ?? []).map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            ) : <p className="meta">当前题材尚无可应用的学习建议。</p>}
            {promptContext?.sources?.length ? <p className="meta">规则依据：{promptContext.sources.join(' · ')}</p> : null}
          </details>
          {summary ? (
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>{summary}</p>
          ) : null}
          {sources.length > 0 ? (
            <p className="meta" style={{ margin: '2px 0 0' }}>
              素材来源：{sources.join(' · ')}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="cover-extra-hint" style={{ fontSize: 12 }}>
            {channel === 'auto' ? '提炼方向（优先于小说主角、视觉风格和提示词）' : '提炼方向（人物性别与是否有人物以所选频道为准）'}
          </label>
          <input
            id="cover-extra-hint"
            className="input"
            value={extraHint}
            onChange={(e) => { invalidatePromptWork(); setExtraHint(e.target.value) }}
            maxLength={500}
            placeholder="如：主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格"
          />
        </div>

        {error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleGenerate()}
            disabled={!generationTaskReady || generationBusy || buildingPrompt || extracting || textSettingsPending || templateBuildPending || textMismatch || !canBuild || !prompt.trim() || promptOverBudget}
          >
            {generationBusy ? '封面生成进行中…' : buildingPrompt || extracting ? '正在更新提示词…' : textMismatch ? '请确认文字同步' : textSettingsPending || templateBuildPending ? '正在更新提示词…' : !generationTaskReady ? '正在确认生成任务…' : '✦ 生成封面'}
          </button>
        </div>
      </div>

      {/* 封面历史 */}
      <h3 style={{ fontSize: 14, margin: '20px 0 12px' }}>封面版本</h3>
      {historyError ? <div role="alert"><p className="diag-msg" style={{ color: 'var(--danger)' }}>封面历史读取失败：{historyError}</p><button className="btn btn-ghost" onClick={() => void refreshHistory()}>重试读取历史</button></div> : null}
      {loading ? (
        <p className="empty">加载中…</p>
      ) : covers.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: 0, fontSize: 14 }}>还没有封面。填写上方信息生成第一个。</p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 16
          }}
        >
          {covers.map((c) => (
              <CoverThumb key={c.relPath} cover={c} projectId={projectId} previewRevision={coverRevision} generationBusy={generationBusy || !generationTaskReady} onUpdated={() => void refreshHistory()} />
          ))}
        </div>
      )}

      {showConfig ? (
        <CoverConfigDialog
          config={config ?? { hasKey: false, keyMasked: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', channel: 'api' }}
          onClose={() => setShowConfig(false)}
          onSaved={async () => {
            await refreshConfig()
            setShowConfig(false)
          }}
        />
      ) : null}
    </div>
  )
}

function CoverThumb({ cover, projectId, onUpdated, previewRevision, generationBusy }: { cover: CoverFile; projectId: string; onUpdated: () => void; previewRevision: number; generationBusy: boolean }): React.ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [locationError, setLocationError] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const [feedbackReason, setFeedbackReason] = useState(cover.feedback?.reason ?? '')
  const [savingFeedback, setSavingFeedback] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewRetry, setPreviewRetry] = useState(0)
  const [showCrop, setShowCrop] = useState(false)
  const [originalDataUrl, setOriginalDataUrl] = useState<string | null>(null)
  const [originalError, setOriginalError] = useState('')
  const [originalLoading, setOriginalLoading] = useState(false)
  const [showFullOriginal, setShowFullOriginal] = useState(false)
  const [cropFit, setCropFit] = useState<'cover' | 'contain'>(cover.generationMetadata?.crop?.fit ?? 'cover')
  const [cropX, setCropX] = useState(cover.generationMetadata?.crop?.offsetX ?? 0.5)
  const [cropY, setCropY] = useState(cover.generationMetadata?.crop?.offsetY ?? 0.5)
  const [savingCrop, setSavingCrop] = useState(false)

  useEffect(() => {
    setCropFit(cover.generationMetadata?.crop?.fit ?? 'cover')
    setCropX(cover.generationMetadata?.crop?.offsetX ?? 0.5)
    setCropY(cover.generationMetadata?.crop?.offsetY ?? 0.5)
  }, [cover.generationMetadata?.crop?.fit, cover.generationMetadata?.crop?.offsetX, cover.generationMetadata?.crop?.offsetY])

  useEffect(() => {
    setFeedbackReason(cover.feedback?.reason ?? '')
  }, [cover.feedback?.reason])

  const saveFeedback = async (status: CoverFeedback['status']): Promise<void> => {
    setSavingFeedback(true)
    setLocationError('')
    try {
      await window.api.updateCoverFeedback({ projectId, fileName: cover.fileName, status, reason: feedbackReason })
      onUpdated()
    } catch (err) {
      setLocationError(describeError(err))
    } finally {
      setSavingFeedback(false)
    }
  }

  useEffect(() => {
    let active = true
    setDataUrl(null)
    setPreviewError('')
    void window.api.readCover(projectId, cover.fileName).then((url) => {
      if (active) {
        setDataUrl(url)
        if (!url) setPreviewError('封面文件不存在或无法读取。')
      }
    }).catch((err) => { if (active) setPreviewError(describeError(err)) })
    return () => {
      active = false
    }
  }, [projectId, cover.fileName, previewRevision, previewRetry])

  useEffect(() => {
    if (!showCrop || !cover.originalFileName) return
    let active = true
    setOriginalLoading(true)
    setOriginalError('')
    void window.api.readCover(projectId, cover.originalFileName).then((url) => {
      if (active) {
        setOriginalDataUrl(url)
        if (!url) setOriginalError('原图不存在或无法读取，无法重新裁剪。')
      }
    }).catch((err) => { if (active) setOriginalError(describeError(err)) })
      .finally(() => { if (active) setOriginalLoading(false) })
    return () => { active = false }
  }, [showCrop, cover.originalFileName, projectId, previewRetry])

  const applyCrop = async (): Promise<void> => {
    if (savingCrop || generationBusy || !originalDataUrl) return
    setSavingCrop(true)
    setOriginalError('')
    try {
      await window.api.updateCoverCrop({ projectId, fileName: cover.fileName, offsetX: cropX, offsetY: cropY, fit: cropFit })
      onUpdated()
    } catch (err) {
      setOriginalError(describeError(err))
    } finally {
      setSavingCrop(false)
    }
  }

  useEffect(() => {
    if (!zoomed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZoomed(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomed])

  const handleShowInFolder = async (): Promise<void> => {
    setLocationError('')
    try {
      await window.api.showCoverInFolder(projectId, cover.fileName)
    } catch (err) {
      setLocationError(describeError(err))
    }
  }

  return (
    <div className="project-card" style={{ padding: 8, cursor: 'default' }}>
      <div
        style={{
          width: '100%',
          aspectRatio: '3 / 4',
          background: 'var(--surface-2)',
          borderRadius: 6,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
          cursor: dataUrl ? 'zoom-in' : 'default'
        }}
        onClick={() => dataUrl && setZoomed(true)}
        title={dataUrl ? '点击放大查看' : undefined}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={cover.fileName} onError={() => { setPreviewError('封面图片无法解码，请检查文件或重试。'); setDataUrl(null) }} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          previewError ? <div className="meta" role="alert" style={{ padding: 8, color: 'var(--danger)' }}>{previewError}<button className="btn btn-ghost" onClick={(event) => { event.stopPropagation(); setPreviewRetry((retry) => retry + 1) }}>重试预览</button></div> : <span className="meta">加载中…</span>
        )}
      </div>
      {zoomed && dataUrl
        ? createPortal(
            <div
              onClick={() => setZoomed(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 90,
                background: 'rgba(0, 0, 0, 0.82)',
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 32,
                cursor: 'zoom-out',
                animation: 'fadeIn 0.15s ease-out'
              }}
            >
              <img
                src={dataUrl}
                alt={cover.fileName}
                onClick={(e) => e.stopPropagation()}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: 8,
                  boxShadow: 'var(--shadow-lg)',
                  cursor: 'default'
                }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setZoomed(false)}
                style={{ position: 'fixed', top: 20, right: 24, fontSize: 13 }}
              >
                关闭 ✕
              </button>
            </div>,
            document.body
          )
        : null}
      <div style={{ fontSize: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 600 }}>
            v{cover.version}
            {cover.isUploadSize ? ' · 上传版' : ''}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '2px 8px', minHeight: 24, fontSize: 11 }}
            onClick={() => void handleShowInFolder()}
            title="在系统资源管理器中定位这张图片"
          >
            打开位置
          </button>
        </div>
        <div className="meta">
          {GENRE_LABELS[cover.genre]} · {(cover.size / 1024).toFixed(0)} KB
        </div>
        {cover.warnings?.length ? <ul className="meta" style={{ paddingLeft: 16, color: 'var(--danger)' }}>{cover.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        {cover.originalFileName ? <div style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={savingCrop} onClick={() => setShowCrop((shown) => !shown)}>{showCrop ? '收起原图与裁剪' : '原图与裁剪'}</button>
          {showCrop ? <div style={{ marginTop: 8 }}>
            {originalLoading ? <p className="meta">正在读取完整原图…</p> : null}
            {originalError ? <p role="alert" className="diag-msg" style={{ color: 'var(--danger)' }}>{originalError}<button className="btn btn-ghost" onClick={() => setPreviewRetry((retry) => retry + 1)}>重试读取</button></p> : null}
            {originalDataUrl ? <>
              <label className="meta"><input type="checkbox" checked={showFullOriginal} onChange={(event) => setShowFullOriginal(event.target.checked)} /> 查看完整原图</label>
              <div style={{ marginTop: 6, width: '100%', aspectRatio: showFullOriginal ? undefined : '3 / 4', overflow: 'hidden', background: '#f8f4ee', borderRadius: 6 }}>
                <img src={originalDataUrl} alt={showFullOriginal ? `${cover.fileName} 的模型完整原图` : `${cover.fileName} 的裁剪预览`} style={{ display: 'block', width: '100%', height: showFullOriginal ? 'auto' : '100%', objectFit: cropFit, objectPosition: coverCropObjectPosition(cropX, cropY) }} />
              </div>
              <div className="field" style={{ marginTop: 8 }}><label>成品方式</label><select aria-label={`${cover.fileName} 的裁剪方式`} className="input" value={cropFit} disabled={savingCrop || generationBusy} onChange={(event) => setCropFit(event.target.value as 'cover' | 'contain')}><option value="cover">填满 3:4，可调整取景</option><option value="contain">保留全图，浅色补边</option></select></div>
              {cropFit === 'cover' ? <>
                <label className="meta">水平取景 {Math.round(cropX * 100)}%<input aria-label={`${cover.fileName} 的水平取景`} type="range" min="0" max="1" step="0.01" value={cropX} disabled={savingCrop || generationBusy} onChange={(event) => setCropX(Number(event.target.value))} style={{ width: '100%' }} /></label>
                <label className="meta">垂直取景 {Math.round(cropY * 100)}%<input aria-label={`${cover.fileName} 的垂直取景`} type="range" min="0" max="1" step="0.01" value={cropY} disabled={savingCrop || generationBusy} onChange={(event) => setCropY(Number(event.target.value))} style={{ width: '100%' }} /></label>
              </> : null}
              <p className="meta">同时更新本版成品与平台上传版，完整原图保留。</p>
              <button type="button" className="btn btn-primary" disabled={savingCrop || savingFeedback || generationBusy || originalLoading} onClick={() => void applyCrop()}>{savingCrop ? '正在应用裁剪…' : '应用裁剪'}</button>
            </> : null}
          </div> : null}
        </div> : null}
        <div className="meta" style={{ marginTop: 5 }}>
          {cover.feedback?.status === 'adopted' ? '已采用' : cover.feedback?.status === 'rejected' ? '已淘汰' : '待评价'}
        </div>
        <textarea
          className="input"
          aria-label={`${cover.fileName} 的评价原因`}
          placeholder="原因，如书名清楚、人物不符、裁掉署名"
          value={feedbackReason}
          onChange={(event) => setFeedbackReason(event.target.value)}
          maxLength={1000}
          rows={2}
          style={{ width: '100%', marginTop: 6, fontSize: 12, resize: 'vertical' }}
        />
        <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" disabled={savingFeedback || savingCrop} onClick={() => void saveFeedback('adopted')}>采用</button>
          <button type="button" className="btn btn-ghost" disabled={savingFeedback || savingCrop} onClick={() => void saveFeedback('rejected')}>淘汰</button>
          <button type="button" className="btn btn-ghost" disabled={savingFeedback || savingCrop} onClick={() => void saveFeedback(cover.feedback?.status ?? 'unrated')}>保存原因</button>
          {cover.feedback && cover.feedback.status !== 'unrated' ? <button type="button" className="btn btn-ghost" disabled={savingFeedback || savingCrop} onClick={() => void saveFeedback('unrated')}>撤销评价</button> : null}
        </div>
        {cover.generationMetadata?.learningContext ? (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>本次使用的学习规则</summary>
            <p className="meta">版本 {cover.generationMetadata.learningContext.libraryVersion}</p>
            <ul style={{ paddingLeft: 16 }}>
              {cover.generationMetadata.learningContext.rules.map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
            {cover.generationMetadata.learningContext.sources?.length ? <p className="meta">依据：{cover.generationMetadata.learningContext.sources.join(' · ')}</p> : null}
          </details>
        ) : <p className="meta">该封面没有学习规则来源记录。</p>}
        {locationError ? <div style={{ color: 'var(--danger)', marginTop: 4 }}>{locationError}</div> : null}
      </div>
    </div>
  )
}

function CoverConfigDialog({
  config,
  onClose,
  onSaved
}: {
  config: CoverImageConfigSummary
  onClose: () => void
  onSaved: () => Promise<void> | void
}): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [model, setModel] = useState(config.model)
  const [channel, setChannel] = useState<'api' | 'codex' | 'grok'>(config.channel)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.api.setCoverImageConfig({
        apiKey: apiKey || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        channel
      })
      await onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const channelLabel: Record<'api' | 'codex' | 'grok', string> = {
    api: 'API Key（OpenAI / 兼容代理）',
    codex: 'codex CLI（ChatGPT 登录态，无需 Key）',
    grok: 'grok CLI（Grok 登录态，无需 Key）'
  }

  return (
    <div className="dialog-overlay" onClick={() => { if (!saving) onClose() }}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3>封面配置</h3>
        <p className="meta" style={{ marginTop: 4 }}>
          出图通道二选一：图像 API（OpenAI Images API / 兼容代理），或本机 CLI（codex / grok 登录态，无需 Key）。
        </p>

        <div className="field">
          <label>出图通道</label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(['api', 'codex', 'grok'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={`btn ${channel === c ? 'btn-primary' : 'btn-ghost'}`}
                 disabled={saving}
                onClick={() => setChannel(c)}
                style={{ fontSize: 12 }}
              >
                {channelLabel[c]}
              </button>
            ))}
          </div>
        </div>

        {channel === 'api' ? (
          <>
            <div className="field">
              <label>API Key {config.hasKey ? `（当前 ${config.keyMasked}，留空保留）` : '*'}</label>
              <input
                className="input"
                type="password"
                disabled={saving}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config.hasKey ? '留空保留当前 key' : 'sk-...'}
              />
            </div>
            <div className="field">
              <label>Base URL</label>
              <input
                className="input"
                value={baseUrl}
                disabled={saving}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="field">
              <label>模型</label>
              <input
                className="input"
                value={model}
                disabled={saving}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-image-2"
              />
            </div>
          </>
        ) : (
          <p className="meta" style={{ margin: '6px 0 10px' }}>
            {channel === 'codex'
              ? '内容与封面图均由本机 codex CLI 生成（ChatGPT 登录态），需要已执行过 codex login。出图约需 1-5 分钟。'
              : '内容与封面图均由本机 grok CLI 生成（Grok 登录态），需要已登录 grok。出图约需 1-5 分钟。'}
            {channel === 'grok' ? ' 参考图生图暂不支持，仅文生图。' : ''}
          </p>
        )}
        {error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
