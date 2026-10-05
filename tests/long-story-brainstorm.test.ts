import { describe, expect, it } from 'vitest'
import {
  isLongStoryIdea, LONG_STORY_IDEA_FIELDS, LONG_STORY_IDEA_LIMITS, longStoryIdeaBrief, longStoryIdeaKey,
  type LongStoryBrainstormInput, type LongStoryIdea
} from '../src/shared/long-story-brainstorm'
import {
  buildLongStoryBrainstormPrompt, longStoryBrainstormInputSchema, parseLongStoryBrainstormResult, parseLongStoryIdeas
} from '../src/main/data/skill-prompts/long-story-brainstorm'

const input: LongStoryBrainstormInput = {
  genre: '都市异能', direction: '旧城修表师能够修复他人失去的时间', requirements: '自然具体，能力有代价', targetChapters: 300
}

function ideas(): LongStoryIdea[] {
  return [
    {
      title: '旧城时钟铺', premise: '修表师每次替失踪者修复时间，都会失去自己的一段记忆。他要在母亲彻底被城市遗忘前找到吞噬旧城历史的机构。',
      hook: '母亲的旧手表突然开始倒走，而所有邻居都不再记得她。', mainLine: '主角寻找母亲，与贩卖失踪者时间的机构对抗；逐渐联合同样失去家人的人，在保存公共记忆与救回母亲之间承担选择。',
      progression: '从修复街坊的个人记忆，到重建一片城区的历史，再到揭露全城时间制度；技能成长以记忆损失和盟友信任为代价，每阶段救回具体的人并揭开更大利益链。',
      twist: '旧钟缺失的刻度和母亲照片的重叠曝光早已暗示，母亲曾参与建立这套制度；她主动留下线索让主角终止时间交易。', ending: '主角用最后一段母子记忆换回城市历史，母亲获救但两人必须重新相识，机构账本公之于众。'
    },
    {
      title: '欠债的土地神', premise: '失业会计继承一座欠债神庙，神力随当地居民的承诺生效。他必须偿还神债并重新建立被宗门侵占的村落自治规则。',
      hook: '债主敲门索要百年前的雨水，而旱田里的孩子开始听见雷声。', mainLine: '主角逐村核对神债，与把愿望包装成高利契约的宗门竞争；账目清理不断引出百年旧案和乡民利益冲突。',
      progression: '从修复一村水渠获得微弱神力，到联合多村清债，再到打破整个流域的契约垄断；能力依赖居民互信，利益分配与旧约反噬持续带来新难题。',
      twist: '最早的账本总把利息记成零，暗示神债原是灾民自救的互助金；宗门篡改口供把共同承诺变成了个人债务。', ending: '主角公开原约并将神权归还乡民，失去自己的神位，留下能由普通人运行的水利与账目制度。'
    },
    {
      title: '星港弃船名单', premise: '废船拆解工能看见飞船最后一次航行的残影，在一艘被注销的战舰上发现自己出生前的名字。他决定揭穿吞并星港的失踪计划。',
      hook: '即将拆毁的舰桥发出求救讯号，声纹竟与主角完全一致。', mainLine: '主角收集失踪船只残影，聚合被抹去身份的船员，与控制航行许可证的议会对抗；真相威胁星港生计并迫使他选择公开时机。',
      progression: '从单艘废船调查，到跨港航路救援，再到修改星际身份制度；读取残影越深越损害感官，舰队扩张需要补给和信任，各阶段解决失踪案也暴露议会不同势力。',
      twist: '战舰舱门被从内部焊死、名单使用旧历，早已证明所谓海盗其实是制度制造的无籍难民；主角的名字继承自率先拒绝命令的领航员。', ending: '主角带领无籍舰队开放证据并保住民用航路，放弃恢复个人身份的特权，成为新登记制度的第一位普通船员。'
    }
  ]
}

