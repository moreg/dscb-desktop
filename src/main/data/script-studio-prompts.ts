import type { z } from 'zod'
import { PACE_LABELS, rhythmProfile } from '../../shared/script-studio-planning'
import {
  FEATURE_SCRIPT,
  FEATURE_STORYBOARD,
  FEATURE_STORYBOARD_SEGMENT,
  OUTLINE_HINT_MAX_CHARS,
  SOURCE_MAX_CHARS,
  type ScriptProject,
  type ScriptSettings
} from '../../shared/script-studio'

export interface BuiltPrompt {
  system: string
  user: string
  feature: string
  maxTokens: number
}

export interface ClampResult {
  text: string
  truncated: boolean
  originalChars: number
  charCount: number
  notice: string
}

/**
 * 按 Unicode 码点截断来源文本。超限时把截断声明写进文本本身，
 * 保证提示词里显式标注，绝不静默截断。
 */
export function clampSourceText(text: string): ClampResult {
  const chars = Array.from(text)
  const originalChars = chars.length
  if (originalChars <= SOURCE_MAX_CHARS) {
    return { text, truncated: false, originalChars, charCount: originalChars, notice: '' }
  }
  const notice = `【来源截断提示】原始选材共 ${originalChars} 字，超过上下文上限 ${SOURCE_MAX_CHARS} 字；下面只保留前 ${SOURCE_MAX_CHARS} 字，结尾可能不完整。不得根据截断处推断后续剧情，也不得把截断位置当作结局。`
  return {
    text: `${notice}\n\n${chars.slice(0, SOURCE_MAX_CHARS).join('')}`,
    truncated: true,
    originalChars,
    charCount: SOURCE_MAX_CHARS,
    notice
  }
}

/** 大纲只作计划参考，同样不得静默超长。 */
export function clampOutlineHint(hint: string): ClampResult {
  const chars = Array.from(hint)
  if (chars.length <= OUTLINE_HINT_MAX_CHARS) {
    return { text: hint, truncated: false, originalChars: chars.length, charCount: chars.length, notice: '' }
  }
  const notice = `【大纲截断提示】原始大纲提示共 ${chars.length} 字，只保留前 ${OUTLINE_HINT_MAX_CHARS} 字；大纲仅是计划，不是事实。`
  return {
    text: `${notice}\n${chars.slice(0, OUTLINE_HINT_MAX_CHARS).join('')}`,
    truncated: true,
    originalChars: chars.length,
    charCount: OUTLINE_HINT_MAX_CHARS,
    notice
  }
}

const SHORT_SCRIPT_RULES = `【短剧：严格 M1 标准影视剧本】
- 每个场景必须以「场景号 日/夜 内/外 地点」开头，例如：SC1 日 内 老宅书房。场景号连续、不跳号。
- 动作行（无角色名的独立行）只写摄影机拍得到的内容：人物动作、道具变化、环境变化、可见反应。
- 角色名单独成行，紧接着写对白行；对白必须是可直接拍摄、可直接说出口的中文口语。
- 严禁出现：内心独白、心理描写、导演意图、镜头术语、情绪注解、「他心想」「她意识到」「旁白解说剧情」、小说式叙述、把原文换个标题就交差。
- 不得写分镜表、时间码、画幅、分辨率或任何平台参数。`

const COMIC_SCRIPT_RULES = `【漫剧：共用结构化场景底座，并强制漫画化表达】
- 与短剧共用同一套结构化场景底座：场景号、日/夜、内/外、地点、动作行、角色名、对白，逐字保留可拍摄的戏剧动作。
- 必须额外输出 comicExtras，且四个字段都要有实质内容：
  · keyFrames：本集最关键的画面（关键格），每格写清可见主体、动作与画面落点；
  · narration：旁白／画外音文案，写可录制的句子，不写"此处应有旁白"；
  · visualStyle：统一的视觉风格、线条与上色倾向，文字可执行；
  · transitions：画面切换方式（如翻页、叠化、分格切、速度线转场），逐条写清从哪个画面到哪个画面。
- 突出「关键画面 / 旁白画外音 / 视觉风格 / 画面切换」四件事；不要只把对白拆成分格。
- 严禁内心独白、导演意图、平台参数、原文换标题。`

