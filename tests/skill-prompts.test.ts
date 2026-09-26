import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  resolveGenreVoice,
  flattenForbiddenWords,
  CHAPTER_RULE_SECTIONS,
  FORBIDDEN_WORD_CATEGORIES,
  GENRE_VOICES
} from '../src/main/data/skill-prompts'

describe('resolveGenreVoice', () => {
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
  it('embeds 12 forbidden word categories with hints', () => {
    const prompt = buildSystemPrompt('现代都市')
    for (const cat of FORBIDDEN_WORD_CATEGORIES) {
      expect(prompt).toContain(cat.name)
      // 抽样校验至少含 1 个该类禁词
      expect(prompt).toContain(cat.words[0])
    }
  })

  it('embeds chapter ending rules', () => {
    const prompt = buildSystemPrompt('玄幻')
    expect(prompt).toContain('章末结尾硬性原则')
    expect(prompt).toContain('对话结尾')
    expect(prompt).toContain('事件结尾')
    expect(prompt).toContain('AI 味抒怀')
  })

  it('embeds three iron rules of outline obedience', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('顺序铁律')
    expect(prompt).toContain('完整铁律')
    expect(prompt).toContain('边界铁律')
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
    expect(prompt).toContain('同一人台词中间禁止插入动作打断')
  })

  it('embeds negative constraints', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('严格禁止与写作负向限制')
    expect(prompt).toContain('工具人/背景板路人')
    expect(prompt).toContain('对话中夹杂长神态描写')
    expect(prompt).toContain('事件-反应-结果')
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
      expect(prompt).toContain('章末结尾硬性原则')
      expect(prompt).not.toContain(narration.text)
      expect(prompt).not.toContain('【自然准确的叙述】')
      expect(prompt).not.toContain('真人对话特征')
    }
  )

  it.each([undefined, 'extend', 'finish'] as const)(
    'skips disabled narration and ending sections in %s mode',
    (mode) => {
      const prompt = buildSystemPrompt('玄幻', null, { ending: '', deai: '' }, null, mode)
      expect(prompt).not.toContain('章末结尾硬性原则')
      expect(prompt).not.toContain('【自然准确的叙述】')
      // 其他小节与续写行为不受影响。
      expect(prompt).toContain('真人对话特征')
      expect(prompt.includes('续写模式覆盖声明')).toBe(mode !== undefined)
    }
  )

  it('embeds continuity rules', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('衔接检查')
    expect(prompt).toContain('禁止凭空起头')
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
    expect(prompt).toContain('段落之间用空行分隔')
  })

  it('未提供对标书时也约束原创表达、人物动机与场景变化，并允许有用途的情绪氛围', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('无论是否提供对标书，都必须使用原创表达')
    expect(prompt).toContain('不得只替换人名、地名、道具做同义改写')
    expect(prompt).toContain('人物动机、性格、能力和当时可知信息')
    expect(prompt).toContain('结果须有因果与相应代价')
    expect(prompt).toContain('以场景为单位检查')
    expect(prompt).toContain('至少一项出现读者可感知的变化')
    expect(prompt).toContain('允许必要的情绪消化、关系建立、氛围和留白')
    expect(prompt).toContain('不要求每段都推进主线')
    expect(prompt).toContain('重复堆砌、机械扩写或添加无效铺陈')
  })

  it.each(['extend', 'finish'] as const)('续写 %s 覆盖旧版硬字数规则，先续完句子和进行中剧情点', (mode) => {
    const legacyOutput = '【用户旧版输出规则】目标字数是硬性下限，宁可写超也不要写不够。'
    const prompt = buildSystemPrompt(undefined, null, { output: legacyOutput }, null, mode)
    // 保留用户可编辑内容，但续写专用解释在其后覆盖旧版冲突条款。
    expect(prompt).toContain(legacyOutput)
    const continuation = prompt.slice(prompt.indexOf('续写模式覆盖声明（最高优先级）'))
    expect(continuation).toContain('本次一律改为篇幅参考')
    expect(continuation).toContain('剩余剧情点已完整落实时可以提前结束')
    expect(continuation).toContain('先从断点续完')
    expect(continuation).toContain('不得插入动作或另起一句打断')
    expect(continuation).toContain('不强制动作起手')
    expect(continuation).toContain('先续完进行中的剧情点')
    expect(continuation).not.toContain('第一句必须**立刻切入具体物理动作')
    expect(continuation).not.toContain('本次要新增**的字数下限')
  })

  it('对称流水账改写示例保留原有事实，不通过新增具体细节拉长', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('楚弈点进去才发现时标没了，退回列表一看，标题也改了。')
    expect(prompt).not.toContain('今日下午')
    expect(prompt).not.toContain('夏季健康提醒')
    expect(prompt).toContain('只调整表达，不凭空增加原文没有的事实')
  })

  it('选用古风时包含古风替换示例，不包含都市口语', () => {
    const prompt = buildSystemPrompt('古风修真')
    expect(prompt).toContain('勾了勾唇')
    expect(prompt).toContain('天色将明')
    // urban 专属的"他心里直骂娘"不应出现在古风 prompt
    expect(prompt).not.toContain('他心里直骂娘')
  })

  it('选用都市时包含都市替换示例', () => {
    const prompt = buildSystemPrompt('现代都市')
    expect(prompt).toContain('他心里直骂娘')
    expect(prompt).toContain('天刚亮')
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
