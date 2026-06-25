import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  resolveGenreVoice,
  flattenForbiddenWords,
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

  it('embeds 7 de-AI techniques', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('展示反应，而非解释情绪')
    expect(prompt).toContain('直给原则')
    expect(prompt).toContain('打破对仗感')
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

  it('applies chapter rule overrides; unlisted sections keep defaults', () => {
    const prompt = buildSystemPrompt('玄幻', null, {
      dialogue: '【自定义对话规则】只许说真话。'
    })
    expect(prompt).toContain('【自定义对话规则】只许说真话。')
    // 未覆盖的小节仍用内置默认
    expect(prompt).toContain('章末结尾硬性原则')
    // 对话小节被整体覆盖，其默认标记不再出现
    expect(prompt).not.toContain('真人对话特征')
  })

  it('skips a section whose override is an empty string (= 停用)', () => {
    const prompt = buildSystemPrompt('玄幻', null, { ending: '' })
    expect(prompt).not.toContain('章末结尾硬性原则')
    // 其他小节不受影响
    expect(prompt).toContain('真人对话特征')
  })

  it('embeds continuity rules', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('衔接检查')
    expect(prompt).toContain('禁止凭空起头')
  })

  it('embeds output rules', () => {
    const prompt = buildSystemPrompt()
    // 字数不再在 system prompt 写死具体值，改为"以下文目标字数为硬性下限"
    expect(prompt).not.toContain('2500')
    expect(prompt).toContain('硬性下限')
    expect(prompt).toContain('Markdown')
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