const COMMON_SCRIPT_RULES = `你是短剧／漫剧编剧。任务：把 user 提供的小说片段【重组改写】成一个完整、可拍摄的剧本。

【事实边界】
- 小说正文是唯一事实来源；大纲／梗概只是写作计划，不是已发生的事实，不得用大纲替换或补写正文。
- 不写回、不修改小说正文、大纲与记忆；只输出剧本 JSON。
- 必须重组为【一个完整戏剧单元】：集首有明确推进（有人做了什么、局面因此改变），结尾有落点（悬念／反转／决断／代价），不是原文摘录、不是分段搬运、不是原文换标题。
- 所有心理活动必须转写为可见动作、对白或可拍摄画面；禁止「心想」「意识到」「感到」等内部描写。
- 至少列出 1 条真实改编风险（信息量压缩、人物动机简化、时间线合并、场景合并导致因果变化、台词补写等），不得写「无风险」。
- 不虚构原文没有的关键事实；必要的衔接动作可新增，但必须写进 additions 并在 risks 里说明其影响。
- tentative 列出仍属暂定、需作者确认的设定（如未明确的角色外貌、道具样式、地点细节）。
- 创作笔记必须核对目标时长、前3秒/前15秒/前30秒任务、核心情绪、取舍、不满意点和功能性停顿，短于对应节点的作品不强塞后续节点。

【只输出 JSON】可包在 \`\`\`json 代码块里，但代码块外不要有任何解释文字。JSON 结构：
{
  "body": "完整剧本正文（M1 格式）",
  "adaptationNote": "改编说明：如何重组、集首推进与结尾落点",
  "tentative": ["暂定项"],
  "additions": ["新增的可见动作或衔接"],
  "characters": ["角色清单"],
  "scenes": ["场景清单"],
  "props": ["道具清单"],
  "creativeNotes": "创作笔记",
  "risks": ["至少一条真实风险"],
  "comicExtras": { "keyFrames": [], "narration": [], "visualStyle": "", "transitions": [] }
}
comicExtras 仅漫剧必填，短剧可省略。`

