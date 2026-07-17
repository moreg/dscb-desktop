import { describe, it, expect } from 'vitest'
import { scanAiPatterns } from '../src/main/data/deslop/check-ai-patterns'
import { scanDegeneration } from '../src/main/data/deslop/check-degeneration'
import { normalizePunctuation, countPunctuationIssues } from '../src/main/data/deslop/normalize-punctuation'

describe('check-ai-patterns: not-is-comparison「不是A，而是B」', () => {
  it('检测"不是A，而是B"（★★★★★ 最毒）', () => {
    const text = '他不是冷漠，而是绝望。\n这是普通句子。'
    const findings = scanAiPatterns(text)
    const notIs = findings.filter((f) => f.type === 'not-is-comparison')
    expect(notIs.length).toBeGreaterThanOrEqual(1)
    expect(notIs[0].severity).toBe('blocking')
    expect(notIs[0].gate).toBe('B')
    expect(notIs[0].excerpt).toContain('不是')
  })

  it('检测紧凑式"不是A是B"', () => {
    const text = '这不是勇气是愚蠢。'
    const findings = scanAiPatterns(text)
    const notIs = findings.filter((f) => f.type === 'not-is-comparison')
    expect(notIs.length).toBeGreaterThanOrEqual(1)
  })

  it('不误报"是不是"疑问', () => {
    const text = '你是不是傻？'
    const findings = scanAiPatterns(text)
    const notIs = findings.filter((f) => f.type === 'not-is-comparison')
    expect(notIs).toHaveLength(0)
  })

  it('不误报"不是A就是B"（either-or 连词）', () => {
    const text = '不是成就是败。'
    const findings = scanAiPatterns(text)
    const notIs = findings.filter((f) => f.type === 'not-is-comparison')
    expect(notIs).toHaveLength(0)
  })

  it('不误报反问尾巴"是吗"', () => {
    const text = '这样是对的吗？是吧。'
    const findings = scanAiPatterns(text)
    const notIs = findings.filter((f) => f.type === 'not-is-comparison')
    expect(notIs).toHaveLength(0)
  })
})

describe('check-ai-patterns: em-dash 破折号', () => {
  it('检测双破折号 ——', () => {
    const text = '他说——然后停了下来。'
    const findings = scanAiPatterns(text)
    const dash = findings.filter((f) => f.type === 'em-dash')
    expect(dash).toHaveLength(1)
    expect(dash[0].severity).toBe('blocking')
    expect(dash[0].gate).toBe('D')
  })

  it('检测双连字符 --', () => {
    const text = '他笑了 -- 然后离开。'
    const findings = scanAiPatterns(text)
    const dash = findings.filter((f) => f.type === 'em-dash')
    expect(dash.length).toBeGreaterThanOrEqual(1)
  })
})

describe('check-ai-patterns: 长段落', () => {
  it('检测 >200 字段落', () => {
    const longPara = '这是一段很长的文字'.repeat(30)
    const findings = scanAiPatterns(longPara)
    const longP = findings.filter((f) => f.type === 'long-paragraph')
    expect(longP.length).toBeGreaterThanOrEqual(1)
    expect(longP[0].severity).toBe('advisory')
  })

  it('短段落不报', () => {
    const text = '短句而已。'
    const findings = scanAiPatterns(text)
    expect(findings.filter((f) => f.type === 'long-paragraph')).toHaveLength(0)
  })
})

describe('check-ai-patterns: 碎句号', () => {
  it('连续 6+ 短叙述句报警', () => {
    const text = '他来。他走。他停。他看。他笑。他哭。他转身离开。'
    const findings = scanAiPatterns(text)
    const stutter = findings.filter((f) => f.type === 'period-stutter')
    expect(stutter.length).toBeGreaterThanOrEqual(1)
  })

  it('对话/弹幕短句豁免', () => {
    const text = '「来。」「走。」「停。」「看。」「笑。」「哭。」'
    const findings = scanAiPatterns(text)
    const stutter = findings.filter((f) => f.type === 'period-stutter')
    expect(stutter).toHaveLength(0)
  })
})

describe('check-ai-patterns: Gate A 句式与禁用词', () => {
  it('检测"仿佛…一般"', () => {
    const text = '他的目光仿佛能穿透一切一般锐利。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'fangfo')).toBe(true)
  })

  it('检测"眼中闪过一丝"', () => {
    const text = '她眼中闪过一丝悲伤。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'eye_flash')).toBe(true)
  })

  it('检测禁用词（一级）', () => {
    const text = '他缓缓走向前。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'banned-word' && f.word === '缓缓')).toBe(true)
  })

  it('白名单豁免禁用词', () => {
    const text = '他缓缓走向前。'
    const findings = scanAiPatterns(text, { whitelist: new Set(['缓缓']) })
    expect(findings.some((f) => f.type === 'banned-word' && f.word === '缓缓')).toBe(false)
  })

  it('检测排比"有的…有的…有的"', () => {
    const text = '有的人哭，有的人笑，有的人沉默不语。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'parallelism')).toBe(true)
  })
})

