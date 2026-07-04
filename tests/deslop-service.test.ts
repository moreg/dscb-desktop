import { describe, it, expect } from 'vitest'
import {
  gatesForLevel,
  passesForLevel,
  buildDeslopPrompt,
  extractRewritten,
  extractChangeSummary,
  GATE_METHODS,
  DESLOP_SYSTEM_PROMPT,
  numberLines
} from '../src/main/data/skill-prompts/deslop/anti-ai-methods'
import type { DeslopLevel, DeslopFinding } from '../src/shared/types'

describe('gatesForLevel 分级 → Gate 范围', () => {
  it('轻度只过 Gate A + B', () => {
    expect(gatesForLevel('mild')).toEqual(['A', 'B'])
  })
  it('中度过 A + B + C + D + G', () => {
    expect(gatesForLevel('moderate')).toEqual(['A', 'B', 'C', 'D', 'G'])
  })
  it('重度全 Gate', () => {
    expect(gatesForLevel('severe')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })
})

describe('passesForLevel 三遍法映射', () => {
  it('轻度只 Pass 1', () => {
    expect(passesForLevel('mild')).toEqual([1])
  })
  it('中度 Pass 1 + 2', () => {
    expect(passesForLevel('moderate')).toEqual([1, 2])
  })
  it('重度完整三遍', () => {
    expect(passesForLevel('severe')).toEqual([1, 2, 3])
  })
})

describe('GATE_METHODS 7 个 Gate 齐全', () => {
  it('A-G 全部有方法说明', () => {
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(GATE_METHODS[g]).toBeTruthy()
      expect(GATE_METHODS[g].length).toBeGreaterThan(20)
    }
  })
})

describe('buildDeslopPrompt 构建', () => {
  const mockFindings: DeslopFinding[] = [
    {
      line: 1,
      column: 1,
      type: 'banned-word',
      severity: 'advisory',
      gate: 'A',
      message: '禁用词「仿佛」',
      excerpt: '仿佛',
      word: '仿佛'
    },
    {
      line: 2,
      column: 1,
      type: 'not-is-comparison',
      severity: 'blocking',
      gate: 'B',
      message: '不是A而是B',
      excerpt: '不是冷漠，而是绝望'
    }
  ]

  it('包含分级名称和删除比例', () => {
    const prompt = buildDeslopPrompt('原文', 'moderate', mockFindings, ['A', 'B'])
    expect(prompt).toContain('中度')
    expect(prompt).toContain('25%')
  })

  it('包含命中的 Gate 方法', () => {
    const prompt = buildDeslopPrompt('原文', 'severe', mockFindings, ['A', 'B'])
    expect(prompt).toContain('Gate A')
    expect(prompt).toContain('Gate B')
  })

  it('包含命中项的行号和摘录', () => {
    const prompt = buildDeslopPrompt('原文', 'moderate', mockFindings, ['A', 'B'])
    expect(prompt).toContain('第1行')
    expect(prompt).toContain('仿佛')
  })

  it('未命中 Gate 不注入', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', mockFindings, ['A', 'B'])
    expect(prompt).not.toContain('Gate F') // 轻度不处理 F
  })

  it('输出格式包含【改写后】和【改动说明】', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'])
    expect(prompt).toContain('【改写后】')
    expect(prompt).toContain('【改动说明】')
  })

  it('原文以「行号|正文」格式注入，供改动说明引用行号', () => {
    const prompt = buildDeslopPrompt('第一行\n第二行', 'mild', [], ['A', 'B'])
    expect(prompt).toContain('1|第一行')
    expect(prompt).toContain('2|第二行')
  })

  it('无 styleContext 时按通则处理', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'])
    expect(prompt).toContain('风格语境')
    expect(prompt).toContain('未提供项目题材与文风档案')
  })

  it('注入题材与文风档案', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'], {
      genre: '玄幻',
      style: {
        identifiedStyle: '冷峻简练',
        tone: ['克制', '冷'],
        sentencePatterns: ['短句为主'],
        vocabularyPreferences: ['少用成语'],
        styleConstraints: ['情感克制优先用动作'],
        plotConstraints: ['穿插前世闪回']
      }
    })
    expect(prompt).toContain('题材：玄幻')
    expect(prompt).toContain('文风标识：冷峻简练')
    expect(prompt).toContain('语感/语气：克制；冷')
    expect(prompt).toContain('句式偏好：短句为主')
    expect(prompt).toContain('写作手法约束：情感克制优先用动作')
    expect(prompt).toContain('剧情/题材约束：穿插前世闪回')
  })

  it('只有 genre 无文风档案时只注入题材', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'], { genre: '都市' })
    expect(prompt).toContain('题材：都市')
    expect(prompt).not.toContain('文风标识')
  })

  it('genre 为"通用"时不注入题材行', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'], { genre: '通用' })
    expect(prompt).not.toContain('题材：通用')
  })

  it('改写原则禁止改写后引入新的 AI 味套路表达', () => {
    // 防止 LLM 把一种 AI 套路换成另一种（如批评"仿佛"自己却写"缓缓"）
    const prompt = buildDeslopPrompt('原文', 'moderate', mockFindings, ['A', 'B'])
    expect(prompt).toContain('改写后不得引入新的 AI 味')
    // 关键禁用词必须在 prompt 里点名
    expect(prompt).toContain('仿佛')
    expect(prompt).toContain('缓缓')
    expect(prompt).toContain('眼中闪过')
    expect(prompt).toContain('嘴角勾起')
    expect(prompt).toContain('不是A而是B')
    expect(prompt).toContain('这一刻他终于明白')
  })

  it('Gate C 含"具体感知后禁止追加复述比喻"', () => {
    const prompt = buildDeslopPrompt('原文', 'moderate', [], ['C'])
    expect(prompt).toContain('具体感知后禁止追加复述比喻')
    expect(prompt).toContain('仿佛要把那张纸攥碎') // 正例引用
  })

  it('Gate G 含"动作后不点破效果"和"角色主观偏差"', () => {
    const prompt = buildDeslopPrompt('原文', 'moderate', [], ['G'])
    expect(prompt).toContain('动作后不点破效果')
    expect(prompt).toContain('让所有人都愣住了') // 反例引用
    expect(prompt).toContain('角色主观偏差')
  })

  it('Gate E 含"对话内容本身去书面化"', () => {
    const prompt = buildDeslopPrompt('原文', 'severe', [], ['E'])
    expect(prompt).toContain('对话内容本身去书面化')
  })

  it('系统铁律含三条替换通路和本质洞察', () => {
    // DESLOP_SYSTEM_PROMPT 是常量，直接断言
    expect(DESLOP_SYSTEM_PROMPT).toContain('三条替换通路')
    expect(DESLOP_SYSTEM_PROMPT).toContain('静态描述→可观察变化')
    expect(DESLOP_SYSTEM_PROMPT).toContain('作者总结→角色感知')
    expect(DESLOP_SYSTEM_PROMPT).toContain('统计平均感')
  })

  it('题材为古风时注入古风语气词', () => {
    const prompt = buildDeslopPrompt('原文', 'mild', [], ['A', 'B'], { genre: '古风' })
    expect(prompt).toContain('建议主动使用的题材语气词')
    expect(prompt).toContain('约莫')
    expect(prompt).toContain('殊不知')
  })
})