describe('长篇脑洞提示词与边界', () => {
  it('生成长篇专用的主线、成长、多卷推进、伏笔和终局，使用大纲模型', () => {
    const previous = [{ title: '历史标题', premise: '历史设定' }]
    const prompt = buildLongStoryBrainstormPrompt({ ...input, sourceBrief: '一块停止走动的怀表', previousIdeas: previous, variationSeed: 'batch-2' })
    const conditions = JSON.parse(prompt.user.slice(prompt.user.indexOf('{')))
    expect(conditions).toMatchObject({
      题材: input.genre, 创作方向: input.direction, 文风与额外要求: input.requirements,
      目标章节数: 300, 已有简介参考: '一块停止走动的怀表', 排除已出现方案: previous, 换批标记: 'batch-2'
    })
    for (const rule of ['长篇小说', '真正不同', '长期矛盾', '成长路径', '多卷推进', '伏笔', '终局', '不要生成小说正文、整份大纲']) {
      expect(prompt.system).toContain(rule)
    }
    expect(prompt.system).not.toContain('每个方案围绕一个核心冲突')
    expect(prompt.feature).toBe('outline-generate')
    expect(prompt.maxTokens).toBe(8192)
  })

  it('允许未指定章数的自由构思，保留作者素材中的换行和引号', () => {
    const prompt = buildLongStoryBrainstormPrompt({ genre: '', direction: '他说："先看\n再写"。', requirements: '' })
    const conditions = JSON.parse(prompt.user.slice(prompt.user.indexOf('{')))
    expect(conditions.创作方向).toBe('他说："先看\n再写"。')
    expect(conditions.题材).toBe('自由选择')
    expect(conditions.目标章节数).toContain('未指定')
    expect(prompt.system).toContain('不擅自替作者锁定总章数')
  })

  it.each([
    { targetChapters: 0 }, { targetChapters: 100001 }, { targetChapters: 1.5 }, { targetChapters: '300' },
    { genre: '题'.repeat(201) }, { direction: '梗'.repeat(2001) }, { requirements: '要'.repeat(10001) },
    { sourceBrief: '设'.repeat(10001) }, { previousIdeas: Array(31).fill({ title: '标题', premise: '设定' }) },
    { previousIdeas: [{ title: '标题', premise: '设'.repeat(801) }] }, { variationSeed: 's'.repeat(101) }
  ])('拒绝越界输入 %j', overrides => {
    expect(longStoryBrainstormInputSchema.safeParse({ ...input, ...overrides }).success).toBe(false)
  })

  it('章数边界与最大来源简介匹配现有作品契约', () => {
    for (const targetChapters of [undefined, 1, 100000]) {
      expect(longStoryBrainstormInputSchema.safeParse({ ...input, targetChapters, sourceBrief: '梗'.repeat(10000) }).success).toBe(true)
    }
  })
})

describe('长篇脑洞采用与共享校验', () => {
  it('采用简介保留标题以外全部字段，即使各字段达到上限也低于 5000 字符', () => {
    const idea = Object.fromEntries(LONG_STORY_IDEA_FIELDS.map(field => [field, field === 'title' ? '不应混入简介的标题' : field.repeat(LONG_STORY_IDEA_LIMITS[field]).slice(0, LONG_STORY_IDEA_LIMITS[field])])) as unknown as LongStoryIdea
    expect(isLongStoryIdea(idea)).toBe(true)
    const brief = longStoryIdeaBrief(idea)
    expect(brief.length).toBeLessThanOrEqual(5000)
    expect(brief).not.toContain(idea.title)
    for (const field of LONG_STORY_IDEA_FIELDS.filter(field => field !== 'title')) expect(brief).toContain(idea[field])
  })

  it('共享校验拒绝缺失、空白、错误类型和超过限长字段', () => {
    const valid = ideas()[0]
    expect(isLongStoryIdea(valid)).toBe(true)
    for (const field of LONG_STORY_IDEA_FIELDS) {
      expect(isLongStoryIdea({ ...valid, [field]: '' })).toBe(false)
      expect(isLongStoryIdea({ ...valid, [field]: '  ' })).toBe(false)
      expect(isLongStoryIdea({ ...valid, [field]: 42 })).toBe(false)
      expect(isLongStoryIdea({ ...valid, [field]: '长'.repeat(LONG_STORY_IDEA_LIMITS[field] + 1) })).toBe(false)
    }
    expect(isLongStoryIdea(null)).toBe(false)
    expect(isLongStoryIdea([])).toBe(false)
  })

  it('方案键忽略标点空格，却区分长期主线和终局变更', () => {
    const idea = ideas()[0]
    expect(longStoryIdeaKey({ ...idea, title: ` ${idea.title}！ ` })).toBe(longStoryIdeaKey(idea))
    expect(longStoryIdeaKey({ ...idea, mainLine: '主角改为主动协助债主' })).not.toBe(longStoryIdeaKey(idea))
    expect(longStoryIdeaKey({ ...idea, ending: '主角终止时间交易' })).not.toBe(longStoryIdeaKey(idea))
  })
})

