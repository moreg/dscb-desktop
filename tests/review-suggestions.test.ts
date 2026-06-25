import { describe, it, expect } from 'vitest'
import {
  parseSuggestions,
  isRewritable,
  applyCandidate,
  buildReviewKey,
  isReviewKey,
  parseReviewIndex,
  computeSuggestionPositions,
  type ReviewSuggestion
} from '../src/shared/review-suggestions'

describe('parseSuggestions', () => {
  it('解析原文/改写/理由三字段', () => {
    const text = [
      '原文：天色灰绿。',
      '改写：天色是一种说不清的灰绿。',
      '理由：原句多了一个不字。'
    ].join('\n')
    const out = parseSuggestions(text)
    expect(out).toHaveLength(1)
    expect(out[0].quote).toBe('天色灰绿。')
    expect(out[0].rewrite).toBe('天色是一种说不清的灰绿。')
    expect(out[0].why).toBe('原句多了一个不字。')
    expect(out[0].advice).toBe('')
  })

  it('按空行分多块', () => {
    const text = [
      '原文：甲。\n改写：乙。\n理由：丙。',
      '',
      '原文：丁。\n改写：戊。\n理由：己。'
    ].join('\n')
    const out = parseSuggestions(text)
    expect(out).toHaveLength(2)
    expect(out[1].quote).toBe('丁。')
    expect(out[1].rewrite).toBe('戊。')
  })

  it('向后兼容：旧格式只有「建议」时填入 advice，rewrite 为空', () => {
    const text = '原文：甲。\n建议：乙。\n理由：丙。'
    const out = parseSuggestions(text)
    expect(out).toHaveLength(1)
    expect(out[0].advice).toBe('乙。')
    expect(out[0].rewrite).toBeUndefined()
  })

  it('完全无标签的段落（前言/总结）不再被当成可应用建议', () => {
    const text = '这是开头寒暄，不应当成建议。\n\n原文：甲。\n改写：乙。\n理由：丙。'
    const out = parseSuggestions(text)
    expect(out).toHaveLength(2)
    expect(out[0].quote).toBe('')
    expect(out[0].rewrite).toBeUndefined()
    expect(out[0].advice).toBe('')
    expect(out[0].why).toBe('这是开头寒暄，不应当成建议。')
  })

  it('流式中间态：未闭合的块仍能解析已出现的字段', () => {
    // 改写行刚生成一半、理由尚未出现
    const text = '原文：甲。\n改写：乙'
    const out = parseSuggestions(text)
    expect(out).toHaveLength(1)
    expect(out[0].quote).toBe('甲。')
    expect(out[0].rewrite).toBe('乙')
  })

  it('两条建议之间没有空行也不会合并成一条（修复字段串行 bug）', () => {
    // LLM 经常省略建议之间的空行：原文1/改写1/理由1 紧接 原文2/改写2/理由2
    const text = [
      '原文：天色灰绿。',
      '改写：天色是一种说不清的灰绿。',
      '理由：原句多了一个不字。',
      '原文：风停了。',
      '改写：风忽然就停了。',
      '理由：原句太干。'
    ].join('\n')
    const out = parseSuggestions(text)
    expect(out).toHaveLength(2)
    expect(out[0].quote).toBe('天色灰绿。')
    expect(out[0].rewrite).toBe('天色是一种说不清的灰绿。')
    expect(out[0].why).toBe('原句多了一个不字。')
    expect(out[1].quote).toBe('风停了。')
    expect(out[1].rewrite).toBe('风忽然就停了。')
    expect(out[1].why).toBe('原句太干。')
  })

  it('去掉 LLM 多包的一层引号，避免面板出现重复书名号', () => {
    const text = '原文：「天色灰绿。」\n改写：天色是一种说不清的灰绿。'
    const out = parseSuggestions(text)
    expect(out[0].quote).toBe('天色灰绿。')
  })

  it('括号不是整体包裹时保持原样，不破坏正文（修复过度剥离）', () => {
    // 「（补一句）（结尾）」首尾是（）但内部还有一个），属于两个独立括号，不能剥
    const text = '原文：甲。\n改写：（补一句）（结尾）。'
    const out = parseSuggestions(text)
    expect(out[0].rewrite).toBe('（补一句）（结尾）。')
  })

  it('尾部不是闭括号时不误剥', () => {
    const text = '原文：（天气很好）。\n改写：天气很好。'
    const out = parseSuggestions(text)
    expect(out[0].quote).toBe('（天气很好）。')
  })
})