const STORYBOARD_RULES = `你是分镜导演。任务：把 user 提供的【当前正式稿剧本】拆成可执行的结构化视频分镜。

【事实边界】
- 只依据当前正式稿剧本正文；不参考小说原文、大纲或记忆，不新增剧情，不改写、精简、翻译、替换任何台词。
- 按情绪转折与戏剧动作切分单元：每个单元 ${'4–15'} 秒，且为 0.5 秒的倍数；一个单元内可含 1 个或多个镜头。
- 每个镜头必须填满以下 11 个字段且全部非空：focalLength（焦段）、aperture（光圈）、depthOfFieldAndFocusLock（景深与焦点锁定）、cameraPosition（机位）、composition（构图）、cameraMovement（运镜）、subjectActionExpression（主体动作与表情）、dialogueAndTone（台词与语气）、lighting（光影）、constraints（限制）、nextTransition（衔接）。
- 没有对白时 dialogueAndTone 写「无对白」；有对白时逐字保留原剧本台词，并单独写语气，台词与语气都放在这一字段里。
- 抽象心理词（内心、思绪、意识到、感到、回忆、仿佛、似乎）必须转成可见画面；不写「表现他的纠结」，写他做了什么。
- 光影、限制、衔接必须是可执行指令：能直接指导画面生成的程度，不要写「注意氛围」「保持统一」这类空话。
- 严禁出现任何 @图片N、@图N、@ImageN、@视频N 之类的素材编号；本阶段没有任何参考图。
- 严禁管理话术：未启用、不使用上一段、不继承、无则删除、没有则删除、不替代、普通段不强制、接下一段、承接下一段、接分镜N、本段为。
- 严禁平台参数：画幅、分辨率、时长数值、任务类型、模式、时间码、内部编号。
- 严禁「极快语速」「快速念完」这类靠加速台词塞时间的写法；台词说不完就建议延长单元、拆段或回剧本精简。
- 首末帧、连续性建议、人物位置、资产引用都只写可见内容；assetRefs 恒为空数组。
- 按目标单集时长规划完整 units，总时长尽量控制在目标 ±10%；台词自然说完优先，不得为了凑时长删改台词，冲突时明确说明。
- paceMode=auto 时按剧情、对白、信息增量、动作密度为每段自动判档；manual 时继承指定档位。四档为 cinematic-mid（电影感中速）、short-high（短视频中高密度）、high-hook（高密度动作或强钩子）、slow-info（慢节奏但高信息）。
- 时长×镜头密度：电影感中速在4-6/7-9/10-12/13-15秒分别1-2/2-3/3-5/4-6镜；短视频中高密度分别2/3-4/4-6/6-8镜；高密度动作或强钩子分别2-3/4-5/5-7/7-10镜。10秒以上只有1-2镜必须在 slowMotionPurpose 写清功能和白名单理由。
- 每段 paceExecution 写给下游的具体摄影机节奏、动作密度和转接执行，不只重复档位名；slowMotionPurpose 写慢镜头承担的信息、情绪或关系变化，普通段可空。
- 每镜 functionLabel 按剧情增量提炼，例如证据露出、选择逼近、威胁落点，不固定套用一组标签。
- 有对白必须写成 角色名：「逐字原台词」；语气：……；音量：……；语速：自然；口型：同步，不得合并、重复或遗漏对白轮次。
- 运镜写清摄影机位置、距离、高度、方向、速度、稳定和起止；光影写清光源、方向、亮暗区、脸部受光、背景分离、色温和反差；限制写清保持项和禁止项。
- boundaryPlan 判断相邻段应采用普通衔接、视频延长、首帧图、调度图或首帧图+调度图，说明原因；enhancementAdvice 按需推荐 FF/SCV/MAP/SB/CR/PR，未具备素材时只作外部交接建议，不编造引用。
- 动作戏必须明确动作发起、接触点、受力结果与局面变化；一镜到底、强遮挡或多人走位时给出复杂运镜增强建议。

【只输出 JSON】可包在 \`\`\`json 代码块里，代码块外不要有任何解释文字。JSON 结构：
{
  "units": [
    {
      "id": "unit-1",
      "index": 1,
      "durationSec": 8,
      "emotion": "本单元情绪",
      "dramaticAction": "本单元戏剧动作",
      "paceTier": "short-high | high-hook | cinematic-mid | slow-info",
      "paceReason": "选这一档节奏的理由",
      "suggestedShotCount": 2,
      "firstFrame": "首帧可见状态",
      "lastFrame": "末帧可见状态",
      "continuity": "与上一段的可见连续性建议",
      "characterPositions": "人物位置与走位",
      "paceExecution": "下游镜头轨的具体节奏执行",
      "slowMotionPurpose": "慢镜头功能或空字符串",
      "boundaryPlan": "与上一段的生成边界建议及理由",
      "enhancementAdvice": [],
      "assetRefs": [],
      "shots": [
        {
          "functionLabel": "按剧情生成的镜头功能", "focalLength": "", "aperture": "", "depthOfFieldAndFocusLock": "",
          "cameraPosition": "", "composition": "", "cameraMovement": "",
          "subjectActionExpression": "", "dialogueAndTone": "", "lighting": "",
          "constraints": "", "nextTransition": ""
        }
      ]
    }
  ]
}`

function settingsBlock(settings: ScriptSettings): string {
  const profile = rhythmProfile(settings)
  return [
    `剧本形态：${settings.format === 'comic' ? '漫剧' : '短剧'}`,
    `改编幅度：${settings.adaptStrength}`,
    `发布平台：${settings.platform}；目标受众：${settings.targetAudience?.trim() || '【暂定】该题材的短剧/漫剧观众'}`,
    `目标单集时长：${settings.targetDurationSec} 秒（规划参数，不写入剧本或最终视频提示词正文）`,
    `paceMode=${settings.paceMode ?? 'manual'}；${settings.paceMode === 'auto' ? '逐段自动判断，默认参考' : '用户指定'}节奏档位：${PACE_LABELS[settings.paceTier]}`,
    `前3秒任务：${profile.first3}`,
    `前15秒任务：${profile.first15}`,
    `前30秒任务：${profile.first30}`,
    `呼吸感许可：${profile.breathing}`,
    `禁止拖慢点：${profile.avoidDragging}`,
    `完播与互动目标：${profile.completionGoal}`,
    `补充要求：${settings.extraRequirements.trim() || '（无）'}`
  ].join('\n')
}

