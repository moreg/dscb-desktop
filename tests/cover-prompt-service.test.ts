import { describe, it, expect, vi } from 'vitest'
import {
  CoverPromptService,
  COVER_DRAFT_SCHEMA,
  parseDraftJson,
  pickProtagonists
} from '../src/main/data/cover-prompt-service'
import { buildCoverPrompt, GENRE_STYLES, COVER_STYLE_PRESETS } from '../src/main/data/skill-prompts/cover/cover-styles'
import type { Character } from '../src/shared/types'

/* =========================================================
   parseDraftJson —— 模型输出容错
   ========================================================= */

describe('parseDraftJson 模型输出解析', () => {
  it('裸 JSON 直接解析', () => {
    expect(parseDraftJson('{"genre":"xianxia"}')).toEqual({ genre: 'xianxia' })
  })

  it('剥掉 ```json 围栏', () => {
    const raw = '```json\n{"genre":"scifi","composition":"scene"}\n```'
    expect(parseDraftJson(raw)).toEqual({ genre: 'scifi', composition: 'scene' })
  })

  it('忽略 JSON 前后的解释文字', () => {
    const raw = '好的，分析如下：\n{"genre":"mystery"}\n以上就是提炼结果。'
    expect(parseDraftJson(raw)).toEqual({ genre: 'mystery' })
  })

  it('嵌套对象保留完整（取最后一个 }）', () => {
    const parsed = parseDraftJson('{"a":{"b":1},"genre":"urban"}')
    expect(parsed?.genre).toBe('urban')
  })

  it('非法 JSON 返回 null', () => {
    expect(parseDraftJson('{genre: xianxia}')).toBeNull()
    expect(parseDraftJson('完全没有 JSON')).toBeNull()
    expect(parseDraftJson('')).toBeNull()
  })

  it('模型误包了一层数组时，抠出里面的对象', () => {
    expect(parseDraftJson('[{"genre":"urban"}]')).toEqual({ genre: 'urban' })
  })
})

/* =========================================================
   pickProtagonists —— 主角优先
   ========================================================= */

