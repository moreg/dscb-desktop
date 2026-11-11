import { describe, it, expect } from 'vitest'
import { DIALOGUE_PARAGRAPHS, DIALOGUE_PUNCTUATION_RULE } from '../src/shared/prose-policy'
import { buildDeslopPrompt } from '../src/main/data/skill-prompts/deslop/anti-ai-methods'
import {
  buildSystemPrompt,
  resolveGenreVoice,
  flattenForbiddenWords,
  CHAPTER_RULE_SECTIONS,
  FORBIDDEN_WORD_CATEGORIES,
  GENRE_VOICES
} from '../src/main/data/skill-prompts'

describe('resolveGenreVoice', () => {
  it('验收与修复使用共享的默认分段，保留连续发言自然合段和规范句号', () => {
    expect(DIALOGUE_PUNCTUATION_RULE).toContain(DIALOGUE_PARAGRAPHS)
    expect(DIALOGUE_PUNCTUATION_RULE).toContain('同一段发言中意思连贯的内容用逗号')
    expect(DIALOGUE_PUNCTUATION_RULE).toContain('完整陈述句使用句号')
    expect(DIALOGUE_PUNCTUATION_RULE).not.toContain('除末尾句号外不出现中文句号')
  })
  it('returns urban as default when genre is empty', () => {
    expect(resolveGenreVoice(undefined).key).toBe('urban')
    expect(resolveGenreVoice('').key).toBe('urban')
    expect(resolveGenreVoice('   ').key).toBe('urban')
  })

  it.each([
    ['古风修真', 'xianxia'],
    ['仙侠', 'xianxia'],
    ['末日丧尸', 'wasteland'],
    ['末日废土', 'wasteland'],
    ['玄幻', 'fantasy'],
    ['修仙', 'fantasy'],
    ['现代都市', 'urban'],
    ['职场', 'urban'],
    ['娱乐圈', 'urban'],
    ['悬疑推理', 'mystery'],
    ['搞笑沙雕', 'comedy'],
    ['虐文', 'tragedy'],
    ['军史', 'historical']
  ])('maps %s → %s', (genre, expected) => {
    expect(resolveGenreVoice(genre).key).toBe(expected)
  })

  it('末日 takes priority over 现代 (rule order matters)', () => {
    expect(resolveGenreVoice('末日现代').key).toBe('wasteland')
  })
})

