import { describe, expect, it } from 'vitest'
import type { ShortStoryBrainstormInput, ShortStoryIdea } from '../src/shared/short-story'
import {
  buildShortStoryBrainstormPrompt,
  mergeShortStoryIdeaRewrite,
  parseShortStoryBrainstormResult,
  parseShortStoryIdeas,
  shortStoryBrainstormInputSchema
} from '../src/main/data/skill-prompts/short-story-brainstorm'

const input: ShortStoryBrainstormInput = {
  genre: '悬疑', direction: '普通人在一封遗书面前做出选择', requirements: '第一人称，温暖但不煽情', targetWords: 8000
}

function ideas(): ShortStoryIdea[] {
  return [
    { title: '最后一封信', premise: '邮递员把遗书送到仍活着的收件人手里，必须找到寄信的人。', hook: '收件人声称信中的死者正坐在屋里。', twist: '信里褪色的邮戳早已暗示它在邮局滞留了十年。', ending: '邮递员找到被错判死亡的寄件人，双方见面并补全失散的十年。' },
    { title: '听见你的房间', premise: '失聪的钢琴师收到邻居的噪音投诉，要决定是否放弃自己的第一次演出。', hook: '投诉信准确写出了一段从未奏响过的旋律。', twist: '信纸上的折痕和邻居的手势证明对方在用旧友的方式鼓励他。', ending: '钢琴师用振动完成演出，与邻居交换正式邀请，重新面对音乐。' },
    { title: '雨天的借条', premise: '店主给一名老人免单后，被一张借条要求归还陌生人的一辈子。', hook: '借条签着店主自己的名字，日期却早了三十年。', twist: '老人一直替店主保管母亲留下的店铺，借条背面有年年缴税的痕迹。', ending: '店主认出母亲的安排，接手店铺并为老人留下一张终生免单的餐卡。' }
  ]
}

describe('短篇脑洞提示词', () => {
  it('无需作品或标题，带入题材、预算、文风与换批条件', () => {
    const prompt = buildShortStoryBrainstormPrompt({
      ...input, sourceBrief: '继承的店铺里有一张没写完的借条',
      excludedIdeas: ['上一批：母亲留下的邮筒'], variationSeed: 'batch-2'
    })
    for (const value of [input.genre, input.direction, input.requirements, '8000', '继承的店铺里有一张没写完的借条', '母亲留下的邮筒', 'batch-2']) {
      expect(prompt.user).toContain(value)
    }
    expect(prompt.system).toContain('真正不同')
    expect(prompt.system).toContain('反转必须公平')
    expect(prompt.system).toContain('主冲突留到下一部')
    expect(prompt.system).toContain('不要生成小说正文、完整大纲')
    expect(prompt.feature).toBe('outline-generate')
    expect(prompt.maxTokens).toBe(8192)
  })

  it('可在没有方向时自由构思，保留作者素材中的转义字符', () => {
    const prompt = buildShortStoryBrainstormPrompt({ ...input, genre: '', direction: '他说："先看\n再写"。', requirements: '' })
    const conditions = JSON.parse(prompt.user.slice(prompt.user.indexOf('{')))
    expect(conditions.创作方向).toBe('他说："先看\n再写"。')
    expect(conditions.题材).toBe('自由选择')
    expect(() => buildShortStoryBrainstormPrompt({ genre: '', direction: '', requirements: '', targetWords: 1000 })).not.toThrow()
  })

  it.each([
    { targetWords: 999 }, { targetWords: 120001 }, { targetWords: 1000.5 },
    { genre: '题'.repeat(201) }, { direction: '梗'.repeat(2001) },
    { requirements: '要'.repeat(10001) }, { sourceBrief: '设'.repeat(10001) },
    { excludedIdeas: Array.from({ length: 31 }, () => '已生成') },
    { excludedIdeas: ['梗'.repeat(1501)] }, { variationSeed: 's'.repeat(101) }
  ])('拒绝越界条件 %j', overrides => {
    expect(shortStoryBrainstormInputSchema.safeParse({ ...input, ...overrides }).success).toBe(false)
  })

  it('接受允许的字数边界和排除列表边界', () => {
    for (const targetWords of [1000, 120000]) {
      expect(shortStoryBrainstormInputSchema.safeParse({
        ...input, targetWords, excludedIdeas: Array.from({ length: 30 }, () => '梗'.repeat(1500)), variationSeed: 's'.repeat(100)
      }).success).toBe(true)
    }
  })

  it('完整历史只供程序校验，不重复注入提示上下文', () => {
    const prompt = buildShortStoryBrainstormPrompt({ ...input, previousIdeas: [{ title: '程序历史标题', premise: '程序完整历史设定'.repeat(100) }] })
    expect(prompt.user).not.toContain('程序历史标题')
    expect(prompt.user).not.toContain('程序完整历史设定')
  })

  it('单方案改写明确字段锁和预设要求', () => {
    const original = ideas()[0]
    for (const focus of ['twist', 'ending', 'emotion', 'custom'] as const) {
      const prompt = buildShortStoryBrainstormPrompt({ ...input, rewrite: { idea: original, focus, instruction: focus === 'custom' ? '用一件雨衣建立悬念' : '' } })
      expect(prompt.system).toContain('输出 1 个完整方案')
      expect(prompt.system).toContain('逐字保留')
      expect(prompt.user).toContain(original.premise)
      expect(prompt.system).not.toContain('只生成 3 个真正不同的方案')
    }
  })

  it('自定义改写要求非空，完整历史和改写数据有长度上限', () => {
    for (const overrides of [
      { rewrite: { idea: ideas()[0], focus: 'custom', instruction: '   ' } },
      { rewrite: { idea: ideas()[0], focus: 'twist', instruction: '改'.repeat(2001) } },
      { rewrite: { idea: { ...ideas()[0], ending: '' }, focus: 'ending', instruction: '' } },
      { previousIdeas: Array.from({ length: 31 }, () => ({ title: '标题', premise: '设定' })) },
      { previousIdeas: [{ title: '标题', premise: '设'.repeat(3001) }] }
    ]) expect(shortStoryBrainstormInputSchema.safeParse({ ...input, ...overrides }).success).toBe(false)
  })
})