function ch(name: string, role?: string, tags?: string[]): Character {
  return {
    id: name,
    name,
    role,
    tags,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('pickProtagonists 主角优先', () => {
  it('role 命中主角关键词的排前面', () => {
    const list = [ch('路人甲', '配角'), ch('林九', '男主角'), ch('反派', '反派')]
    expect(pickProtagonists(list, 3).map((c) => c.name)).toEqual(['林九', '路人甲', '反派'])
  })

  it('tags 命中也算主角', () => {
    const list = [ch('配角A'), ch('苏晚', undefined, ['女主', '医生'])]
    expect(pickProtagonists(list, 2)[0].name).toBe('苏晚')
  })

  it('截断到 limit，主角不会被挤掉', () => {
    const list = [ch('甲'), ch('乙'), ch('丙'), ch('主角', '主角')]
    const picked = pickProtagonists(list, 2)
    expect(picked).toHaveLength(2)
    expect(picked[0].name).toBe('主角')
  })

  it('空列表返回空', () => {
    expect(pickProtagonists([], 4)).toEqual([])
  })
})

/* =========================================================
   scene 覆盖题材模板
   ========================================================= */

describe('buildCoverPrompt scene 覆盖', () => {
  const base = {
    bookName: '断刀行',
    authorName: '老猫',
    platform: 'fanqie' as const,
    genre: 'xianxia' as const,
    composition: 'closeup' as const
  }

  it('给了 characterDesc 就不再用题材模板的白衣剑客', () => {
    const prompt = buildCoverPrompt({
      ...base,
      scene: { characterDesc: 'a one-armed middle-aged blade master in torn grey linen' }
    })
    expect(prompt).toContain('one-armed middle-aged blade master')
    expect(prompt).not.toContain(GENRE_STYLES.xianxia.characterDesc)
  })

  it('未覆盖的字段回退题材默认值', () => {
    const prompt = buildCoverPrompt({
      ...base,
      scene: { characterDesc: 'custom hero' }
    })
    expect(prompt).toContain(GENRE_STYLES.xianxia.backgroundDesc)
    expect(prompt).toContain(GENRE_STYLES.xianxia.colorPalette)
    expect(prompt).toContain(GENRE_STYLES.xianxia.lighting)
  })

  it('空串 / 纯空白的覆盖值视为未提供', () => {
    const prompt = buildCoverPrompt({
      ...base,
      scene: { characterDesc: '   ', backgroundDesc: '' }
    })
    expect(prompt).toContain(GENRE_STYLES.xianxia.characterDesc)
    expect(prompt).toContain(GENRE_STYLES.xianxia.backgroundDesc)
  })

  it('keyProps 有值才输出', () => {
    const withProps = buildCoverPrompt({ ...base, scene: { keyProps: 'a shattered bronze sword' } })
    expect(withProps).toContain('关键象征物：a shattered bronze sword。')
    const without = buildCoverPrompt({ ...base, scene: { characterDesc: 'x' } })
    expect(without).not.toContain('关键象征物')
  })

  it('scene 构图不描述主体人物（避免与 no human figure 矛盾）', () => {
    const prompt = buildCoverPrompt({
      ...base,
      composition: 'scene',
      scene: { characterDesc: 'a lone swordsman' }
    })
    expect(prompt).toContain('无主体人物')
    expect(prompt).not.toContain('a lone swordsman')
    expect(prompt).not.toContain(GENRE_STYLES.xianxia.characterDesc)
  })

  it('不给 scene 时与旧行为一致（题材模板全量出现）', () => {
    const prompt = buildCoverPrompt(base)
    expect(prompt).toContain(GENRE_STYLES.xianxia.characterDesc)
    expect(prompt).toContain(GENRE_STYLES.xianxia.backgroundDesc)
  })

  it('覆盖值自带句点不会出现双句点', () => {
    const prompt = buildCoverPrompt({
      ...base,
      scene: { colorPalette: 'rust red and ash grey.' }
    })
    expect(prompt).toContain('配色：rust red and ash grey。')
    expect(prompt).not.toContain('..')
  })
})

/* =========================================================
   CoverPromptService.extract —— 编排
   ========================================================= */

/** 构造一个只有大纲、其余都失败的最小依赖组 */
function makeService(opts: {
  llmResponse?: string
  llmError?: Error
  synopsis?: string | null
  characters?: Character[]
  learningLibrary?: ConstructorParameters<typeof CoverPromptService>[4]
}): {
  service: CoverPromptService
  generateStream: ReturnType<typeof vi.fn>
} {
  const generateStream = vi.fn(async () => {
    if (opts.llmError) throw opts.llmError
    return opts.llmResponse ?? '{}'
  })

  const projectService = {
    getProjectData: async () => ({ name: '断刀行', description: '一个断臂刀客的复仇', genre: '仙侠' }),
    resolveDir: async () => '/nonexistent-project-dir'
  }
  const outlineService = {
    getMain: async () =>
      opts.synopsis === null ? null : { synopsis: opts.synopsis ?? '主角在雪山之巅断刀重铸' },
    listDetailed: async () => []
  }
  const chapterService = {
    listChapters: async () => [],
    getChapter: async () => ({ content: '' })
  }

  const service = new CoverPromptService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    projectService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { generateStream } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outlineService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chapterService as any,
    opts.learningLibrary
  )
  return { service, generateStream }
}

function completeResponse(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ genre: 'urban', composition: 'closeup',
    characterDesc: 'a sixty-year-old one-armed fictional warrior in weathered armor',
    backgroundDesc: 'a ruined stone fortress', ...fields })
}