/** 小说 → 剧本候选。只做第一次 LLM 调用。 */
export function buildScriptPrompt(project: ScriptProject, instruction?: string): BuiltPrompt {
  const isComic = project.settings.format === 'comic'
  const system = `${COMMON_SCRIPT_RULES}\n\n${isComic ? COMIC_SCRIPT_RULES : SHORT_SCRIPT_RULES}`
  const source = clampSourceText(project.source.text)
  const outline = clampOutlineHint(project.source.outlineHint)
  const parts: string[] = [
    '## 创作设定',
    settingsBlock(project.settings),
    '',
    '## 大纲提示（仅为计划，不是事实；不得据此补写正文）',
    outline.text.trim() || '（未提供大纲）',
    '',
    '## 小说正文（唯一事实来源）',
    source.text
  ]
  if (source.truncated || project.source.truncated) {
    parts.push('', '【重要】本次来源已被截断，请在 adaptationNote 与 risks 中明确写出「来源不完整」这一事实，不要把截断处当结局。')
  }
  if (instruction?.trim()) parts.push('', '## 本次补充指令', instruction.trim())
  parts.push('', '请按 system 要求输出且只输出 JSON。')
  return { system, user: parts.join('\n'), feature: FEATURE_SCRIPT, maxTokens: 8000 }
}

/** 已保存剧本 → 结构化分镜。只做第二次 LLM 调用；unitId 存在时为按段重生成。 */
export function buildStoryboardPrompt(project: ScriptProject, unitId?: string): BuiltPrompt {
  const version = project.scriptVersions.find(item => item.id === project.activeVersionId)
  const body = version?.body?.trim() ?? ''
  const parts: string[] = [
    '## 当前正式稿剧本（唯一依据）',
    body || '（正式稿为空，无法生成分镜）',
    '',
    '## 切分参数',
    settingsBlock(project.settings)
  ]
  if (unitId) {
    const unit = project.storyboard?.units.find(item => item.id === unitId)
    parts.push('', '## 按段重生成', `只重生成 id 为 ${unitId} 的单元，其余单元不要输出。`)
    if (unit) {
      parts.push(`该单元原有信息：时长 ${unit.durationSec} 秒；情绪 ${unit.emotion}；戏剧动作 ${unit.dramaticAction}；节奏档位 ${unit.paceTier}；理由 ${unit.paceReason}。`)
      parts.push(`原单元完整记录（对白只能取自本单元，必须全部逐字保留，禁止挪用其他单元台词）：\n${JSON.stringify(unit)}`)
      const at = project.storyboard!.units.indexOf(unit)
      const previous = project.storyboard!.units[at - 1]
      const next = project.storyboard!.units[at + 1]
      if (previous) parts.push(`前单元可见末态：${previous.lastFrame}`)
      if (next) parts.push(`后单元可见首态：${next.firstFrame}`)
      parts.push('重生成时保持与该单元前后可见状态的衔接，不得改写剧本台词。')
    }
    parts.push('只输出含这 1 个单元的 JSON。')
  } else {
    parts.push('', '请覆盖整份正式稿，输出完整 units 数组。')
  }
  return {
    system: STORYBOARD_RULES,
    user: parts.join('\n'),
    feature: unitId ? FEATURE_STORYBOARD_SEGMENT : FEATURE_STORYBOARD,
    maxTokens: 24000
  }
}

export interface ParseStructuredResult<T> {
  ok: boolean
  data?: T
  /** 剧本 JSON 解析失败时降级为 Markdown 候选。 */
  parseFallback: boolean
  fallbackText?: string
  retainedText: string
  error?: string
}

function stripFences(text: string): string {
  return text.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '').trim()
}

/** 平衡括号截取文本中第一个完整 JSON 对象。 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 三级降级解析：
 * 1) 裸 JSON / ```json fence；
 * 2) 平衡括号截取首个对象再解析；
 * 3) 剧本可降级为 Markdown 候选（parseFallback=true）；分镜解析失败直接返回失败与 retainedText。
 * 绝不发起第三次模型修复调用。
 */
export function parseStructured<T>(
  text: string,
  schema: z.ZodSchema<T>,
  options: { markdownFallback?: boolean } = {}
): ParseStructuredResult<T> {
  const retainedText = text
  const fenceMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  const candidates = [
    stripFences(text),
    fenceMatch ? stripFences(fenceMatch[1]) : '',
    extractFirstJsonObject(text) ?? '',
    fenceMatch ? (extractFirstJsonObject(fenceMatch[1]) ?? '') : ''
  ]
  for (const candidate of candidates) {
    if (!candidate.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const result = schema.safeParse(parsed)
    if (result.success) return { ok: true, data: result.data, parseFallback: false, retainedText }
  }
  if (options.markdownFallback && text.trim()) {
    return { ok: true, parseFallback: true, fallbackText: text.trim(), retainedText }
  }
  return { ok: false, parseFallback: false, retainedText, error: 'SCRIPT_PARSE_FAILED' }
}