describe('buildSystemPrompt', () => {
  it.each([undefined, 'extend', 'finish'] as const)('生成模式 %s 不下发润色套句样例，润色保留针对性诊断', (mode) => {
    const generation = buildSystemPrompt('都市', null, undefined, null, mode)
    const deslop = buildDeslopPrompt('原有片段。', 'mild', [], ['B'])
    expect(generation).toContain('没有新变化时无需给每个动作补心理')
    expect(generation).not.toContain('张了张嘴')
    expect(deslop).toContain('张了张嘴')
    expect(deslop).toContain('没有回复这句')
    expect(deslop).toContain('不按词语命中机械删除')
  })
  it.each([undefined, 'extend', 'finish'] as const)('%s 的场景与信息规则独立于编辑小节，保留作者自定义', (mode) => {
    const overrides = { deai: '', dialogue: '作者自定义：保留人物方言和克制语气。' }
    const before = { ...overrides }
    const prompt = buildSystemPrompt('历史', null, overrides, null, mode)
    expect(prompt).toContain('【从人物处境写场景】')
    expect(prompt).toContain('对白可以直答、合作、争执或转述')
    expect(prompt).toContain('连续动作按目的、阻力与结果组织')
    expect(prompt).toContain('区分客观事实、亲见、转述、猜测、误信和作者预设')
    expect(prompt).not.toContain('【默认成稿精修：保留剧情、人设和文风】')
    expect(prompt).toContain(overrides.dialogue)
    expect(overrides).toEqual(before)
    if (mode) expect(prompt).toContain('禁止重写、复述或另起一个开头')
  })

  it('改味入口默认沿用同一精修规则，仍保护原稿范围与事实', () => {
    const prompt = buildDeslopPrompt('原有片段。', 'mild', [], ['B'])
    expect(prompt).toContain('【默认成稿精修：保留剧情、人设和文风】')
    expect(prompt).toContain('避免动作清单感')
    expect(prompt).toContain('原稿是唯一剧情基线')
    expect(prompt).toContain('原有片段。')
  })

  it('番茄开篇专项只向平台明确为番茄的正文请求注入', () => {
    const prompt = (platform: 'fanqie' | 'qimao' | null) => buildSystemPrompt('玄幻', null,
      undefined, null, 'extend', { platform, text: '' })
    expect(prompt('fanqie')).toContain('已生效的新增利益')
    expect(prompt('fanqie')).toContain('不凭空补造收益、能力或越过续写边界')
    expect(prompt('qimao')).not.toContain('【番茄开篇冲突与首次兑现')
    expect(prompt(null)).not.toContain('【番茄开篇冲突与首次兑现')
  })

  it('已有无比例条款和未知自定义内容保留', () => {
    const old = '- **对白与叙述按场景需要安排，不设强制比例**。需要交锋、试探或交流时直接写出，行动、独处与场景因果用必要叙述交代，不为凑对白增删情节。'
    const custom = '作者自定义：此次独处场景保留必要的沉默。'
    const prompt = buildSystemPrompt('悬疑', null, { style_targets: old + '\n' + custom })
    expect(prompt).toContain(old)
    expect(prompt).toContain('不设强制比例')
    expect(prompt).toContain(custom)
  })

  it('旧内置限制句号规则迁移为规范标点，配置对象不变', () => {
    const old = '同一对引号内的中间不能出现中文句号「。」，陈述台词只在闭合引号前保留一个句号；陈述台词以句号加闭合引号收尾'
    const overrides = { dialogue: old }
    const prompt = buildSystemPrompt(undefined, null, overrides)
    expect(prompt).toContain('完整陈述台词末尾用句号')
    expect(prompt).not.toContain('陈述台词只在闭合引号前保留一个句号')
    expect(overrides.dialogue).toBe(old)
  })
  it.each([undefined, 'extend', 'finish'] as const)('%s 模式按技能统一分段和对白标点', (mode) => {
    const defaults = buildSystemPrompt(undefined, null, undefined, null, mode)
    expect(defaults).toContain('默认一句一段，段间空一行')
    expect(defaults).toContain('不设强制比例')
    const prompt = buildSystemPrompt(undefined, null, { dialogue: '' }, null, mode)
    const finalRules = prompt.slice(prompt.lastIndexOf('【正文保真共享规则'))
    expect(finalRules).toContain('一句一段')
    expect(finalRules).toContain('完整陈述台词末尾用句号')
    expect(finalRules).toContain(DIALOGUE_PARAGRAPHS)
    expect(finalRules).not.toContain('不按句号机械拆分多句发言')
  })

  it('旧内置强制拆段迁移为短段优先且允许自然合段，保留作者其他自定义要求', () => {
    const oldRule = '- **一句一段**：每段只写一句完整的话，同一行动与其直接反馈若是两句话也必须分段，不把独立句子的句号改成逗号规避分段。对话独立成段，引号内中间不用中文句号，陈述台词结尾保留句号；多句台词拆成引号完整的独立段落，问号、感叹号按语气保留。'
    const prompt = buildSystemPrompt(undefined, null, { style_targets: oldRule + '\n保留作者自己的语气要求。' })
    expect(prompt).toContain('默认一句一段，段间空一行')
    expect(prompt).toContain('意思连贯的两句可以用逗号')
    expect(prompt).toContain('保留作者自己的语气要求。')
  })

  it('明确自定义比例和其他作者条款保留，默认不施加70%门槛', () => {
    const custom = '作者自定义：本书对白约70%，保留方言，不按段数统计。'
    const prompt = buildSystemPrompt('都市', null, { style_targets: custom })
    expect(prompt).toContain(custom)
    expect(buildSystemPrompt('都市')).not.toContain('目标 70%')
    expect(prompt).toContain('作者明确指定的项目比例')
  })

  it('生成保留整场诊断，不下发内置逐词替换表', () => {
    const prompt = buildSystemPrompt('现代都市')
    expect(prompt).toContain('不按词语命中机械删除')
    expect(prompt).not.toContain('语感用词参考')
    for (const cat of FORBIDDEN_WORD_CATEGORIES) {
      expect(prompt).not.toContain(cat.name)
      expect(flattenForbiddenWords()).toContain(cat.words[0])
    }
  })

  it('embeds chapter ending rules', () => {
    const prompt = buildSystemPrompt('玄幻')
    expect(prompt).toContain('章末结尾原则')
    expect(prompt).toContain('对话、事件、动作、心理或平静收束都可以')
    expect(prompt).toContain('不强制每章出现突发事件、反转或未说完的台词')
    expect(prompt).toContain('不追加空泛说教、重复解释')
  })

  it('only includes the default outline rules when there is a chapter plan', () => {
    const prompt = buildSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined, 'write', true)
    expect(prompt).toContain('顺序铁律')
    expect(prompt).toContain('完整铁律')
    expect(prompt).toContain('边界铁律')
    expect(buildSystemPrompt()).not.toContain('顺序铁律')
  })

  it.each([undefined, 'extend', 'finish'] as const)('keeps the reader knowledge boundary in %s mode', (mode) => {
    const prompt = buildSystemPrompt(undefined, null, undefined, null, mode)
    expect(prompt).toContain('以读者读到当前位置时已获知的信息为边界')
    expect(prompt).toContain('章末钩子只呈现本章当下发生的事件或可感知线索')
  })

  it('embeds default narration rules from the editable section registry', () => {
    const prompt = buildSystemPrompt()
    const narration = CHAPTER_RULE_SECTIONS.find((section) => section.key === 'deai')!
    expect(prompt).toContain(narration.text)
    expect(narration.text).toContain('【自然准确的叙述】')
  })

  it('embeds dialogue rules', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('真人对话特征')
    expect(prompt).toContain('动作位置服从事件顺序')
  })

  it.each([undefined, 'extend', 'finish'] as const)('%s 模式允许台词按语气断句', (mode) => {
    const prompt = buildSystemPrompt(undefined, null, undefined, null, mode)
    expect(prompt).toContain('问句和感叹句按语气')
    expect(prompt).not.toContain('台词中间严禁使用句号')
  })

  it('embeds negative constraints', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('写作负向限制（结合连续场景判断）')
    expect(prompt).toContain('避免用人物轮流复述信息')
    expect(prompt).toContain('可以保留服务于体验、关系或后果的细节')
    expect(prompt).not.toContain('事件-反应-结果')
  })

  it.each([undefined, 'extend', 'finish'] as const)(
    'applies custom narration and dialogue in %s mode; unlisted sections keep defaults',
    (mode) => {
      const narration = CHAPTER_RULE_SECTIONS.find((section) => section.key === 'deai')!
      const prompt = buildSystemPrompt(
        '玄幻',
        null,
        {
          dialogue: '【自定义对话规则】只许说真话。',
          deai: '【自定义叙述规则】采用作者指定的抒情文风。'
        },
        null,
        mode
      )
      expect(prompt).toContain('【自定义对话规则】只许说真话。')
      expect(prompt).toContain('【自定义叙述规则】采用作者指定的抒情文风。')
      // 未覆盖的小节仍用内置默认，续写覆盖声明也不能重新插入默认叙述要求。
      expect(prompt).toContain('章末结尾原则')
      expect(prompt).not.toContain(narration.text)
      expect(prompt).not.toContain('【自然准确的叙述】')
      expect(prompt).not.toContain('真人对话特征')
    }
  )

  it.each([undefined, 'extend', 'finish'] as const)(
    'skips disabled narration and ending sections in %s mode',
    (mode) => {
      const prompt = buildSystemPrompt('玄幻', null, { ending: '', deai: '' }, null, mode)
      expect(prompt).not.toContain('章末结尾原则')
      expect(prompt).not.toContain('【自然准确的叙述】')
      // 其他小节与续写行为不受影响。
      expect(prompt).toContain('真人对话特征')
      expect(prompt.includes('续写模式覆盖声明')).toBe(mode !== undefined)
    }
  )

  it('embeds continuity rules', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('衔接检查')
    expect(prompt).toContain('从上章的实际状态或本章已写断点接起')
  })

  it('embeds output rules', () => {
    const prompt = buildSystemPrompt()
    // 篇幅由写作任务统一给出；生成守则不能额外要求凑够固定长度。
    expect(prompt).not.toContain('2500')
    expect(prompt).not.toContain('2000–2700')
    expect(prompt).not.toContain('宁可写超也不要写不够')
    expect(prompt).toContain('剧情完整与可读性优先')
    expect(prompt).toContain('剩余剧情点已经完整落实时允许提前结束')
    expect(prompt).toContain('Markdown')
    expect(prompt).toContain('正文禁止出现出版章号')
    expect(prompt).toContain('只是检索坐标，禁止写入正文')
    expect(prompt).toContain('用符合本作语气的语言写清场景')
    expect(prompt).toContain('文笔必须为剧情服务')
  })

  it.each([undefined, 'extend', 'finish'] as const)('%s 模式按场景安排句段和人物反应', (mode) => {
    const prompt = buildSystemPrompt(undefined, null, undefined, null, mode)
    expect(prompt).toContain('一句一段也可以是一句有层次的长句')
    expect(prompt).toContain('视角人物眼下要做什么、知道什么、受什么阻碍')
    expect(prompt).toContain('围绕他为何选择、身体与判断怎样受影响')
    expect(prompt).toContain('短句可自然出现')
    expect(prompt).toContain('不能据相似细节补造人物以往的经历')
    expect(prompt).not.toContain('同一人的台词必须一次性说完')
  })

  it('未提供对标书时也约束原创表达、人物动机与场景变化，并允许有用途的情绪氛围', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('无论是否提供对标书，都必须使用原创表达')
    expect(prompt).toContain('不得只替换人名、地名、道具做同义改写')
    expect(prompt).toContain('人物此刻知道的信息、处境、能力、关系与目的')
    expect(prompt).toContain('保留行动条件与真正付出的代价')
    expect(prompt).toContain('环境、心理与停顿用来呈现人物经历、关系、氛围及取舍')
    expect(prompt).toContain('保留人物做得到的主动行动')
    expect(prompt).toContain('重复堆砌、机械扩写或添加无效铺陈')
  })

  it.each(['extend', 'finish'] as const)('续写 %s 覆盖旧版硬字数规则，先续完句子和进行中剧情点', (mode) => {
    const legacyOutput = '【用户旧版输出规则】目标字数是硬性下限，宁可写超也不要写不够。'
    const prompt = buildSystemPrompt(undefined, null, { output: legacyOutput }, null, mode, undefined, 'write', true)
    // 保留用户可编辑内容，但续写专用解释在其后覆盖旧版冲突条款。
    expect(prompt).toContain(legacyOutput)
    const continuation = prompt.slice(prompt.indexOf('续写模式覆盖声明（接缝、范围、篇幅与收束）'))
    expect(continuation).toContain('本次一律改为篇幅参考')
    expect(continuation).toContain('剩余剧情点已完整落实时可以提前结束')
    expect(continuation).toContain('先从断点续完')
    expect(continuation).toContain('不得插入动作或另起一句打断')
    expect(continuation).toContain('不强制动作起手')
    expect(continuation).toContain('先续完进行中的关键情节')
    expect(continuation).toContain('文风、对白和排版遵守作者明确要求')
    expect(continuation).not.toContain('第一句必须**立刻切入具体物理动作')
    expect(continuation).not.toContain('本次要新增**的字数下限')
  })

  it('生成避免按操作断句，并保护使结果成立的事实', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).not.toContain('楚弈点进去')
    expect(prompt).not.toContain('今日下午')
    expect(prompt).not.toContain('夏季健康提醒')
    expect(prompt).toContain('保留使后果成立的动作、先后、位置和交接')
    expect(prompt).toContain('不靠逗号把所有操作串成一句')
  })

  it('选用古风时保留题材语气，不下发替换示例', () => {
    const prompt = buildSystemPrompt('古风修真')
    expect(prompt).toContain(resolveGenreVoice('古风修真').tone)
    expect(prompt).not.toContain('语感用词参考')
    expect(prompt).not.toContain('他心里直骂娘')
  })

  it('选用都市时保留题材语气，不下发替换示例', () => {
    const prompt = buildSystemPrompt('现代都市')
    expect(prompt).toContain(resolveGenreVoice('现代都市').tone)
    expect(prompt).not.toContain('语感用词参考')
  })

  it.each(['extend', 'finish'] as const)('续写 %s 保留题材语感与场景诊断，不下发词语替换表', (mode) => {
    const prompt = buildSystemPrompt('悬疑', null, undefined, null, mode)
    expect(prompt).toContain('## 1. 题材定位（默认语感参考）')
    expect(prompt).toContain('克制、留白、信息量密')
    expect(prompt).toContain('连续动作按目的、阻力与结果组织')
    expect(prompt).toContain('疼痛、恐惧、迟疑、盘算或必要的空间因果可以直写')
    expect(prompt).toContain('不为钩子硬加突发事件或无动机的等待')
    expect(prompt).toContain('不能只剩轮流报状态、接令和执行')
    expect(prompt).toContain('规则、关键数字、影响成败的顺序、必要步骤和时限照实保留')
    expect(prompt).toContain('结论只及证据支持的对象、时点与条件')
    expect(prompt).toContain('人物可以据此暂不采信或误判')
    expect(prompt).toContain('已经清楚的结果无需再汇报一遍')
    expect(prompt).not.toContain('按细纲承接')
    expect(prompt).not.toContain('语感用词参考')
    expect(prompt).not.toContain('高频套写排查参考')
  })

  it('不同 genre 生成的 prompt 头部不同', () => {
    const a = buildSystemPrompt('古风修真')
    const b = buildSystemPrompt('现代都市')
    expect(a.slice(0, 600)).not.toBe(b.slice(0, 600))
  })

  it('全部 9 类题材都能渲染', () => {
    for (const voice of GENRE_VOICES) {
      const prompt = buildSystemPrompt(voice.label)
      expect(prompt).toContain(voice.label)
      expect(prompt).toContain(voice.tone)
    }
  })
})