describe('短篇脑洞结果解析', () => {
  it('支持纯 JSON、代码围栏、少量旁白与非结果对象', () => {
    const expected = ideas()
    const json = JSON.stringify({ ideas: expected })
    for (const raw of [json, `\uFEFF ${json}`, `\`\`\`json\n${json}\n\`\`\``, `下面是结果。\n${json}\n已完成。`, `{"备注":"不会作为结果"}\n${json}`]) {
      expect(parseShortStoryIdeas(raw)).toEqual(expected)
    }
  })

  it('字符串里的大括号、引号和反斜线不会截断 JSON', () => {
    const expected = ideas()
    expected[0].hook = '信中写着 "{真相}"，文件名是 C:\\letter\\final。'
    expect(parseShortStoryIdeas(JSON.stringify({ ideas: expected }))).toEqual(expected)
  })

  it.each(['', '模型解释但没有方案', '{"ideas": [', '({ ideas: [] })', '{"ideas":[]}'])('拒绝空白、损坏或非 JSON 结果 %j', raw => {
    expect(() => parseShortStoryIdeas(raw)).toThrow()
  })

  it('严格要求三个完整方案，并校验字段类型和长度', () => {
    const complete = ideas()
    for (const wrong of [complete.slice(0, 2), [...complete, complete[0]], [{ ...complete[0], ending: '  ' }, ...complete.slice(1)], [{ ...complete[0], title: 42 }, ...complete.slice(1)], [{ ...complete[0], premise: '梗'.repeat(3001) }, ...complete.slice(1)]]) {
      expect(() => parseShortStoryIdeas(JSON.stringify({ ideas: wrong }))).toThrow('格式不完整')
    }
    for (const field of ['title', 'premise', 'hook', 'twist', 'ending']) {
      const incomplete: Record<string, unknown>[] = complete.map(idea => ({ ...idea }))
      delete incomplete[0][field]
      expect(() => parseShortStoryIdeas(JSON.stringify({ ideas: incomplete }))).toThrow('格式不完整')
    }
  })

  it('拒绝重复标题或设定，包括空格和标点产生的伪变体', () => {
    for (const field of ['title', 'premise'] as const) {
      const duplicated = ideas()
      duplicated[1][field] = ` ${duplicated[0][field]}！ `
      expect(() => parseShortStoryIdeas(JSON.stringify({ ideas: duplicated }))).toThrow('重复')
    }
  })

  it('不接受超大返回值，也不会执行代码形式的结果', () => {
    expect(() => parseShortStoryIdeas('x'.repeat(100001))).toThrow('过长')
    expect(() => parseShortStoryIdeas('globalThis.brainstormSideEffect = true; ({ ideas: [] })')).toThrow('JSON')
    expect('brainstormSideEffect' in globalThis).toBe(false)
    expect(() => parseShortStoryIdeas('{'.repeat(100000))).toThrow('JSON')
  })

  it('继续扫描格式示例，完整的正式结果优先于前面的部分结果', () => {
    const complete = ideas()
    const partial = complete.slice(0, 2)
    const raw = `示例：{"ideas":[]}\n预览：${JSON.stringify({ ideas: partial })}\n正式结果：${JSON.stringify({ ideas: complete })}`
    expect(parseShortStoryIdeas(raw)).toEqual(complete)
    expect(parseShortStoryBrainstormResult(raw, { allowPartial: true })).toEqual({ ideas: complete })
  })

  it('未闭合的坏示例前缀不会吞掉后面的完整正式批次', () => {
    const complete = ideas()
    const raw = `坏示例：{"ideas":[\n正式结果：${JSON.stringify({ ideas: complete })}`
    expect(parseShortStoryIdeas(raw)).toEqual(complete)
    expect(parseShortStoryBrainstormResult(raw, { allowPartial: true })).toEqual({ ideas: complete })
  })

  it('第三项截断时部分模式恢复同一批次的前两项，严格模式仍失败', () => {
    const complete = ideas()
    complete[0].hook = '提示为 "{真相},]"，文件位于 C:\\letters\\final，不能改动。'
    const raw = `{"ideas":[${JSON.stringify(complete[0])},${JSON.stringify(complete[1])},{"title":"第三项只返回了一半`
    const result = parseShortStoryBrainstormResult(raw, { allowPartial: true })
    expect(result.ideas).toEqual(complete.slice(0, 2))
    expect(result.warning).toContain('输出被截断')
    expect(() => parseShortStoryIdeas(raw)).toThrow()
  })

  it('截断恢复不跨坏示例拼批次，且完整业务结果优先', () => {
    const complete = ideas()
    const first = `{"ideas":[${JSON.stringify(complete[0])},\n`
    const later = `正式：{"ideas":[${JSON.stringify(complete[1])},${JSON.stringify(complete[2])},{"title":"未完`
    expect(parseShortStoryIdeas(first + later, { allowPartial: true })).toEqual(complete.slice(1))
    expect(() => parseShortStoryIdeas(first + later)).toThrow()
    const finished = JSON.stringify({ ideas: [complete[2]] })
    expect(parseShortStoryIdeas(first + finished, { allowPartial: true })).toEqual([complete[2]])
  })

  it('仅缺外层右括号也不冒充严格完整批次，部分恢复带明确提示', () => {
    const complete = ideas()
    const raw = JSON.stringify({ ideas: complete }).slice(0, -1)
    expect(() => parseShortStoryIdeas(raw)).toThrow()
    expect(parseShortStoryBrainstormResult(raw, { allowPartial: true })).toEqual({
      ideas: complete, warning: expect.stringContaining('输出被截断')
    })
  })

  it('100000 字符深嵌套不会按每层重复切片和解析', () => {
    const nested = '['.repeat(50000) + ']'.repeat(50000)
    expect(nested.length).toBe(100000)
    expect(() => parseShortStoryIdeas(nested, { allowPartial: true })).toThrow('JSON')
    const unmatched = '{'.repeat(100000)
    expect(() => parseShortStoryIdeas(unmatched, { allowPartial: true })).toThrow('JSON')
  }, 2000)

  it('兼容数组、单对象和尾逗号，但不改变字符串中的标点', () => {
    const complete = ideas()
    complete[0].hook = '提示里出现了 ",}" 与 ",]"，它们属于原始文本。'
    expect(parseShortStoryIdeas(JSON.stringify(complete))).toEqual(complete)
    const trailing = JSON.stringify({ ideas: complete }).replace(/}\]}/, '},],}')
    expect(parseShortStoryIdeas(trailing)).toEqual(complete)
    expect(parseShortStoryIdeas(JSON.stringify(complete[0]), { expectedCount: 1 })).toEqual([complete[0]])
    expect(parseShortStoryIdeas(JSON.stringify({ idea: complete[0] }), { expectedCount: 1 })).toEqual([complete[0]])
  })

  it('部分模式逐项保留完整方案，过滤不完整和当批重复项并告知原因', () => {
    const complete = ideas()
    const result = parseShortStoryBrainstormResult(JSON.stringify({ ideas: [complete[0], { ...complete[1], ending: '' }, complete[2], complete[0]] }), { allowPartial: true })
    expect(result.ideas).toEqual([complete[0], complete[2]])
    expect(result.warning).toContain('过滤 1 个不完整方案')
    expect(result.warning).toContain('过滤 1 个本批或历史重复方案')
    expect(() => parseShortStoryIdeas(JSON.stringify({ ideas: [complete[0], { ...complete[1], ending: '' }, complete[2]] }))).toThrow('格式不完整')
  })

  it('跨批比较完整标题和设定，仅剩有效方案时给 warning', () => {
    const complete = ideas()
    const previous = [{ title: '另一个标题', premise: complete[0].premise }, { title: complete[1].title, premise: '另一段设定' }]
    const result = parseShortStoryBrainstormResult(JSON.stringify({ ideas: complete }), { allowPartial: true, previousIdeas: previous })
    expect(result.ideas).toEqual([complete[2]])
    expect(result.warning).toContain('过滤 2 个本批或历史重复方案')
    expect(() => parseShortStoryIdeas(JSON.stringify({ ideas: complete }), { allowPartial: true, previousIdeas: complete })).toThrow('重复')
  })

  it('多对象不混合示例和正式方案，数量相同采用后面的正式结果', () => {
    const earlier = ideas().slice(0, 2)
    const later = ideas().slice(1)
    expect(parseShortStoryIdeas(`${JSON.stringify(earlier)}\n${JSON.stringify(later)}`, { allowPartial: true })).toEqual(later)
  })
})

