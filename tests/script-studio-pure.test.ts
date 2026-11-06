import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  FEATURE_SCRIPT,
  FEATURE_STORYBOARD,
  FEATURE_STORYBOARD_SEGMENT,
  MAX_UNIT_SEC,
  MIN_UNIT_SEC,
  PROMPT_HARD_LIMIT,
  PROMPT_SOFT_LIMIT,
  SCRIPT_SCHEMA_VERSION,
  SHOT_FIELDS,
  SOURCE_MAX_CHARS,
  storyboardHardIssues,
  type BasedOn,
  type PromptPackage,
  type ScriptProject,
  type ScriptSettings,
  type Shot11,
  type StoryboardUnit
} from '../src/shared/script-studio'
import {
  buildScriptPrompt,
  buildStoryboardPrompt,
  clampOutlineHint,
  clampSourceText,
  extractFirstJsonObject,
  parseStructured
} from '../src/main/data/script-studio-prompts'
import {
  buildPromptPackage,
  buildPromptPackages,
  compressBody,
  countChars,
  renderMarkdown,
  validatePackage,
  validateStoryboard
} from '../src/main/data/script-prompt-kit'
import { scriptStructuredOutputSchema, storyboardStructuredOutputSchema } from '../src/shared/script-studio'
import { featureCategoryOf } from '../src/shared/agent-tasks'
import { scriptSettingsSchema, storyboardUnitSchema, promptPackageSchema } from '../src/shared/script-studio'
import { paceExecution, rhythmProfile, shotDensity } from '../src/shared/script-studio-planning'
import { scriptDialogue, shotDialogue, dialogueIssues, unitDialogueIssues } from '../src/main/data/script-dialogue'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const VERSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3302'
const HEX = 'a'.repeat(64)

const settings: ScriptSettings = {
  format: 'short',
  platform: '抖音',
  aspectRatio: '9:16',
  targetDurationSec: 90,
  visualStyle: '暂定',
  adaptStrength: 'medium',
  paceTier: 'short-high',
  resolution: '1080p',
  extraRequirements: ''
}

function shot(overrides: Partial<Shot11> = {}): Shot11 {
  const base = Object.fromEntries(SHOT_FIELDS.map(field => [field, `${field} 的可执行描述`])) as Shot11
  return { ...base, subjectActionExpression: '林远把账册推过桌面，指节收紧', dialogueAndTone: '无对白', ...overrides }
}

function unit(overrides: Partial<StoryboardUnit> = {}): StoryboardUnit {
  return {
    id: 'unit-1',
    index: 1,
    durationSec: 8,
    emotion: '紧绷',
    dramaticAction: '林远交出账册，守门人伸手去接',
    paceTier: 'short-high',
    paceReason: '开场需要高密度推进',
    suggestedShotCount: 1,
    firstFrame: '林远站在书桌前，账册摊开',
    lastFrame: '账册停在桌沿，守门人的手进入画面',
    continuity: '账册位置与上一段末帧一致',
    characterPositions: '林远画面左侧，守门人右侧入画',
    assetRefs: [],
    shots: [shot()],
    ...overrides
  }
}