describe('flattenForbiddenWords', () => {
  it('returns all forbidden words from all categories', () => {
    const flat = flattenForbiddenWords()
    expect(flat.length).toBeGreaterThan(50)
    expect(flat).toContain('嘴角勾起')
    expect(flat).toContain('心跳慢了一拍')
    expect(flat).toContain('鱼肚白')
    expect(flat).toContain('意味深长')
  })
})

describe('genre-voice suggestedParticles（题材语气词）', () => {
  it('古风/仙侠有可按情境选用的语气词清单', () => {
    const voice = resolveGenreVoice('古风')
    expect(voice.suggestedParticles?.length).toBeGreaterThan(5)
    expect(voice.suggestedParticles).toContain('约莫')
    expect(voice.suggestedParticles).toContain('殊不知')
    expect(voice.suggestedParticles).toContain('焉知')
  })

  it('古风语气词渲染进 system prompt', () => {
    const prompt = buildSystemPrompt('古风')
    expect(prompt).toContain('按情境选用的题材语气词')
    expect(prompt).toContain('约莫')
    expect(prompt).toContain('殊不知')
  })

  it('现代都市没有 suggestedParticles（不渲染该行）', () => {
    const voice = resolveGenreVoice('现代都市')
    expect(voice.suggestedParticles).toBeUndefined()
    const prompt = buildSystemPrompt('现代都市')
    expect(prompt).not.toContain('按情境选用的题材语气词')
  })
})


describe('题材语感不强制机关式对白', () => {
  it('都市保留口语与对话风格，不把带梗或持续吐槽当任务', () => {
    const prompt = buildSystemPrompt('都市生活')
    expect(prompt).toContain('幽默随人物与场合自然出现')
    expect(prompt).toContain('不要求持续吐槽')
    expect(prompt).not.toContain('口语化、接地气、带梗')
    expect(prompt).not.toContain('内心吐槽多')
    expect(prompt).not.toContain('4. 标准化收尾')
    expect(prompt).toContain('普通的“好”“嗯”和直接回答按语境保留')
    expect(prompt).toContain('不设强制比例')
  })
  it('都市生成不按词面机械删改', () => {
    expect(buildSystemPrompt('都市')).toContain('不按词语命中机械删除')
  })
})