describe('extractRewritten 解析 LLM 输出', () => {
  it('提取【改写后】段', () => {
    const output = '【改写后】\n这是改写后的正文。\n\n【改动说明】\n- Gate A: 改了3处'
    expect(extractRewritten(output)).toBe('这是改写后的正文。')
  })

  it('无标记时返回原文', () => {
    expect(extractRewritten('纯文本无标记')).toBe('纯文本无标记')
  })
})

describe('numberLines 行号渲染', () => {
  it('每行前加「行号|」', () => {
    expect(numberLines('甲\n乙\n丙')).toBe('1|甲\n2|乙\n3|丙')
  })

  it('空行也占一个行号', () => {
    expect(numberLines('甲\n\n丙')).toBe('1|甲\n2|\n3|丙')
  })
})

describe('extractChangeSummary 解析改动说明', () => {
  it('提取 bullet 列表', () => {
    const output = '【改写后】\n正文\n\n【改动说明】\n- Gate A：改了3处\n- Gate B：改了1处\n- 删除比例：5%'
    const summary = extractChangeSummary(output)
    expect(summary).toHaveLength(3)
    expect(summary[0]).toContain('Gate A')
  })

  it('无改动说明返回空数组', () => {
    expect(extractChangeSummary('无标记')).toEqual([])
  })

  it('提取逐条带行号/原句/理由的新格式', () => {
    const output = `【改写后】
正文

【改动说明】
- 第3行｜原句：仿佛被抽空 → 改后：像被抽空 ｜理由：前后是口语对话，书面比喻破坏语感
- 第7行｜原句：不是冷漠，而是绝望 → 改后：是绝望 ｜理由：否定铺垫冗余，直接给结论更利落`
    const summary = extractChangeSummary(output)
    expect(summary).toHaveLength(2)
    expect(summary[0]).toContain('第3行')
    expect(summary[0]).toContain('仿佛被抽空')
    expect(summary[0]).toContain('口语对话')
    expect(summary[1]).toContain('第7行')
  })
})