describe('check-ai-patterns: Gate F 结尾升华', () => {
  it('检测"他终于明白"', () => {
    const text = '他终于明白了真相。'
    const findings = scanAiPatterns(text)
    const sub = findings.filter((f) => f.type === 'sublimation')
    expect(sub.length).toBeGreaterThanOrEqual(1)
    expect(sub[0].gate).toBe('F')
  })

  it('检测"这一刻，"', () => {
    const text = '这一刻，她下定了决心。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'sublimation')).toBe(true)
  })

  it('检测"这就是X的意义"', () => {
    const text = '这就是成长的代价。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'sublimation')).toBe(true)
  })

  it('章末段落升华降级 blocking', () => {
    const text = '他往前走。\n他终于明白了一切。'
    const findings = scanAiPatterns(text)
    const sub = findings.filter((f) => f.type === 'sublimation')
    expect(sub.length).toBeGreaterThanOrEqual(1)
    // 章末（最后 2 行）的升华应为 blocking
    expect(sub.some((f) => f.severity === 'blocking')).toBe(true)
  })

  it('非结尾升华是 advisory', () => {
    const text = '他终于明白了一切。\n这是另一段话。\n他又往前走了一步。'
    const findings = scanAiPatterns(text)
    const sub = findings.filter((f) => f.type === 'sublimation')
    expect(sub.length).toBeGreaterThanOrEqual(1)
    expect(sub[0].severity).toBe('advisory')
  })
})

describe('check-ai-patterns: Gate C 心理描写外化', () => {
  it('检测"他感到愤怒"', () => {
    const text = '他感到愤怒，握紧了拳头。'
    const findings = scanAiPatterns(text)
    const psych = findings.filter((f) => f.type === 'psych-tell')
    expect(psych.length).toBeGreaterThanOrEqual(1)
    expect(psych[0].gate).toBe('C')
  })

  it('检测"她觉得自己很累"', () => {
    const text = '她觉得自己很累。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'psych-tell')).toBe(true)
  })

  it('检测"他心想，"', () => {
    const text = '他心想，这事没那么简单。'
    const findings = scanAiPatterns(text)
    expect(findings.some((f) => f.type === 'psych-tell')).toBe(true)
  })

  it('不误报"心中一凛"（已带身体反应，归 Gate A）', () => {
    const text = '她心中一凛，退后半步。'
    const findings = scanAiPatterns(text)
    // 心中一凛 是 Gate A 的 banned-word，不应产生 psych-tell
    expect(findings.some((f) => f.type === 'psych-tell')).toBe(false)
  })
})

describe('check-ai-patterns: Gate E 对话标签单一化', () => {
  it('连续 3+ 对话行用"X道"标签命中', () => {
    const text = [
      '「你来。」他说道。',
      '「我不去。」她说道。',
      '「必须去。」他说道。'
    ].join('\n')
    const findings = scanAiPatterns(text)
    const mono = findings.filter((f) => f.type === 'dialogue-tag-monotone')
    expect(mono.length).toBeGreaterThanOrEqual(1)
    expect(mono[0].gate).toBe('E')
  })

  it('连续 2 个不触发（阈值 3）', () => {
    const text = [
      '「你来。」他说道。',
      '「我不去。」她说道。',
      '他沉默了很久。'
    ].join('\n')
    const findings = scanAiPatterns(text)
    const mono = findings.filter((f) => f.type === 'dialogue-tag-monotone')
    expect(mono).toHaveLength(0)
  })

  it('非对话行打断计数', () => {
    const text = [
      '「你来。」他说道。',
      '「我不去。」她说道。',
      '夜色渐深，风停了。',
      '「必须去。」他说道。'
    ].join('\n')
    const findings = scanAiPatterns(text)
    // 2 + 1 = 不连续，不触发
    const mono = findings.filter((f) => f.type === 'dialogue-tag-monotone')
    expect(mono).toHaveLength(0)
  })
})