describe('isRewritable', () => {
  it('成品写法通过', () => {
    expect(isRewritable('天色渐暗。', '天色灰绿。').ok).toBe(true)
  })

  it('candidate 为空时不通过', () => {
    expect(isRewritable(undefined, '甲.').ok).toBe(false)
    expect(isRewritable('', '甲.').ok).toBe(false)
    expect(isRewritable('   ', '甲.').ok).toBe(false)
  })

  it('quote 为空时不通过', () => {
    expect(isRewritable('乙。', '').ok).toBe(false)
  })

  it('"把/拆到/放在"等元语言开头被拦截', () => {
    expect(isRewritable('把老周的介绍拆到下一句', '老周笑了。').ok).toBe(false)
    expect(isRewritable('改为更自然的表达', '甲。').ok).toBe(false)
    expect(isRewritable('应该在开头加点描写', '甲。').ok).toBe(false)
  })

  it('含元语言句式被拦截（截图真实 case）', () => {
    const candidate = '把"老周"和"棒球帽"的介绍拆到下一句，放在"话音没落"之前独立成句，让对话只保留台词'
    expect(isRewritable(candidate, '老周戴着棒球帽笑了。').ok).toBe(false)
  })

  it('拦下时给出可读 reason', () => {
    const r = isRewritable('把甲改成乙', '甲。')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('只拦开头：对白/叙述中合法出现的元词不误伤', () => {
    expect(isRewritable('你不要走。', '甲。').ok).toBe(true)
    expect(isRewritable('此处有人。', '甲。').ok).toBe(true)
    expect(isRewritable('这一段路很长。', '甲。').ok).toBe(true)
    expect(isRewritable('他避免了眼神接触。', '甲。').ok).toBe(true)
  })
})

describe('applyCandidate', () => {
  it('优先返回 rewrite', () => {
    expect(applyCandidate({ quote: '甲.', rewrite: '乙.', advice: '丙.', why: '' })).toBe('乙.')
  })

  it('rewrite 缺失时回退 advice', () => {
    expect(applyCandidate({ quote: '甲.', rewrite: undefined, advice: '丙.', why: '' })).toBe('丙.')
  })

  it('两者都缺失时返回空候选', () => {
    expect(applyCandidate({ quote: '', rewrite: undefined, advice: '', why: '前言' })).toBeFalsy()
  })
})

describe('review key helpers', () => {
  it('buildReviewKey 构造前缀+index+pos 字符串', () => {
    expect(buildReviewKey(0, 42)).toBe('ai-review-0-42')
    expect(buildReviewKey(7, 0)).toBe('ai-review-7-0')
  })

  it('isReviewKey 识别 AI 改稿来源', () => {
    expect(isReviewKey('ai-review-0-42')).toBe(true)
    expect(isReviewKey('ai-review-12-1000')).toBe(true)
    expect(isReviewKey('forbidden_word:轰:123')).toBe(false)
    expect(isReviewKey('ai-something-else')).toBe(false)
  })

  it('parseReviewIndex 提取建议序号；非 AI 改稿返回 null', () => {
    expect(parseReviewIndex('ai-review-0-42')).toBe(0)
    expect(parseReviewIndex('ai-review-13-9999')).toBe(13)
    expect(parseReviewIndex('forbidden_word:轰:123')).toBeNull()
    expect(parseReviewIndex('ai-review-x-1')).toBeNull()
    expect(parseReviewIndex('ai-review-1')).toBeNull() // 缺 -pos 部分
  })

  it('buildReviewKey 与 parseReviewIndex 互为逆操作', () => {
    for (const [i, p] of [[0, 0], [3, 27], [99, 12345]]) {
      expect(parseReviewIndex(buildReviewKey(i, p))).toBe(i)
    }
  })
})

describe('computeSuggestionPositions', () => {
  const mk = (quote: string): ReviewSuggestion => ({ quote, advice: '', why: '' })

  it('单 quote 单匹配：返回首处位置', () => {
    const draft = '前文。他笑了。后文。'
    const positions = computeSuggestionPositions([mk('他笑了。')], draft)
    expect(positions).toEqual([draft.indexOf('他笑了。')])
  })

  it('同 quote 多条建议：依次匹配 draft 中的下一处而非都指向首处', () => {
    const draft = '他笑了。中间。他笑了。结尾。他笑了。'
    const suggestions = [mk('他笑了。'), mk('他笑了。'), mk('他笑了。')]
    const positions = computeSuggestionPositions(suggestions, draft)
    expect(positions[0]).toBe(draft.indexOf('他笑了。'))
    expect(positions[1]).toBe(draft.indexOf('他笑了。', positions[0] + 1))
    expect(positions[2]).toBe(draft.indexOf('他笑了。', positions[1] + 1))
    expect(positions[0]).not.toBe(positions[1])
    expect(positions[1]).not.toBe(positions[2])
  })

  it('已应用建议返回 -1 且不消费 draft 中的匹配位置', () => {
    // 模拟应用 index=0 后场景：draft 第一处 quote 被替换，
    // applied 集合中包含 0；index=1 应匹配剩余的首处（原第 2 处）。
    const draft = '改写后。中间。他笑了。结尾。他笑了。'
    const suggestions = [mk('他笑了。'), mk('他笑了。'), mk('他笑了。')]
    const applied = new Set([0])
    const positions = computeSuggestionPositions(suggestions, draft, applied)
    expect(positions[0]).toBe(-1)
    expect(positions[1]).toBe(draft.indexOf('他笑了。'))
    expect(positions[2]).toBe(draft.indexOf('他笑了。', positions[1] + 1))
  })

  it('quote 为空（前言/总结段）返回 -1，不污染同位置游标', () => {
    const draft = '他笑了。结尾。'
    const suggestions = [mk(''), mk('他笑了。')]
    const positions = computeSuggestionPositions(suggestions, draft)
    expect(positions).toEqual([-1, draft.indexOf('他笑了。')])
  })

  it('draft 匹配数不够时多余建议返回 -1', () => {
    const draft = '只出现一次。'
    const suggestions = [mk('只出现一次。'), mk('只出现一次。')]
    const positions = computeSuggestionPositions(suggestions, draft)
    expect(positions[0]).toBe(0)
    expect(positions[1]).toBe(-1)
  })

  it('不同 quote 互不干扰游标', () => {
    const draft = 'AAA BBB AAA BBB'
    const positions = computeSuggestionPositions([mk('AAA'), mk('BBB'), mk('AAA')], draft)
    expect(positions[0]).toBe(0)
    expect(positions[1]).toBe(4)
    expect(positions[2]).toBe(8)
  })

  it('重叠模式：游标按 pos+1 推进，不跳过有效匹配', () => {
    const draft = 'aaa'
    const positions = computeSuggestionPositions([mk('aa'), mk('aa')], draft)
    expect(positions[0]).toBe(0)
    expect(positions[1]).toBe(1)
  })
})