function basedOn(overrides: Partial<BasedOn> = {}): BasedOn {
  return {
    projectId: PROJECT_ID,
    projectName: '测试项目',
    versionId: VERSION_ID,
    versionNumber: 1,
    contentFingerprint: HEX,
    scriptFingerprint: HEX,
    storyboardFingerprint: HEX,
    sourceFingerprint: HEX,
    scriptRevision: 1,
    unitId: 'unit-1',
    stale: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function project(overrides: Partial<ScriptProject> = {}): ScriptProject {
  return {
    schemaVersion: SCRIPT_SCHEMA_VERSION,
    id: PROJECT_ID,
    title: '测试项目',
    settings,
    source: {
      kind: 'pasteNovel',
      text: '林远把账册交给守门人。守门人让他在门外等候。',
      ranges: [{ kind: 'paste', label: '粘贴文本' }],
      outlineHint: '只是计划',
      sourceFingerprint: HEX,
      truncated: false,
      charCount: 24,
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    candidate: null,
    scriptVersions: [{ id: VERSION_ID, number: 1, body: 'SC1 日 内 老宅书房\n林远把账册推过桌面。', note: '', sourceFingerprint: HEX, createdAt: '2026-01-01T00:00:00.000Z' }],
    activeVersionId: VERSION_ID,
    storyboard: null,
    revision: 1,
    contentFingerprint: HEX,
    scriptFingerprint: HEX,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

const validScriptJson = JSON.stringify({
  body: 'SC1 日 内 老宅书房\n林远把账册推过桌面。\n林远\n把账册给我。',
  adaptationNote: '把两段合并为一个完整戏剧单元，集首推进、结尾落点明确',
  tentative: ['守门人外貌暂定'],
  additions: ['推账册的可见动作'],
  characters: ['林远', '守门人'],
  scenes: ['老宅书房'],
  props: ['账册'],
  creativeNotes: '压缩了环境描写',
  risks: ['时间线合并导致因果简化']
})

const validStoryboardJson = JSON.stringify({ units: [unit()] })

describe('剧本创作共享契约与路由', () => {
  it('常量、feature 名、11 字段顺序固定且渲染层镜像一致', () => {
    expect(SCRIPT_SCHEMA_VERSION).toBe(1)
    expect(SOURCE_MAX_CHARS).toBe(24_000)
    expect(PROMPT_SOFT_LIMIT).toBe(1900)
    expect(PROMPT_HARD_LIMIT).toBe(2000)
    expect(MIN_UNIT_SEC).toBe(4)
    expect(MAX_UNIT_SEC).toBe(15)
    expect(FEATURE_SCRIPT).toBe('script:novel-to-script')
    expect(FEATURE_STORYBOARD).toBe('script:storyboard')
    expect(FEATURE_STORYBOARD_SEGMENT).toBe('script:storyboard:segment')
    expect(SHOT_FIELDS).toEqual([
      'focalLength', 'aperture', 'depthOfFieldAndFocusLock', 'cameraPosition', 'composition',
      'cameraMovement', 'subjectActionExpression', 'dialogueAndTone', 'lighting', 'constraints',
      'nextTransition'
    ])
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/ScriptStudioPage.tsx'), 'utf8')
    const match = source.match(/const SHOT_FIELDS[^=]*=\s*\[([\s\S]*?)\]/)
    expect(match).toBeTruthy()
    const mirrored = match ? [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]) : []
    expect(mirrored).toEqual([...SHOT_FIELDS])
  })

  it('3 个新 feature 全部路由到 auxiliary，segment 精确匹配', () => {
    expect(featureCategoryOf(FEATURE_SCRIPT)).toBe('auxiliary')
    expect(featureCategoryOf(FEATURE_STORYBOARD)).toBe('auxiliary')
    expect(featureCategoryOf(FEATURE_STORYBOARD_SEGMENT)).toBe('auxiliary')
  })
})

describe('上下文截断与结构化解析', () => {
  it('未超限不改动文本且 explicit notice 为空', () => {
    const result = clampSourceText('短文本')
    expect(result).toMatchObject({ truncated: false, text: '短文本', originalChars: 3, charCount: 3, notice: '' })
  })

  it('超过 24k 字符按码点截断并把截断声明写进文本，不静默', () => {
    const text = '文'.repeat(SOURCE_MAX_CHARS + 500)
    const result = clampSourceText(text)
    expect(result.truncated).toBe(true)
    expect(result.originalChars).toBe(SOURCE_MAX_CHARS + 500)
    expect(result.charCount).toBe(SOURCE_MAX_CHARS)
    expect(result.text).toContain('【来源截断提示】')
    expect(result.text).toContain('不得根据截断处推断后续剧情')
    expect(result.text.startsWith('【来源截断提示】')).toBe(true)
  })

  it('大纲提示同样显式截断且标注「仅是计划」', () => {
    const result = clampOutlineHint('纲'.repeat(1500))
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('大纲仅是计划，不是事实')
  })

  it('parseStructured 支持裸 JSON、```json fence 与平衡括号截取', () => {
    const bare = parseStructured(validScriptJson, scriptStructuredOutputSchema)
    expect(bare.ok).toBe(true)
    expect(bare.data?.risks).toHaveLength(1)
    const fenced = parseStructured(`说明文字\n\`\`\`json\n${validScriptJson}\n\`\`\`\n尾部`, scriptStructuredOutputSchema)
    expect(fenced.ok).toBe(true)
    expect(fenced.data?.body).toContain('SC1')
    const wrapped = parseStructured(`前缀噪声 ${validScriptJson} 尾巴`, scriptStructuredOutputSchema)
    expect(wrapped.ok).toBe(true)
    expect(wrapped.data?.body).toContain('SC1')
    expect(extractFirstJsonObject('xx {"a":{"b":1}} yy')).toBe('{"a":{"b":1}}')
  })

  it('分镜结构化输出可解析且 11 字段齐全', () => {
    const parsed = parseStructured(validStoryboardJson, storyboardStructuredOutputSchema)
    expect(parsed.ok).toBe(true)
    expect(parsed.parseFallback).toBe(false)
    expect(parsed.data?.units[0].shots[0]).toHaveProperty('nextTransition')
    for (const field of SHOT_FIELDS) expect(parsed.data?.units[0].shots[0][field]).toBeTruthy()
  })

  it('剧本解析失败降级为 Markdown 候选且 parseFallback=true；分镜失败返回 retainedText 不做第三次修复', () => {
    const markdown = '# SC1 日 内 书房\n\n林远把账册推过桌面。'
    const scriptResult = parseStructured(markdown, scriptStructuredOutputSchema, { markdownFallback: true })
    expect(scriptResult.ok).toBe(true)
    expect(scriptResult.parseFallback).toBe(true)
    expect(scriptResult.fallbackText).toBe(markdown)
    expect(scriptResult.retainedText).toBe(markdown)

    const storyboardResult = parseStructured(markdown, storyboardStructuredOutputSchema)
    expect(storyboardResult.ok).toBe(false)
    expect(storyboardResult.error).toBe('SCRIPT_PARSE_FAILED')
    expect(storyboardResult.retainedText).toBe(markdown)
    expect(storyboardResult.parseFallback).toBe(false)
  })

  it('JSON 结构不合法（缺 risks / 缺 units）时不误判为成功', () => {
    expect(parseStructured('{"body":"x"}', scriptStructuredOutputSchema).ok).toBe(false)
    expect(parseStructured('{"units":[]}', storyboardStructuredOutputSchema).ok).toBe(false)
  })
})

describe('两次 LLM 的 system 提示', () => {
  const p = project()

  it('小说→剧本：正文唯一事实、大纲仅计划、重组完整戏剧单元、心理转可见动作、至少一条真实风险', () => {
    const prompt = buildScriptPrompt(p)
    expect(prompt.feature).toBe(FEATURE_SCRIPT)
    expect(prompt.maxTokens).toBeGreaterThan(0)
    expect(prompt.system).toContain('唯一事实来源')
    expect(prompt.system).toContain('只是写作计划')
    expect(prompt.system).toContain('一个完整戏剧单元')
    expect(prompt.system).toContain('集首有明确推进')
    expect(prompt.system).toContain('结尾有落点')
    expect(prompt.system).toContain('心理活动必须转写为可见动作')
    expect(prompt.system).toContain('至少列出 1 条真实改编风险')
    expect(prompt.system).toContain('原文换标题')
    expect(prompt.user).toContain('大纲提示（仅为计划，不是事实')
    expect(prompt.user).toContain(p.source.text)
  })

  it('短剧严格 M1 标准；漫剧共用场景底座并强制 comicExtras 四要素', () => {
    const shortPrompt = buildScriptPrompt(p)
    expect(shortPrompt.system).toContain('M1 标准影视剧本')
    expect(shortPrompt.system).toContain('场景号 日/夜 内/外 地点')
    expect(shortPrompt.system).toContain('严禁出现：内心独白')
    expect(shortPrompt.system).not.toContain('必须额外输出 comicExtras')

    const comicPrompt = buildScriptPrompt(project({ settings: { ...settings, format: 'comic' } }))
    expect(comicPrompt.system).toContain('共用结构化场景底座')
    expect(comicPrompt.system).toContain('必须额外输出 comicExtras')
    expect(comicPrompt.system).toContain('keyFrames')
    expect(comicPrompt.system).toContain('narration')
    expect(comicPrompt.system).toContain('visualStyle')
    expect(comicPrompt.system).toContain('transitions')
    expect(comicPrompt.system).toContain('旁白／画外音')
    expect(comicPrompt.system).toContain('画面切换')
  })

  it('来源被截断时提示里显式标注，不得静默', () => {
    const prompt = buildScriptPrompt(project({
      source: { ...p.source, text: '文'.repeat(SOURCE_MAX_CHARS + 100), truncated: true }
    }))
    expect(prompt.user).toContain('【来源截断提示】')
    expect(prompt.user).toContain('本次来源已被截断')
  })

  it('剧本→分镜：只依据正式稿、4–15 秒、11 字段、无对白、禁素材编号/管理话术/平台参数', () => {
    const prompt = buildStoryboardPrompt(p)
    expect(prompt.feature).toBe(FEATURE_STORYBOARD)
    expect(prompt.system).toContain('当前正式稿剧本')
    expect(prompt.system).toContain('4–15 秒')
    expect(prompt.system).toContain('0.5 秒的倍数')
    for (const field of SHOT_FIELDS) expect(prompt.system).toContain(field)
    expect(prompt.system).toContain('无对白')
    expect(prompt.system).toContain('@图片N')
    expect(prompt.system).toContain('未启用')
    expect(prompt.system).toContain('极快语速')
    expect(prompt.system).toContain('assetRefs 恒为空数组')
    expect(prompt.user).toContain('SC1 日 内 老宅书房')
    const segment = buildStoryboardPrompt(p, 'unit-1')
    expect(segment.feature).toBe(FEATURE_STORYBOARD_SEGMENT)
    expect(segment.user).toContain('只重生成 id 为 unit-1 的单元')
  })
})

describe('C 导演轨与纯净正文', () => {
  const pkg = buildPromptPackage(unit(), settings, basedOn())

  it('9 段顺序固定，按需段（参考-连续性/风格锁定）整段省略', () => {
    const order = ['【特别注意】', '【素材锚定】', '【场景锚定】', '【镜头轨】', '【声音轨】', '【硬锁】', '【段末状态】']
    const positions = order.map(section => pkg.body.indexOf(section))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(pkg.body).not.toContain('【参考-连续性声明】')
    expect(pkg.body).not.toContain('【风格锁定】')
    expect(pkg.body).not.toContain('未启用')
    expect(pkg.body).toContain('本段不使用参考图，按以下文字描述生成画面。')
  })

  it('参数全部外置：body 无画幅/分辨率/时长/任务类型/模式/硬时间码/内部编号', () => {
    for (const forbidden of ['9:16', '1080p', '分辨率', '时长', '任务类型', '文生视频', '时间码', '@图片']) {
      expect(pkg.body).not.toContain(forbidden)
    }
    expect(pkg.meta.aspectRatio).toBe('9:16')
    expect(pkg.meta.resolution).toBe('1080p')
    expect(pkg.meta.durationSec).toBe(8)
    expect(pkg.meta.taskType).toBe('文生视频')
    expect(pkg.meta.mode).toBe('C')
    expect(pkg.meta.schemaVersion).toBe(SCRIPT_SCHEMA_VERSION)
  })

  it('镜头轨合并 11 字段、台词逐字保留、无对白写「无对白」、声音轨不生成 BGM', () => {
    for (const field of SHOT_FIELDS) {
      if (field === 'subjectActionExpression' || field === 'dialogueAndTone') continue
      expect(pkg.body).toContain(`${field} 的可执行描述`)
    }
    expect(pkg.body).toContain('林远把账册推过桌面，指节收紧')
    expect(pkg.body).toContain('无对白')
    expect(pkg.body).toContain('不生成背景音乐')
    expect(pkg.body).toContain('禁止额外人物')
    expect(pkg.body).toContain('禁止复制同一道具')
    expect(pkg.body).toContain('禁止字幕')
    expect(pkg.body).toContain('账册停在桌沿')

    const withDialogue = buildPromptPackage(
      unit({ shots: [shot({ dialogueAndTone: '林远：「把账册给我。」语气低沉。' })] }),
      settings, basedOn()
    )
    expect(withDialogue.body).toContain('把账册给我。')
    expect(withDialogue.body).toContain('语气低沉')
    expect(withDialogue.quality.errors.filter(item => item.code === 'DIALOGUE_REWRITTEN')).toHaveLength(0)
  })

  it('风格锁定时才出现风格锁定段，暂定时整段省略', () => {
    const styled = buildPromptPackage(unit(), { ...settings, visualStyle: '赛璐璐平涂、粗线条' }, basedOn())
    expect(styled.body).toContain('【风格锁定】')
    expect(styled.body).toContain('赛璐璐平涂、粗线条')
    expect(pkg.body).not.toContain('【风格锁定】')
  })

  it('正常分镜字数≤1900 且质量闸门通过', () => {
    expect(pkg.charCount).toBeLessThanOrEqual(PROMPT_SOFT_LIMIT)
    expect(pkg.quality.compressed).toBe(false)
    expect(pkg.quality.ok).toBe(true)
    expect(pkg.quality.errors).toHaveLength(0)
  })
})

describe('字数、压缩与硬阻断', () => {
  it('按 Unicode 码点去空白计数', () => {
    expect(countChars('a b\nc')).toBe(3)
    expect(countChars('😀 中文')).toBe(3)
    expect(countChars('  \n\t ')).toBe(0)
  })

  it('压缩去重复行/空泛形容，但绝不删镜头、台词、段末钩子、焦点/光影', () => {
    const sample = [
      '【特别注意】只按以下文字描述生成画面；焦点与光影必须按镜头轨执行。',
      '【场景锚定】非常需要注意的场景。',
      '【场景锚定】非常需要注意的场景。',
      '【镜头轨】',
      '镜头1：使用 50mm 定焦，焦点锁定在林远手上，光影从左侧窗进来。林远：「把账册给我。」',
      '【段末状态】林远把账册放到桌上。'
    ].join('\n')
    const compressed = compressBody(sample)
    expect(compressed).not.toContain('非常')
    expect(compressed.split('【场景锚定】').length - 1).toBe(1)
    expect(compressed).toContain('镜头1：使用 50mm 定焦')
    expect(compressed).toContain('把账册给我。')
    expect(compressed).toContain('【段末状态】林远把账册放到桌上。')
    expect(compressed).toContain('焦点')
    expect(compressed).toContain('光影')
  })

  it('单包超过 2000 字压缩一轮仍超限时硬阻断，批量构建另做拆段', () => {
    const manyShots = Array.from({ length: 22 }, () => shot({
      subjectActionExpression: '林远把账册推过桌面，守门人伸手去接，指节收紧，账册停在桌沿，画面里只有这两个人与这一本账册。'.repeat(3)
    }))
    const huge = buildPromptPackage(unit({ shots: manyShots }), settings, basedOn())
    expect(huge.quality.compressed).toBe(true)
    expect(huge.charCount).toBeGreaterThan(PROMPT_HARD_LIMIT)
    expect(huge.quality.ok).toBe(false)
    expect(huge.quality.errors.some(item => item.code === 'PROMPT_TOO_LONG')).toBe(true)
    expect(huge.quality.errors.some(item => item.message.includes('镜头边界'))).toBe(true)
    expect(huge.body).toContain('【段末状态】')
    expect(huge.body).toContain('1｜')
    expect(huge.body).toContain('22｜')
  })
})

describe('分镜质量闸门', () => {
  it('4–15 秒且 0.5 倍数边界', () => {
    for (const value of [3.5, 3, 15.5, 16, 4.2, 7.3]) {
      const report = validateStoryboard([unit({ durationSec: value })], settings)
      expect(report.errors.some(item => item.code === 'UNIT_DURATION')).toBe(true)
    }
    for (const value of [4, 4.5, 8, 14.5, 15]) {
      const report = validateStoryboard([unit({ durationSec: value })], settings)
      expect(report.errors.some(item => item.code === 'UNIT_DURATION')).toBe(false)
    }
  })

  it('11 字段全部非空，缺一即硬阻断', () => {
    const broken = shot()
    broken.lighting = '  '
    const report = validateStoryboard([unit({ shots: [broken] })], settings)
    expect(report.errors.some(item => item.code === 'SHOT_FIELD_EMPTY' && item.field === 'lighting')).toBe(true)
    expect(validateStoryboard([unit()], settings).errors.filter(item => item.code === 'SHOT_FIELD_EMPTY')).toHaveLength(0)
  })

  it('抽象心理词只警告；无参考图、推断外貌、风格暂定只警告', () => {
    const report = validateStoryboard([unit({ shots: [shot({ subjectActionExpression: '他心中思绪翻涌，意识到不对' })] })], settings)
    expect(report.warnings.some(item => item.code === 'ABSTRACT_PSYCHOLOGY')).toBe(true)
    expect(report.warnings.some(item => item.code === 'NO_REFERENCE_IMAGE')).toBe(true)
    expect(report.warnings.some(item => item.code === 'STYLE_TENTATIVE')).toBe(true)
    expect(report.errors).toHaveLength(0)
  })

  it('慢镜头是运镜功能：时长不足 6 秒硬阻断，足够时仅提醒', () => {
    const slow = shot({ cameraMovement: '慢镜头推近' })
    expect(validateStoryboard([unit({ durationSec: 4, shots: [slow] })], settings)
      .errors.some(item => item.code === 'SLOW_MOTION_DURATION')).toBe(true)
    expect(validateStoryboard([unit({ durationSec: 8, shots: [slow] })], settings)
      .warnings.some(item => item.code === 'SLOW_MOTION_FUNCTION')).toBe(true)
  })

  it('台词时长按 ceil(字数/4*1.2) 给延长/拆段/回剧本建议，禁止「极快语速」', () => {
    const longLine = '把账册给我然后把门关上别让任何人进来现在就去做'.repeat(3)
    const report = validateStoryboard([
      unit({ durationSec: 4, shots: [shot({ dialogueAndTone: `林远：「${longLine}」语气低沉。` })] })
    ], settings)
    const issue = report.warnings.find(item => item.code === 'DIALOGUE_TOO_LONG')
    expect(issue).toBeTruthy()
    expect(issue?.message).toContain('延长单元、拆段或回剧本精简')
    const fast = validateStoryboard([unit({ shots: [shot({ dialogueAndTone: '林远：「快说。」极快语速' })] })], settings)
    expect(fast.errors.some(item => item.code === 'FAST_SPEECH')).toBe(true)
  })

  it('未定义素材编号是硬阻断', () => {
    const report = validateStoryboard([unit({ assetRefs: ['@图片1'], shots: [shot()] })], settings)
    expect(report.errors.some(item => item.code === 'UNDEFINED_ASSET')).toBe(true)
  })
})

describe('提示词包闸门', () => {
  const base = buildPromptPackage(unit(), settings, basedOn())
  const withBody = (body: string): PromptPackage => ({ ...base, body, charCount: countChars(body) })

  it('基线通过：无管理话术、无参数内嵌、无 BGM、无未定义素材', () => {
    expect(validatePackage(base).ok).toBe(true)
    expect(validatePackage(base).errors).toHaveLength(0)
  })

  it('管理话术 / 参数内嵌 / BGM / 素材编号 / 素材职责冲突 全部硬阻断', () => {
    const cases: Array<[string, string]> = [
      ['MANAGEMENT_SPEECH', '本段为未启用状态，不使用上一段，无则删除，接分镜2'],
      ['PARAM_IN_BODY', '请使用 9:16 画幅，1080p 分辨率，任务类型文生视频'],
      ['BGM_IN_BODY', '请生成背景音乐并叠加配乐'],
      ['UNDEFINED_ASSET', '按 @图片1 与 @视频2 生成画面'],
      ['ASSET_ROLE_CONFLICT', '本段不使用参考图，按以下文字描述生成画面。使用参考图保持一致']
    ]
    for (const [code, injected] of cases) {
      const report = validatePackage(withBody(`${base.body}\n${injected}`))
      expect(report.errors.some(item => item.code === code), `${code} 未触发`).toBe(true)
    }
  })

  it('台词改写、极快语速、无可见衔接、额外人物道具风险、字数超限均硬阻断', () => {
    const rewritten = { ...base, sourceShots: [shot({ dialogueAndTone: '林远：「把账册给我。」语气低沉。' })] }
    expect(validatePackage(rewritten).errors.some(item => item.code === 'DIALOGUE_REWRITTEN')).toBe(true)
    expect(validatePackage(withBody(`${base.body} 极快语速`)).errors.some(item => item.code === 'FAST_SPEECH')).toBe(true)
    const noTransition = { ...base, sourceShots: [shot({ nextTransition: '' })] }
    expect(validatePackage(noTransition).errors.some(item => item.code === 'SHOT_FIELD_EMPTY' || item.code === 'NO_VISIBLE_TRANSITION')).toBe(true)
    const noHardLock = withBody(base.body.replace('禁止额外人物、路人、群演进入画面；禁止复制同一道具；禁止字幕与水印；', ''))
    expect(validatePackage(noHardLock).errors.some(item => item.code === 'EXTRA_CAST_PROP_RISK')).toBe(true)
    expect(validatePackage(withBody('字'.repeat(PROMPT_HARD_LIMIT + 5))).errors.some(item => item.code === 'PROMPT_TOO_LONG')).toBe(true)
  })

  it('11 字段缺失、时长越界、压缩丢焦点光影会硬阻断', () => {
    const missing = { ...base, sourceShots: [{ ...shot(), aperture: '' }] }
    expect(validatePackage(missing).errors.some(item => item.code === 'SHOT_FIELD_EMPTY')).toBe(true)
    expect(validatePackage({ ...base, durationSec: 20 }).errors.some(item => item.code === 'UNIT_DURATION')).toBe(true)
    expect(validatePackage(withBody('正文里什么都没有')).errors.some(item => item.code === 'FOCUS_LIGHTING_LOST')).toBe(true)
  })
})

describe('Markdown 导出', () => {
  const base = buildPromptPackage(unit(), settings, basedOn())

  it('头部含项目、版本、指纹、生成时间、过期状态；每段先元信息+质量结果再放纯净正文', () => {
    const result = renderMarkdown([base], { projectName: '测试项目', generatedAt: '2026-02-03T04:05:06.000Z' })
    expect(result.ok).toBe(true)
    expect(result.markdown).toContain('# 视频提示词包 · 测试项目')
    expect(result.markdown).toContain('- 剧本版本：v1')
    expect(result.markdown).toContain(`- 内容指纹：\`${HEX}\``)
    expect(result.markdown).toContain('- 生成时间：2026-02-03T04:05:06.000Z')
    expect(result.markdown).toContain('- 过期状态：最新')
    expect(result.markdown).toContain('### 元信息')
    expect(result.markdown).toContain('### 质量结果')
    expect(result.markdown).toContain('### 纯净正文')
    expect(result.markdown).toContain('```text')
    expect(result.markdown).toContain('【素材锚定】')
    const metaIndex = result.markdown.indexOf('### 元信息')
    const bodyIndex = result.markdown.indexOf('```text')
    expect(metaIndex).toBeLessThan(bodyIndex)
  })

  it('已过期版本显著标「已过期（基于旧版本）」并写入版本/指纹，导出前二次闸门仍执行', () => {
    const stale: PromptPackage = { ...base, meta: { ...base.meta, stale: true, staleReason: '剧本内容已修改，分镜基于旧稿' } }
    const result = renderMarkdown([stale], { projectName: '测试项目' })
    expect(result.ok).toBe(true)
    expect(result.markdown).toContain('已过期（基于旧版本）')
    expect(result.markdown).toContain('剧本内容已修改，分镜基于旧稿')
    expect(result.markdown).toContain('v1')
    expect(result.markdown).toContain(HEX)
  })

  it('导出前二次闸门：正文含 @图片1 时整体阻断并返回 issues', () => {
    const broken: PromptPackage = { ...base, body: `${base.body}\n@图片1`, charCount: countChars(base.body) + 5 }
    const result = renderMarkdown([broken], {})
    expect(result.ok).toBe(false)
    expect(result.issues.some(item => item.code === 'UNDEFINED_ASSET')).toBe(true)
    expect(result.markdown).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 任务 #5：手工编辑分镜后的硬阻断纯校验器
// ---------------------------------------------------------------------------

describe('storyboardHardIssues 共享纯校验器', () => {
  it('合法单位（8 秒 / 11 字段非空）不产生硬阻断', () => {
    expect(storyboardHardIssues([unit()])).toEqual([])
  })

  it('16 秒单元命中 UNIT_DURATION 硬错误（severity=error）', () => {
    const issues = storyboardHardIssues([unit({ durationSec: 16 })])
    expect(issues.some(item => item.code === 'UNIT_DURATION')).toBe(true)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(item => item.severity === 'error')).toBe(true)
  })

  it('缺 11 字段的非法单位：全空时给出 11 条 SHOT_FIELD_EMPTY', () => {
    const emptyShot = Object.fromEntries(SHOT_FIELDS.map(field => [field, ''])) as Shot11
    const issues = storyboardHardIssues([unit({ shots: [emptyShot] })])
    const fieldIssues = issues.filter(item => item.code === 'SHOT_FIELD_EMPTY')
    expect(fieldIssues).toHaveLength(SHOT_FIELDS.length)
    expect(new Set(fieldIssues.map(item => item.field))).toEqual(new Set(SHOT_FIELDS))
    expect(fieldIssues.every(item => item.severity === 'error')).toBe(true)
  })

  it('SHOT_FIELDS 11 个字段逐个被覆盖（渲染层镜像顺序一致性守卫）', () => {
    for (const field of SHOT_FIELDS) {
      const broken = shot({ [field]: '   ' } as Partial<Shot11>)
      const issues = storyboardHardIssues([unit({ shots: [broken] })])
      expect(issues.some(item => item.code === 'SHOT_FIELD_EMPTY' && item.field === field)).toBe(true)
    }
  })

  it('时长边界与 0.5 倍数和共享常量一致：4/8.5/15 合法，3.5/15.5/8.3 非法', () => {
    for (const durationSec of [MIN_UNIT_SEC, 8.5, MAX_UNIT_SEC]) {
      expect(storyboardHardIssues([unit({ durationSec })])).toEqual([])
    }
    for (const durationSec of [MIN_UNIT_SEC - 0.5, MAX_UNIT_SEC + 0.5, 8.3]) {
      const issues = storyboardHardIssues([unit({ durationSec })])
      expect(issues.some(item => item.code === 'UNIT_DURATION')).toBe(true)
    }
  })

  it('空 units 与无镜头单元同样给出硬阻断', () => {
    expect(storyboardHardIssues([]).some(item => item.code === 'UNITS_EMPTY')).toBe(true)
    expect(storyboardHardIssues([unit({ shots: [] })]).some(item => item.code === 'SHOT_MISSING')).toBe(true)
  })

  it('gate 模块不含 zod / Node 依赖，渲染层可安全按值导入', () => {
    const source = readFileSync(join(process.cwd(), 'src/shared/script-studio-gate.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+['"]zod['"]/)
    expect(source).not.toMatch(/from\s+['"]node:/)
    expect(source).not.toMatch(/require\(['"](?:fs|path|crypto|os)['"]\)/)
    expect(source).toContain("import type")
    expect(source).toContain('export function storyboardHardIssues')
  })

  it('SCRIPT_STORYBOARD_BLOCKED 错误码存在且重导出可用', async () => {
    const contract = await import('../src/shared/script-studio')
    expect(contract.SCRIPT_STORYBOARD_BLOCKED).toBe('SCRIPT_STORYBOARD_BLOCKED')
    expect(contract.storyboardHardIssues).toBe(storyboardHardIssues)
  })
})

// ---------------------------------------------------------------------------
// 任务 #5：源码级一致性守卫（防止 QA 回归时修复被回退）
// ---------------------------------------------------------------------------

describe('任务 #5 源码级一致性守卫', () => {
  it('saveStoryboard IPC 先跑质量闸门，硬阻断返回早于 store.saveStoryboard 调用', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/ipc/script-studio.ts'), 'utf8')
    expect(source).toContain('const project = await store.get(input.projectId)')
    expect(source).toContain("const quality = validateStoryboard(input.units, project.settings, version?.body ?? '')")
    expect(source).toContain('code: SCRIPT_STORYBOARD_BLOCKED')
    expect(source).toContain("message: '分镜存在硬阻断，未保存'")
    const gateIndex = source.indexOf('if (quality.errors.length > 0)')
    const saveIndex = source.indexOf('return store.saveStoryboard(input)')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(saveIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(saveIndex)
  })

  it('页面 onFieldChange 用 storyboardHardIssues 重算，且 saveStoryboard 有同步护栏', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/ScriptStudioPage.tsx'), 'utf8')
    const onFieldChange = source.match(/const onFieldChange[\s\S]*?\}, \[units\]\)/)?.[0] ?? ''
    expect(onFieldChange).toContain('storyboardHardIssues(next)')
    expect(onFieldChange).not.toContain('setStoryboardQuality(null)')
    expect(source).toContain('const blocking = storyboardHardIssues(units)')
    expect(source).toContain('result.issues?.length')
    expect(source).toContain('result.issues.slice(0, 3)')
  })

  it('页面 stale 与 store.isStale 一样比对五项指纹', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/ScriptStudioPage.tsx'), 'utf8')
    expect(source).toContain('basedOn.versionId !== project.activeVersionId')
    expect(source).toContain('basedOn.scriptFingerprint !== project.scriptFingerprint')
    expect(source).toContain('basedOn.sourceFingerprint !== project.source.sourceFingerprint')
    expect(source).toContain('basedOn.contentFingerprint !== project.contentFingerprint')
    expect(source).toContain('basedOn.storyboardFingerprint !== project.storyboard.storyboardFingerprint')
  })
})


describe('森森 2.1 核心流程对齐回归', () => {
  it('兼容旧项目，并接收四档节奏和新的可选交接字段', () => {
    expect(scriptSettingsSchema.safeParse(settings).success).toBe(true)
    for (const paceTier of ['cinematic-mid', 'short-high', 'high-hook', 'slow-info'] as const) {
      expect(storyboardUnitSchema.safeParse(unit({ paceTier, paceExecution: '先凝视账册，再抬眼。',
        slowMotionPurpose: '揭示封口印记', boundaryPlan: '固定账册位置', enhancementAdvice: ['建议制作位置图'],
        shots: [shot({ functionLabel: '印记暴露背叛' })] })).success).toBe(true)
    }
  })

  it('受众、时长与自定义节奏档案同时进入编剧和分镜提示词', () => {
    const rhythm = { first3: '露出伪造印记', first15: '交代索账阻碍', first30: '揭示背叛',
      breathing: '停顿用于读清印记', avoidDragging: '不重复交账动作', completionGoal: '追看账册主人' }
    const configured = project({ settings: { ...settings, targetAudience: '悬疑观众', targetDurationSec: 45,
      paceMode: 'auto', rhythmProfile: rhythm } })
    for (const prompt of [buildScriptPrompt(configured), buildStoryboardPrompt(configured)]) {
      expect(prompt.user).toContain('45 秒')
      expect(prompt.user).toContain('悬疑观众')
      expect(prompt.user).toContain('paceMode=auto')
      for (const value of Object.values(rhythm)) expect(prompt.user).toContain(value)
    }
    expect(rhythmProfile(settings).first3).toContain('暂定')
    expect(buildStoryboardPrompt(project()).user).toContain('paceMode=manual')
  })

  it.each(['cinematic-mid', 'short-high', 'high-hook', 'slow-info'] as const)('%s 节奏执行从分镜传到成品正文与元信息', paceTier => {
    const storyboard = unit({ paceTier, paceReason: '本段由道具揭示信息' })
    const pkg = buildPromptPackage(storyboard, settings, basedOn())
    expect(pkg.body).toContain(paceExecution(storyboard))
    expect(pkg.meta).toMatchObject({ paceTier, paceReason: storyboard.paceReason, paceExecution: paceExecution(storyboard) })
    expect(pkg.body).not.toMatch(/90 秒|1080p|9:16|模式 C/)
  })

  it('保留手动节奏执行、连续性与增强建议，并在正文外导出', () => {
    const pkg = buildPromptPackage(unit({ paceExecution: '定机位读清封口，抬眼后切反应。',
      boundaryPlan: '延长上一段末帧以匹配手的位置', enhancementAdvice: ['建议补位置图 MAP', '建议补首帧 FF'] }), settings, basedOn())
    const rendered = renderMarkdown([pkg])
    expect(pkg.body).toContain('定机位读清封口')
    expect(pkg.body).not.toContain('MAP')
    expect(rendered.markdown).toContain('建议补位置图 MAP')
    expect(rendered.markdown).toContain('延长上一段末帧')
  })

  it('密度与功能性慢节奏、整集时长偏差产生可见警告', () => {
    expect(shotDensity('high-hook', 14)).toEqual([7, 10])
    expect(shotDensity('cinematic-mid', 8)).toEqual([2, 3])
    const warnings = validateStoryboard([unit({ durationSec: 12 })], settings).warnings.map(i => i.code)
    expect(warnings).toEqual(expect.arrayContaining(['SHOT_DENSITY_LOW', 'SLOW_FUNCTION_MISSING', 'TARGET_DURATION_MISMATCH']))
    expect(validateStoryboard([unit({ durationSec: 12, slowMotionPurpose: '停顿揭示印记' })], { ...settings, targetDurationSec: 12 })
      .warnings.map(i => i.code)).not.toEqual(expect.arrayContaining(['SLOW_FUNCTION_MISSING']))
    expect(validateStoryboard([unit()], { ...settings, targetDurationSec: 8 }).warnings.map(i => i.code)).not.toContain('TARGET_DURATION_MISMATCH')
  })

  it('C 使用动作功能标签，A 展开字段，B 添加执行锁，复杂段可推荐 B 或手动覆盖', () => {
    const storyboard = unit({ dramaticAction: '两人追逐争抢账册', shots: [shot({ functionLabel: '争抢暴露账册缺页' })] })
    const automatic = buildPromptPackage(storyboard, { ...settings, promptMode: 'auto' }, basedOn())
    expect(automatic.meta.mode).toBe('B')
    expect(automatic.body).toContain('摄影机执行锁')
    const clean = buildPromptPackage(storyboard, { ...settings, promptMode: 'C' }, basedOn())
    expect(clean.body).toContain('1｜争抢暴露账册缺页｜镜头/焦点：')
    expect(clean.body).not.toContain('摄影机执行锁')
    expect(clean.meta.recommendedMode).toBe('B')
    const detailed = buildPromptPackage(storyboard, { ...settings, promptMode: 'A' }, basedOn())
    expect(detailed.body).toContain('景深与焦点锁：')
    expect(detailed.body).toContain('下一段衔接：')
    for (const pkg of [automatic, clean, detailed]) expect(promptPackageSchema.safeParse(pkg).success).toBe(true)
    expect(buildPromptPackage(storyboard, settings, basedOn()).meta.mode).toBe('C')
  })

  it('写实视觉要求仍进入画面，专用风格才增加风格锁', () => {
    const realistic = buildPromptPackage(unit(), { ...settings, visualStyle: '写实冷色，低饱和度' }, basedOn())
    expect(realistic.body).toContain('视觉表达：写实冷色，低饱和度')
    expect(realistic.body).not.toContain('【风格锁定】')
    expect(buildPromptPackage(unit(), { ...settings, visualStyle: 'UE5 实时渲染' }, basedOn()).body).toContain('【风格锁定】')
  })

  it('识别 M1、行内与无句末标点对白，保留原有词句', () => {
    expect(scriptDialogue('SC1 日 内 书房\n林远\n（低声）\n不要开门\n守门人：我知道了。')).toEqual(['不要开门', '我知道了。'])
  })

  it('保留台词里的嵌套引号，并阻断把原话交给另一个角色', () => {
    expect(shotDialogue({ dialogueAndTone: '林远：「他说“账册在我手上”，你信吗？」；语气：低沉' }))
      .toEqual(['他说“账册在我手上”，你信吗？'])
    const original = 'SC1 日 内 书房\n林远\n把账册给我。'
    const swapped = unit({ shots: [shot({ dialogueAndTone: '守门人：「把账册给我。」；语气：低沉' })] })
    expect(dialogueIssues([swapped], original)[0]?.severity).toBe('error')
    expect(dialogueIssues([swapped], original, true)[0]?.severity).toBe('error')
    const unlabeled = unit({ shots: [shot({ dialogueAndTone: '「把账册给我。」；语气：低沉' })] })
    expect(dialogueIssues([unlabeled], original)[0]?.code).toBe('DIALOGUE_SPEAKER_UNVERIFIED')
  })

  it('标准 M1 无对白原稿不允许在分镜新增对白', () => {
    expect(dialogueIssues([unit({ shots: [shot({ dialogueAndTone: '林远：「新台词。」；语气：低沉' })] })],
      'SC1 日 内 书房\n林远推开门。')[0]?.severity).toBe('error')
  })

  it('正文删除无对白镜头的动作也会阻断，多行镜头字段压缩仍逐字保留', () => {
    const action = '林远推开门，门缝露出一角账册。\n他非常小心，非常小心。'
    const pkg = buildPromptPackage(unit({ shots: [shot({ subjectActionExpression: action })] }), settings, basedOn())
    expect(compressBody(pkg.body)).toContain(action)
    expect(validatePackage({ ...pkg, body: pkg.body.replace(action, '林远站定。') }).errors.map(i => i.code)).toContain('SHOT_CONTENT_LOST')
  })

  it.each([
    ['遗漏', ['原话甲。']], ['新增', ['原话甲。', '原话乙。', '新话。']],
    ['改写', ['原话变了。', '原话乙。']], ['重复', ['原话甲。', '原话甲。', '原话乙。']], ['乱序', ['原话乙。', '原话甲。']]
  ])('正式稿台词%s被阻断', (_reason, lines) => {
    const units = [unit({ shots: (lines as string[]).map(line => shot({ dialogueAndTone: `林远：「${line}」；语气：低沉` })) })]
    expect(dialogueIssues(units, 'SC1 日 内 书房\n林远\n原话甲。\n林远\n原话乙。')[0]?.severity).toBe('error')
  })

  it('单段核对不能从无对白变成借用别段台词，不规则原稿显式提示人工核对', () => {
    expect(unitDialogueIssues([unit({ shots: [shot({ dialogueAndTone: '林远：「别段原话。」' })] })], unit())[0]?.severity).toBe('error')
    expect(dialogueIssues([unit({ shots: [shot({ dialogueAndTone: '林远：「原话。」' })] })], '一段散文。')[0]?.code).toBe('DIALOGUE_UNVERIFIED')
    expect(dialogueIssues([unit({ shots: [shot({ dialogueAndTone: '林远：「原话乙。」' })] })], '林远\n原话甲。\n林远\n原话乙。', true)).toEqual([])
  })

  it('压缩不改重复原话、ASCII 引号原话、A 字段或段末状态', () => {
    const text = '林远：「非常小心，非常小心。」\n林远："非常小心，非常小心。"\n主体动作/表情：非常小心地推门\n【段末状态】\n非常小心，非常小心。'
    expect(compressBody(text)).toBe(text)
  })

  it('超长多镜按镜头边界拆分，全部镜头、台词、顺序与首尾状态保持', () => {
    const shots = Array.from({ length: 12 }, (_, i) => shot({ functionLabel: `揭示印记${i}`,
      subjectActionExpression: `第${i}次拿起账册，` + '左手托底右手翻页，露出印记再抬眼。'.repeat(8),
      nextTransition: `右手停在第${i}页，账册居中` }))
    const storyboard = unit({ shots, durationSec: 15 })
    const packages = buildPromptPackages(storyboard, settings, basedOn())
    expect(packages.length).toBeGreaterThan(1)
    expect(packages.flatMap(p => p.sourceShots)).toEqual(shots)
    expect(packages[0].body).toContain(storyboard.firstFrame)
    expect(packages.at(-1)!.body).toContain(storyboard.lastFrame)
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i]
      expect(pkg.charCount).toBeLessThanOrEqual(PROMPT_HARD_LIMIT)
      expect(pkg.quality.ok).toBe(true)
      expect(pkg.durationSec).toBeGreaterThanOrEqual(4)
      expect(pkg.durationSec).toBeLessThanOrEqual(15)
      expect(pkg.meta.splitFromUnitId).toBe(storyboard.id)
      expect(pkg.meta.splitNotice).toContain('总时长')
      if (i) expect(pkg.body).toContain(packages[i - 1].sourceShots.at(-1)!.nextTransition)
    }
  })

  it('自然语速超时可延长或按对白镜头拆分，单镜无法容纳则保留硬阻断', () => {
    const single = unit({ durationSec: 4, shots: [shot({ dialogueAndTone: '林远：「我已经把完整的账册交到你的手里了。」；语气：低沉' })] })
    const extended = buildPromptPackages(single, settings, basedOn())[0]
    expect(extended.durationSec).toBeGreaterThan(4)
    expect(extended.quality.ok).toBe(true)
    expect(extended.meta.splitNotice).toContain('原单元 4 秒')
    const lines = ['甲'.repeat(30), '乙'.repeat(30)]
    const split = buildPromptPackages(unit({ durationSec: 15, shots: lines.map(line => shot({ dialogueAndTone: `林远：「${line}」` })) }), settings, basedOn())
    expect(split).toHaveLength(2)
    expect(split.flatMap(p => p.sourceShots).map(s => s.dialogueAndTone)).toEqual(lines.map(line => `林远：「${line}」`))
    expect(split.every(p => p.quality.ok)).toBe(true)
    const blocked = buildPromptPackages(unit({ shots: [shot({ dialogueAndTone: `林远：「${'长'.repeat(70)}」` })] }), settings, basedOn())
    expect(blocked[0].quality.errors.some(i => i.code === 'UNIT_DURATION')).toBe(true)
  })

  it('单镜描述超长无法拆分时仍阻断，绝不截断', () => {
    const original = shot({ subjectActionExpression: '画'.repeat(2300) })
    const packages = buildPromptPackages(unit({ shots: [original] }), settings, basedOn())
    expect(packages).toHaveLength(1)
    expect(packages[0].sourceShots[0]).toEqual(original)
    expect(packages[0].quality.errors.map(i => i.code)).toContain('PROMPT_TOO_LONG')
  })

  it('正文对白核对检测重复丢失、顺序变化和说话人替换', () => {
    const first = shot({ dialogueAndTone: '林远：「甲。」；语气：低沉' })
    const second = shot({ dialogueAndTone: '守门人：「乙。」；语气：低沉' })
    const pkg = buildPromptPackage(unit({ shots: [first, second] }), settings, basedOn())
    expect(pkg.quality.ok).toBe(true)
    for (const body of [pkg.body.replace(first.dialogueAndTone, '守门人：「甲。」；语气：低沉'),
      pkg.body.replace(first.dialogueAndTone, '__FIRST__').replace(second.dialogueAndTone, first.dialogueAndTone).replace('__FIRST__', second.dialogueAndTone)]) {
      expect(validatePackage({ ...pkg, body }).errors.map(i => i.code)).toContain('DIALOGUE_REWRITTEN')
    }
    const duplicate = buildPromptPackage(unit({ shots: [first, first] }), settings, basedOn())
    expect(validatePackage({ ...duplicate, body: duplicate.body.replace(first.dialogueAndTone, '无对白') }).ok).toBe(false)
  })
})