describe('CoverPromptService.extract', () => {
  const input = {
    projectId: 'p1',
    bookName: '断刀行',
    authorName: '老猫',
    platform: 'fanqie' as const
  }

  it('提炼字段和schema统一要求自然中文，中文人物道具逐字进入草稿且保留稳定枚举', async () => {
    const scene = {
      characterDesc: '六十岁的独臂女刀客，灰发束起，身穿旧铜甲，握着一把断刀',
      backgroundDesc: '雪山脚下的残破石堡，城墙上积着薄雪',
      colorPalette: '铁灰为主，暗红与旧铜色点缀',
      lighting: '左侧冷月光照亮人物面部，远处有微弱火光',
      keyProps: '刀身缺了一角的旧铜刀'
    }
    const { service, generateStream } = makeService({ llmResponse: JSON.stringify({ genre: 'xianxia', composition: 'fullbody', ...scene,
      styleHintZh: '冷色调，独臂刀客，残破石堡', summaryZh: '独臂女刀客守在雪山石堡前' }) })
    const draft = await service.extract({ ...input, stylePreset: 'ink_minimal' })
    const [instruction, options] = generateStream.mock.calls[0]
    expect(instruction).toContain('五个字段全部用**自然简体中文**书写')
    expect(instruction).toContain('不附英文翻译')
    expect(instruction).not.toContain('用**英文**书写')
    expect(draft.scene).toEqual(scene)
    expect(draft).toMatchObject({ genre: 'xianxia', composition: 'fullbody', styleHint: '冷色调，独臂刀客，残破石堡', summary: '独臂女刀客守在雪山石堡前' })
    for (const value of Object.values(scene)) expect(draft.prompt).toContain(value)
    expect(options.jsonSchema).toBe(COVER_DRAFT_SCHEMA)
    for (const field of ['characterDesc', 'backgroundDesc', 'colorPalette', 'lighting', 'keyProps', 'styleHintZh', 'summaryZh'] as const) {
      expect(COVER_DRAFT_SCHEMA.properties[field].description).toContain('自然简体中文')
      expect(COVER_DRAFT_SCHEMA.properties[field].description).not.toContain('English')
    }
    expect(COVER_DRAFT_SCHEMA.properties.composition.enum).toEqual(['closeup', 'fullbody', 'scene', 'duo'])
  })

  it('明确男频高于模型性别、旧scene与无人物方向，保留小说人物其他属性和写实媒介', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ composition: 'scene',
      characterDesc: 'a sixty-year-old one-armed female detective in a weathered grey coat',
      backgroundDesc: 'an old railway station', styleHintZh: '女主，冷色调', summaryZh: '女性侦探站在车站' }) })
    const draft = await service.extract({ ...input, channel: 'male', stylePreset: 'photorealistic',
      compositionOverride: 'scene', extraHint: '女性主角，不要人物，只改光线' })
    const instruction = generateStream.mock.calls[0][0] as string
    expect(instruction).toContain('用户明确选择男频，封面主体必须是男性（male）')
    expect(instruction).toContain('构图已锁定为 "closeup"')
    expect(instruction).not.toContain('当前风格要求无人物')
    expect(draft.composition).toBe('closeup')
    expect(draft.scene?.characterDesc).toBe('a sixty-year-old one-armed male detective in a weathered grey coat')
    expect(draft.scene?.backgroundDesc).toBe('an old railway station')
    expect(draft.prompt).toContain('写实媒介约束')
    expect(draft.styleHint).toBe('男主角，冷色调')
    expect(draft.summary).toBe('男性侦探站在车站')
  })

  it('女频duo确定性校正模型两位人物，不因无人物风格退掉双人或修改两种服饰', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ genre: 'modern_romance', composition: 'scene',
      characterDesc: 'an elderly woman in a red dress and a middle-aged man in a grey suit' }) })
    const draft = await service.extract({ ...input, channel: 'female', stylePreset: 'concept_symbol', compositionOverride: 'duo', extraHint: '不要人物' })
    expect(generateStream.mock.calls[0][0]).toContain('构图已锁定为 "duo"')
    expect(draft.composition).toBe('duo')
    expect(draft.scene?.characterDesc).toContain('两个主体均为女性')
    expect(draft.scene?.characterDesc).toContain('an elderly woman in a red dress and a middle-aged woman in a grey suit')
    expect(draft.prompt).toContain('双人构图')
    expect(draft.prompt).not.toContain('无主体人物')
  })

  it('明确频道解除预设无人物要求，但模型仍未返回人物时明确报错而非凭空换通用角色', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ composition: 'scene', characterDesc: '' }) })
    await expect(service.extract({ ...input, channel: 'female', stylePreset: 'concept_symbol' })).rejects.toThrow('人物外貌与服饰')
    expect(generateStream.mock.calls[0][0]).toContain('构图已锁定为 "closeup"')
    expect(generateStream.mock.calls[0][0]).not.toContain('当前风格要求无人物')
  })

  it('频道只锁人物性别和存在，方向不再声明第二个最高优先级，提炼结果仍确定性校正', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({
      characterDesc: 'an elderly female general in weathered copper armor', backgroundDesc: 'a ruined mountain fortress'
    }) })
    const draft = await service.extract({ ...input, channel: 'male', stylePreset: 'photorealistic', extraHint: '主角画成女性，只改光线' })
    const instruction = generateStream.mock.calls[0][0] as string
    expect(instruction).toContain('人物性别和可见存在优先于下方资料、方向及预设')
    expect(instruction).toContain('人物性别和存在仍服从上方频道选择')
    expect(instruction).toContain('【作者画面方向，仅覆盖指定维度】')
    expect(instruction).not.toContain('作者画面方向，优先级最高')
    expect(draft.scene?.characterDesc).toBe('an elderly male general in weathered copper armor')
    expect(draft.prompt).toContain('写实媒介约束')
    expect(draft.scene?.backgroundDesc).toBe('a ruined mountain fortress')
  })

  it('水墨预设的小说提炼不再混入轻小说萌系画风，中文冲突规则不覆盖自选竖排', async () => {
    const rules = ['标题占画面80%，放在上方三分之一。', '标题保持清晰的高对比。']
    const learningLibrary = {
      load: async () => ({ library: { updatedAt: 'old-source', source: { sampleCount: 8 }, styles: {} }, summary: { rules: [] } }),
      resolveStyle: () => ({ key: 'ink_minimal', definition: COVER_STYLE_PRESETS.ink_minimal }),
      getRulesForGenre: () => rules
    }
    const { service } = makeService({ learningLibrary: learningLibrary as unknown as ConstructorParameters<typeof CoverPromptService>[4],
      llmResponse: completeResponse({ genre: 'light_novel', characterDesc: 'an elderly warrior in weathered bronze armor' }) })
    const draft = await service.extract({ ...input, stylePreset: 'ink_minimal', typography: { titlePosition: 'vertical_left', authorPosition: 'vertical_side' } })
    expect(draft.prompt).toContain(COVER_STYLE_PRESETS.ink_minimal.prompt)
    expect(draft.prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(draft.prompt).toContain('an elderly warrior in weathered bronze armor')
    expect(draft.prompt).toContain('单列竖排')
    expect(draft.prompt).not.toContain('独立底部署名区')
    expect(draft.learningContext?.rules).toEqual([rules[1]])
    expect(draft.learningContext?.libraryVersion).toMatch(/^old-source@/)
    expect(rules).toEqual(['标题占画面80%，放在上方三分之一。', '标题保持清晰的高对比。'])
  })

  it('仅改变光线时提炼与出图仍保留媒介锁、角色属性和用户构图锁定', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ composition: 'closeup' }) })
    const draft = await service.extract({ ...input, stylePreset: 'photorealistic', compositionOverride: 'fullbody', extraHint: '不要二次元，只改光线' })
    const instruction = generateStream.mock.calls[0][0] as string
    expect(instruction).toContain('视觉风格已锁定为“真人写实封面”')
    expect(instruction).toContain('写实媒介约束')
    expect(instruction).toContain('构图已锁定为 "fullbody"')
    expect(instruction).toContain('人物未被明确更换')
    expect(draft.composition).toBe('fullbody')
    expect(draft.prompt).toContain('写实媒介约束')
    expect(draft.prompt).toContain('a sixty-year-old one-armed fictional warrior')
  })

  it('色调方向不会让无人物风格突然改为人物封面', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ composition: 'fullbody' }) })
    const draft = await service.extract({ ...input, stylePreset: 'concept_symbol', extraHint: '改为冷色调' })
    expect(draft.composition).toBe('scene')
    expect(draft.prompt).toContain('无主体人物')
    expect(generateStream.mock.calls[0][0]).toContain('当前风格要求无人物')
  })

  it('有效JSON缺关键字段也明确失败，不生成通用人物冒充专属提炼', async () => {
    const { service } = makeService({ llmResponse: '{}' })
    await expect(service.extract(input)).rejects.toThrow('COVER_PROMPT_INCOMPLETE')
    const missingCharacter = makeService({ llmResponse: '{"composition":"fullbody","backgroundDesc":"a mountain pass"}' }).service
    await expect(missingCharacter.extract(input)).rejects.toThrow('人物外貌与服饰')
  })

  it('返回可保留的结构化画面和按实际题材筛选的学习快照，两条构建路径使用相同比例过滤', async () => {
    const getRulesForGenre = vi.fn(() => [
      'Use a portrait 9:16 master canvas.', 'SCI_FI_GENRE_RULE: keep the planet silhouette clear.'
    ])
    const learningLibrary = {
      load: async () => ({
        library: { updatedAt: 'learned-version', source: { sampleCount: 20 }, styles: {} },
        summary: { rules: [] }
      }),
      resolveStyle: () => ({ key: 'game_neon', definition: COVER_STYLE_PRESETS.game_neon }),
      getRulesForGenre
    }
    const { service } = makeService({
      learningLibrary: learningLibrary as unknown as ConstructorParameters<typeof CoverPromptService>[4],
      llmResponse: JSON.stringify({ genre: 'scifi', composition: 'scene',
        characterDesc: '', backgroundDesc: 'a ruined orbital station', colorPalette: 'cobalt and copper',
        lighting: 'a dying red sun', keyProps: 'a broken reactor', styleHintZh: '太空废墟', summaryZh: '空间站废墟' })
    })
    const draft = await service.extract(input)
    expect(getRulesForGenre).toHaveBeenCalledWith(expect.anything(), 'scifi')
    expect(draft.scene).toMatchObject({ backgroundDesc: 'a ruined orbital station', keyProps: 'a broken reactor' })
    expect(draft.styleHint).toBe('太空废墟')
    expect(draft.learningContext?.rules).toEqual(['SCI_FI_GENRE_RULE: keep the planet silhouette clear.'])
    expect(draft.learningContext?.libraryVersion).toMatch(/^learned-version@/)
    expect(draft.prompt).toContain('SCI_FI_GENRE_RULE')
    expect(draft.prompt).toContain('3:4')
    expect(draft.prompt).not.toContain('9:16')
  })

  it('提炼方向指定人物时，无人物风格不会再让最终提示词丢失人物', async () => {
    const { service } = makeService({ llmResponse: JSON.stringify({
      genre: 'historical', composition: 'fullbody', characterDesc: 'an elderly female general in bronze armor',
      backgroundDesc: 'a mountain fortress', colorPalette: 'bronze and slate', lighting: 'clouded daylight',
      keyProps: 'a battle standard', styleHintZh: '女将军', summaryZh: '山城中的女将军'
    }) })
    const draft = await service.extract({ ...input, stylePreset: 'concept_symbol', extraHint: '画一位老年女将军' })
    expect(draft.composition).toBe('fullbody')
    expect(draft.prompt).toContain('an elderly female general in bronze armor')
    expect(draft.prompt).not.toContain('无主体人物')
  })

  it('正常提炼：字段回填 + 来源记录', async () => {
    const { service, generateStream } = makeService({
      llmResponse: JSON.stringify({
        genre: 'xianxia',
        composition: 'fullbody',
        characterDesc: 'a one-armed blade master',
        backgroundDesc: 'snow-covered peak',
        colorPalette: 'ash grey and blood red',
        lighting: 'cold overcast light',
        keyProps: 'a shattered blade',
        styleHintZh: '偏冷色调，雪山，断刀',
        summaryZh: '断臂刀客立于雪峰'
      })
    })
    const draft = await service.extract(input)

    expect(draft.genre).toBe('xianxia')
    expect(draft.composition).toBe('fullbody')
    expect(draft.summary).toBe('断臂刀客立于雪峰')
    expect(draft.sources).toContain('大纲')

    // 返回的是拼好的整段提示词：提炼要素 + 文字层 + 通用约束全在里面
    expect(draft.prompt).toContain('a one-armed blade master')
    expect(draft.prompt).toContain('关键象征物：a shattered blade。')
    expect(draft.prompt).toContain('配色：ash grey and blood red。')
    expect(draft.prompt).toContain('偏冷色调，雪山，断刀')
    expect(draft.prompt).toContain("书名文字：'断刀行'")
    expect(draft.prompt).toContain("'老猫'")
    expect(draft.prompt).toContain('不加水印')

    // 走 auxiliary 路由，且带上 projectId 便于用量归属
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(generateStream.mock.calls[0][1].meta).toEqual({
      feature: 'coverPrompt',
      projectId: 'p1'
    })
  })

  it('素材原文进入提示词（不是只发书名）', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ genre: 'urban' }) })
    await service.extract(input)
    const prompt = generateStream.mock.calls[0][0] as string
    expect(prompt).toContain('断刀行')
    expect(prompt).toContain('一个断臂刀客的复仇')
    expect(prompt).toContain('主角在雪山之巅断刀重铸')
  })

  it('genreOverride 锁定题材，模型返回值不生效', async () => {
    const { service } = makeService({ llmResponse: completeResponse({ genre: 'light_novel' }) })
    const draft = await service.extract({ ...input, genreOverride: 'mystery' })
    expect(draft.genre).toBe('mystery')
  })

  it('compositionOverride 锁定构图，模型返回值不生效', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ composition: 'duo' }) })
    const draft = await service.extract({ ...input, compositionOverride: 'scene' })
    expect(draft.composition).toBe('scene')
    // scene 构图不描述主体人物
    expect(draft.prompt).toContain('无主体人物')
    expect(generateStream.mock.calls[0][0]).toContain('构图已锁定为 "scene"')
  })

  it('模型给出非法 genre / composition 时兜底', async () => {
    const { service } = makeService({
      llmResponse: completeResponse({ genre: '不存在的题材', composition: 'bogus' })
    })
    const draft = await service.extract(input)
    // 书名「断刀行」不含题材关键词——回落 urban
    expect(draft.genre).toBe('urban')
    expect(draft.composition).toBe('closeup')
  })

  it('模型不返回 JSON 时抛 COVER_PROMPT_PARSE_FAILED', async () => {
    const { service } = makeService({ llmResponse: '我觉得这本书适合暗黑风格。' })
    await expect(service.extract(input)).rejects.toThrow('COVER_PROMPT_PARSE_FAILED')
  })

  it('额外要求写进提示词', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ genre: 'urban' }) })
    await service.extract({ ...input, extraHint: '主角改成女性' })
    const extractionPrompt = generateStream.mock.calls[0][0] as string
    expect(extractionPrompt).toContain('【作者画面方向，仅覆盖指定维度】')
    expect(extractionPrompt).toContain('主角改成女性')
    expect(extractionPrompt).toContain('压过小说资料里的主角')
    expect(extractionPrompt).toContain('不要改回小说主角')
    expect(extractionPrompt.indexOf('【作者画面方向，仅覆盖指定维度】')).toBeLessThan(extractionPrompt.indexOf('断刀行'))
  })

  it('有画面方向时，不再要求人物性别和画风服从小说资料', async () => {
    const { service, generateStream } = makeService({
      llmResponse: completeResponse({ genre: 'urban', characterDesc: 'a Korean woman' })
    })
    const draft = await service.extract({
      ...input,
      stylePreset: 'photorealistic',
      extraHint: '主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格'
    })
    const extractionPrompt = generateStream.mock.calls[0][0] as string
    expect(extractionPrompt).toContain('主角画韩国财阀女性，嚣张跋扈的坐姿，二次元风格')
    expect(extractionPrompt).toContain('优先级低于作者画面方向')
    expect(extractionPrompt).not.toContain('人物年龄、身份、体型和服饰遵循小说资料')
    expect(extractionPrompt).not.toContain('视觉风格已锁定为')
    expect(extractionPrompt).not.toContain('写实媒介约束')
    expect(extractionPrompt).not.toContain('禁止插画、数字绘画、动漫')
    expect(draft.prompt).not.toContain('画风约束')
    expect(draft.prompt).not.toContain('写实媒介约束')
    expect(draft.prompt).not.toContain('a confident young man in a sharp tailored suit')
    expect(draft.prompt).toContain('a Korean woman')
  })

  it('选择的封面风格同时约束提炼模型和最终生图提示词', async () => {
    const { service, generateStream } = makeService({
      llmResponse: JSON.stringify({
        genre: 'mystery',
        composition: 'scene',
        backgroundDesc: 'an empty interrogation room',
        colorPalette: 'charcoal and blood red',
        lighting: 'a single overhead light',
        summaryZh: '空审讯室中的断刀'
      })
    })
    const draft = await service.extract({ ...input, stylePreset: 'dark_suspense' })
    const extractionPrompt = generateStream.mock.calls[0][0] as string
    expect(extractionPrompt).toContain('视觉风格已锁定为“暗黑悬疑电影”')
    expect(draft.prompt).toContain('画风约束（暗黑悬疑电影）')
  })

  it('提炼内容后仍保留用户选择的文字排版', async () => {
    const { service } = makeService({
      llmResponse: completeResponse({ genre: 'xianxia', composition: 'fullbody', characterDesc: 'a blade master' })
    })
    const draft = await service.extract({
      ...input,
      typography: {
        titleFont: 'impact',
        titlePosition: 'lower_third',
        titleEffect: 'metallic',
        authorFont: 'serif',
        authorPosition: 'bottom_right'
      }
    })
    expect(draft.prompt).toContain('超大堆叠中文超粗标题')
    expect(draft.prompt).toContain('横排于下三分之一区域')
    expect(draft.prompt).toContain('金或银金属材质')
    expect(draft.prompt).toContain('小号精致中文宋体')
    expect(draft.prompt).toContain('位于右下方安全区')
  })

  it.each([
    ['photorealistic', '真人写实封面', '写实媒介约束'],
    ['anime_illustration', '二次元动漫封面', '二次元媒介约束']
  ] as const)('%s 的提炼与最终提示词锁定媒介，保留故事中的年龄和服饰', async (stylePreset, label, medium) => {
    const { service, generateStream } = makeService({
      synopsis: '主角是一位六十岁的女将军，穿旧铜甲，守卫山中残破的堡垒。',
      llmResponse: JSON.stringify({
        genre: 'light_novel', composition: 'fullbody',
        characterDesc: 'a sixty-year-old female general in weathered bronze armor',
        backgroundDesc: 'a ruined mountain fortress',
        styleHintZh: '女将军，旧铜甲，残破堡垒'
      })
    })
    const draft = await service.extract({ ...input, platform: 'ciweimao', stylePreset })
    const extractionPrompt = generateStream.mock.calls[0][0] as string
    expect(extractionPrompt).toContain(`视觉风格已锁定为“${label}”`)
    expect(extractionPrompt).toContain(medium)
    expect(extractionPrompt).toContain('所有画面字段与 styleHintZh 都必须遵守该媒介')
    expect(extractionPrompt).toContain('人物年龄、身份、体型和服饰遵循小说资料')
    expect(extractionPrompt).toContain('六十岁的女将军')
    expect(draft.prompt).toContain(medium)
    expect(draft.prompt).toContain('a sixty-year-old female general in weathered bronze armor')
    expect(draft.prompt).toContain('a ruined mountain fortress')
    expect(draft.prompt).not.toContain(GENRE_STYLES.light_novel.tag)
    expect(draft.prompt).not.toContain(GENRE_STYLES.light_novel.characterDesc)
  })

  it('无人物概念风格即使模型返回人物构图也强制改为 scene', async () => {
    const { service } = makeService({
      llmResponse: completeResponse({ genre: 'mystery', composition: 'closeup', characterDesc: 'a detective' })
    })
    const draft = await service.extract({ ...input, stylePreset: 'concept_symbol' })
    expect(draft.composition).toBe('scene')
    expect(draft.prompt).not.toContain('a detective')
  })

  it('下发 JSON Schema 供支持结构化输出的 provider 强约束', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ genre: 'urban' }) })
    await service.extract(input)
    expect(generateStream.mock.calls[0][1].jsonSchema).toBe(COVER_DRAFT_SCHEMA)
  })

  it('提示词仍自带 JSON 格式要求（不支持 schema 的 provider 靠它）', async () => {
    const { service, generateStream } = makeService({ llmResponse: completeResponse({ genre: 'urban' }) })
    await service.extract(input)
    const prompt = generateStream.mock.calls[0][0] as string
    expect(prompt).toContain('只输出一个 JSON 对象')
    // schema 的每个字段都要在提示词里出现，两条路径才不会各说各话
    for (const key of COVER_DRAFT_SCHEMA.required) {
      expect(prompt).toContain(key)
    }
  })

  it('关键画面字段为空时明确失败，不再静默替换成通用题材人物', async () => {
    const { service } = makeService({
      llmResponse: '{"genre":"urban","characterDesc":"","keyProps":"   "}'
    })
    await expect(service.extract(input)).rejects.toThrow('COVER_PROMPT_INCOMPLETE')
  })
})