describe('长篇脑洞结果解析', () => {
  it('接受 JSON、代码围栏、旁白、数组和尾逗号且保留字符串标点', () => {
    const expected = ideas()
    expected[0].hook = '信中写着 "{真相},]"，文件位于 C:\\letters\\final。'
    const json = JSON.stringify({ ideas: expected })
    for (const raw of [json, `\uFEFF ${json}`, `\`\`\`json\n${json}\n\`\`\``, `结果：\n${json}\n已完成`, JSON.stringify(expected), json.replace(/}\]}/, '},],}')]) {
      expect(parseLongStoryIdeas(raw)).toEqual(expected)
    }
  })

  it('严格模式要求三个完整长篇方案，缺失成长路径或超限时失败', () => {
    const complete = ideas()
    for (const wrong of [complete.slice(0, 2), [{ ...complete[0], progression: '' }, ...complete.slice(1)], [{ ...complete[0], mainLine: '梗'.repeat(801) }, ...complete.slice(1)]]) {
      expect(() => parseLongStoryIdeas(JSON.stringify({ ideas: wrong }))).toThrow('格式不完整')
    }
    for (const field of LONG_STORY_IDEA_FIELDS) {
      const incomplete: Record<string, unknown>[] = complete.map(idea => ({ ...idea }))
      delete incomplete[0][field]
      expect(() => parseLongStoryIdeas(JSON.stringify({ ideas: incomplete }))).toThrow('格式不完整')
    }
  })

  it('过滤不完整方案以及本批、历史标题或设定的标点变体', () => {
    const complete = ideas()
    const result = parseLongStoryBrainstormResult(JSON.stringify({ ideas: [
      complete[0], { ...complete[1], progression: '' }, complete[2], { ...complete[2], title: ` ${complete[2].title}！ ` }
    ] }), { allowPartial: true, previousIdeas: [{ title: '另一标题', premise: ` ${complete[0].premise}！ ` }] })
    expect(result.ideas).toEqual([complete[2]])
    expect(result.warning).toContain('保留 1 个')
    expect(result.warning).toContain('过滤 1 个不完整方案')
    expect(result.warning).toContain('过滤 2 个本批或历史重复方案')
    expect(() => parseLongStoryIdeas(JSON.stringify({ ideas: complete }), { allowPartial: true, previousIdeas: complete })).toThrow('重复')
  })

  it('换批不能通过全角、大小写或空格变换重复历史标题', () => {
    const complete = ideas()
    complete[0].title = 'ARC 1'
    const result = parseLongStoryBrainstormResult(JSON.stringify({ ideas: complete }), {
      allowPartial: true, previousIdeas: [{ title: 'ＡＲＣ　１！', premise: '另一份历史设定' }]
    })
    expect(result.ideas).toEqual(complete.slice(1))
    expect(result.warning).toContain('过滤 1 个本批或历史重复方案')
  })

  it('历史设定的少量文字变体会过滤，共享世界背景却改变目标与冲突的方案仍保留', () => {
    const complete = ideas()
    const background = '旧城的工匠各有手艺，街坊靠互助维持生计，城市更新令他们面临新的选择。'.repeat(5)
    const original = background + '修表师要救回母亲，靠修复记忆阻止时间交易；被救者的记忆构成他的证据与盟友。'
    complete[0].premise = original.replace('母亲', '家人')
    complete[1].premise = background + '失业会计要争取居民的水利自治权，靠核算旧债建立村落互助；宗门垄断是长期阻力。'
    const result = parseLongStoryBrainstormResult(JSON.stringify({ ideas: complete }), {
      allowPartial: true, previousIdeas: [{ title: '历史旧标题', premise: original }]
    })
    expect(result.ideas).toEqual(complete.slice(1))
    expect(result.warning).toContain('过滤 1 个本批或历史重复方案')
  })

  it('截断第三项恢复同一批的完整方案并告知，不跨多个片段拼凑', () => {
    const complete = ideas()
    const first = `{"ideas":[${JSON.stringify(complete[0])},\n`
    const later = `正式：{"ideas":[${JSON.stringify(complete[1])},${JSON.stringify(complete[2])},{"title":"截断`
    const result = parseLongStoryBrainstormResult(first + later, { allowPartial: true })
    expect(result.ideas).toEqual(complete.slice(1))
    expect(result.warning).toContain('输出被截断')
    expect(() => parseLongStoryIdeas(first + later)).toThrow()
  })

  it('完整正式结果优先于损坏示例，外层未闭合只在部分模式恢复', () => {
    const complete = ideas()
    const json = JSON.stringify({ ideas: complete })
    expect(parseLongStoryIdeas(`坏示例：{"ideas":[\n正式结果：${json}`)).toEqual(complete)
    const truncated = json.slice(0, -1)
    expect(() => parseLongStoryIdeas(truncated)).toThrow()
    expect(parseLongStoryBrainstormResult(truncated, { allowPartial: true })).toEqual({ ideas: complete, warning: expect.stringContaining('输出被截断') })
  })

  it('拒绝空结果、过长返回和可执行代码，不受深嵌套输入拖慢', () => {
    for (const raw of ['', '这是脑洞但没有 JSON', '{"ideas":[]}', '({ ideas: [] })']) expect(() => parseLongStoryIdeas(raw)).toThrow()
    expect(() => parseLongStoryIdeas('x'.repeat(100001))).toThrow('过长')
    expect(() => parseLongStoryIdeas('globalThis.longBrainstormSideEffect = true; ({ ideas: [] })')).toThrow('JSON')
    expect('longBrainstormSideEffect' in globalThis).toBe(false)
    expect(() => parseLongStoryIdeas('['.repeat(50000) + ']'.repeat(50000), { allowPartial: true })).toThrow('JSON')
  }, 2000)
})