describe('check-degeneration: 复读检测', () => {
  it('紧邻整行重复（可见字数 ≥8）', () => {
    const text = '他慢慢地走向了那扇门。\n他慢慢地走向了那扇门。\n然后推开了它。'
    const findings = scanDegeneration(text)
    const rep = findings.filter((f) => f.type === 'repetition')
    expect(rep.length).toBeGreaterThanOrEqual(1)
    expect(rep[0].severity).toBe('blocking')
  })

  it('长句重复 ≥3 次（打转）', () => {
    const text = '这是一段足够长的句子用来测试复读检测功能的准确性。'.repeat(3)
    const findings = scanDegeneration(text)
    const rep = findings.filter((f) => f.type === 'repetition')
    expect(rep.length).toBeGreaterThanOrEqual(1)
  })

  it('短句复沓豁免（通俗网文手法）', () => {
    const text = '好的。\n好的。\n好的。'
    const findings = scanDegeneration(text)
    // 短句（可见字数 < 12）不判打转
    const longRep = findings.filter((f) => f.type === 'repetition' && f.message.includes('打转'))
    expect(longRep).toHaveLength(0)
  })
})

describe('check-degeneration: 占位符/拒绝语', () => {
  it('检测英文 AI 腔', () => {
    const text = 'Sure, here is the story.\n他走了。'
    const findings = scanDegeneration(text)
    expect(findings.some((f) => f.type === 'placeholder')).toBe(true)
  })

  it('检测括号省略占位符', () => {
    const text = '他们聊了很多（此处省略五百字），然后离开了。'
    const findings = scanDegeneration(text)
    expect(findings.some((f) => f.type === 'placeholder')).toBe(true)
  })

  it('检测作为AI 自指（非对话行）', () => {
    const text = '作为一个AI，我无法继续创作这个故事。'
    const findings = scanDegeneration(text)
    expect(findings.some((f) => f.type === 'placeholder')).toBe(true)
  })

  it('对话行的"我无法"豁免', () => {
    const text = '「对不起，我无法答应你。」她摇头。'
    const findings = scanDegeneration(text)
    // 对话行内 soft 类豁免
    const refuse = findings.filter((f) => f.message.includes('拒绝语'))
    expect(refuse).toHaveLength(0)
  })

  it('检测 Agent 技能流程旁白', () => {
    const text =
      '我会调用 story-long-write 技能做衔接校验。技能文件较长，刚才读取被截断了。'
    const findings = scanDegeneration(text)
    expect(findings.some((f) => f.type === 'placeholder' && f.message.includes('Agent'))).toBe(true)
  })
})

describe('check-degeneration: 工程词泄漏', () => {
  it('检测 tier1 纯流水线术语', () => {
    const text = '这一章的细纲要求主角觉醒。'
    const findings = scanDegeneration(text)
    const meta = findings.filter((f) => f.type === 'meta-leak' && f.severity === 'blocking')
    expect(meta.some((f) => f.excerpt.includes('细纲'))).toBe(true)
  })

  it('检测 tier2 章节词（非对话，advisory）', () => {
    const text = '上一章提到的那把剑。'
    const findings = scanDegeneration(text)
    const meta = findings.filter((f) => f.type === 'meta-leak' && f.severity === 'advisory')
    expect(meta.some((f) => f.excerpt.includes('上一章'))).toBe(true)
  })
})

describe('normalize-punctuation: 标点兜底', () => {
  it('双破折号 → 逗号', () => {
    const { text, changes } = normalizePunctuation('他笑了——然后离开。')
    expect(text).not.toContain('——')
    expect(changes.emDash).toBe(1)
  })

  it('六点省略号 → 句号', () => {
    const { text, changes } = normalizePunctuation('他沉默了……')
    expect(text).not.toContain('……')
    expect(changes.ellipsis).toBe(1)
  })

  it('三点省略号 → 句号', () => {
    const { text, changes } = normalizePunctuation('他沉默了…')
    expect(text).not.toContain('…')
    expect(changes.singleEllipsis).toBe(1)
  })

  it('双连字符 → 逗号', () => {
    const { text, changes } = normalizePunctuation('他笑了 -- 走了。')
    expect(text).not.toContain('--')
    expect(changes.doubleHyphen).toBeGreaterThanOrEqual(1)
  })

  it('正常文本不变', () => {
    const { text, changes } = normalizePunctuation('他说：「你好。」然后走了。')
    expect(text).toBe('他说：「你好。」然后走了。')
    expect(changes.emDash + changes.ellipsis + changes.doubleHyphen).toBe(0)
  })

  it('countPunctuationIssues 仅计数不改', () => {
    expect(countPunctuationIssues('他笑了——走了……')).toBeGreaterThanOrEqual(2)
    expect(countPunctuationIssues('正常句子。')).toBe(0)
  })
})
