import { describe, it, expect, vi } from 'vitest'
import {
  CoverPromptService,
  COVER_DRAFT_SCHEMA,
  parseDraftJson,
  pickProtagonists
} from '../src/main/data/cover-prompt-service'
import { buildCoverPrompt, GENRE_STYLES } from '../src/main/data/skill-prompts/cover/cover-styles'
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
    expect(withProps).toContain('Key symbolic elements: a shattered bronze sword.')
    const without = buildCoverPrompt({ ...base, scene: { characterDesc: 'x' } })
    expect(without).not.toContain('Key symbolic elements')
  })

  it('scene 构图不描述主体人物（避免与 no human figure 矛盾）', () => {
    const prompt = buildCoverPrompt({
      ...base,
      composition: 'scene',
      scene: { characterDesc: 'a lone swordsman' }
    })
    expect(prompt).toContain('no human figure as main subject')
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
    expect(prompt).toContain('Color palette: rust red and ash grey.')
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
    chapterService as any
  )
  return { service, generateStream }
}

describe('CoverPromptService.extract', () => {
  const input = {
    projectId: 'p1',
    bookName: '断刀行',
    authorName: '老猫',
    platform: 'fanqie' as const
  }

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
    expect(draft.prompt).toContain('Key symbolic elements: a shattered blade.')
    expect(draft.prompt).toContain('Color palette: ash grey and blood red.')
    expect(draft.prompt).toContain('偏冷色调，雪山，断刀')
    expect(draft.prompt).toContain("Title text '断刀行'")
    expect(draft.prompt).toContain("Author name '老猫'")
    expect(draft.prompt).toContain('no watermark')

    // 走 auxiliary 路由，且带上 projectId 便于用量归属
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(generateStream.mock.calls[0][1].meta).toEqual({
      feature: 'coverPrompt',
      projectId: 'p1'
    })
  })

  it('素材原文进入提示词（不是只发书名）', async () => {
    const { service, generateStream } = makeService({ llmResponse: '{"genre":"urban"}' })
    await service.extract(input)
    const prompt = generateStream.mock.calls[0][0] as string
    expect(prompt).toContain('断刀行')
    expect(prompt).toContain('一个断臂刀客的复仇')
    expect(prompt).toContain('主角在雪山之巅断刀重铸')
  })

  it('genreOverride 锁定题材，模型返回值不生效', async () => {
    const { service } = makeService({ llmResponse: '{"genre":"light_novel"}' })
    const draft = await service.extract({ ...input, genreOverride: 'mystery' })
    expect(draft.genre).toBe('mystery')
  })

  it('compositionOverride 锁定构图，模型返回值不生效', async () => {
    const { service } = makeService({ llmResponse: '{"composition":"duo"}' })
    const draft = await service.extract({ ...input, compositionOverride: 'scene' })
    expect(draft.composition).toBe('scene')
    // scene 构图不描述主体人物
    expect(draft.prompt).toContain('no human figure as main subject')
  })

  it('模型给出非法 genre / composition 时兜底', async () => {
    const { service } = makeService({
      llmResponse: '{"genre":"不存在的题材","composition":"bogus"}'
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
    const { service, generateStream } = makeService({ llmResponse: '{"genre":"urban"}' })
    await service.extract({ ...input, extraHint: '主角改成女性' })
    expect(generateStream.mock.calls[0][0]).toContain('主角改成女性')
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
    expect(draft.prompt).toContain('Selected visual style lock (暗黑悬疑电影)')
  })

  it('提炼内容后仍保留用户选择的文字排版', async () => {
    const { service } = makeService({
      llmResponse: '{"genre":"xianxia","composition":"fullbody","characterDesc":"a blade master"}'
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
    expect(draft.prompt).toContain('oversized ultra-bold stacked Chinese display lettering')
    expect(draft.prompt).toContain('across the lower third')
    expect(draft.prompt).toContain('metallic gold or silver material')
    expect(draft.prompt).toContain('small refined Chinese Song-style serif lettering')
    expect(draft.prompt).toContain('at the lower right inside the safe area')
  })

  it('无人物概念风格即使模型返回人物构图也强制改为 scene', async () => {
    const { service } = makeService({
      llmResponse: '{"genre":"mystery","composition":"closeup","characterDesc":"a detective"}'
    })
    const draft = await service.extract({ ...input, stylePreset: 'concept_symbol' })
    expect(draft.composition).toBe('scene')
    expect(draft.prompt).not.toContain('a detective')
  })

  it('下发 JSON Schema 供支持结构化输出的 provider 强约束', async () => {
    const { service, generateStream } = makeService({ llmResponse: '{"genre":"urban"}' })
    await service.extract(input)
    expect(generateStream.mock.calls[0][1].jsonSchema).toBe(COVER_DRAFT_SCHEMA)
  })

  it('提示词仍自带 JSON 格式要求（不支持 schema 的 provider 靠它）', async () => {
    const { service, generateStream } = makeService({ llmResponse: '{"genre":"urban"}' })
    await service.extract(input)
    const prompt = generateStream.mock.calls[0][0] as string
    expect(prompt).toContain('只输出一个 JSON 对象')
    // schema 的每个字段都要在提示词里出现，两条路径才不会各说各话
    for (const key of COVER_DRAFT_SCHEMA.required) {
      expect(prompt).toContain(key)
    }
  })

  it('空字段回退题材模板，不会往提示词里塞空描述', async () => {
    const { service } = makeService({
      llmResponse: '{"genre":"urban","characterDesc":"","keyProps":"   "}'
    })
    const draft = await service.extract(input)
    // characterDesc 空 → 用 urban 模板的默认人物描述
    expect(draft.prompt).toContain(GENRE_STYLES.urban.characterDesc)
    // keyProps 空 → 整行不出现
    expect(draft.prompt).not.toContain('Key symbolic elements')
    expect(draft.prompt).not.toContain('..')
  })
})