describe('短篇单脑洞改写合并', () => {
  it.each([
    { focus: 'twist' as const, changed: ['twist'] },
    { focus: 'ending' as const, changed: ['ending'] },
    { focus: 'emotion' as const, changed: ['twist', 'ending'] },
    { focus: 'custom' as const, changed: ['hook', 'twist', 'ending'] }
  ])('只允许修改 $focus 指定的字段', ({ focus, changed }) => {
    const original = ideas()[0]
    const rewritten = Object.fromEntries(Object.entries(original).map(([field, value]) => [field, `改写：${value}`])) as unknown as ShortStoryIdea
    const result = mergeShortStoryIdeaRewrite({ idea: original, focus, instruction: '加强冲击' }, rewritten)
    for (const field of ['title', 'premise', 'hook', 'twist', 'ending'] as const) {
      expect(result[field]).toBe(changed.includes(field) ? rewritten[field] : original[field])
    }
  })

  it('只改锁定字段或完全没改不冒充成功', () => {
    const original = ideas()[0]
    expect(() => mergeShortStoryIdeaRewrite({ idea: original, focus: 'twist', instruction: '' }, { ...original, ending: '模型只改了不允许修改的结局' })).toThrow('没有改变')
    expect(() => mergeShortStoryIdeaRewrite({ idea: original, focus: 'ending', instruction: '' }, original)).toThrow('没有改变')
  })
})
