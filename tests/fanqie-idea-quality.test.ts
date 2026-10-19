import { describe, expect, it } from 'vitest'
import { buildIdeaReviewPrompt, ideaQualityIssues, parseIdeaReviews, IDEA_REVIEW_DIMENSIONS } from '../src/main/data/fanqie-chart/idea-quality'
import { passingReviews, qualityIdea, relationshipIdea } from './helpers/fanqie-idea'

describe('榜单脑洞质量验收', () => {
  it('完整方案通过结构检查，不因共同大类误杀不同机制', () => {
    expect(ideaQualityIssues(qualityIdea(), [qualityIdea('潜水员', 1)])).toEqual([])
  })
  it.each(['genre', 'hookLine', 'goldenFinger', 'fusion', 'sellingPoint', 'protagonist', 'openingHook', 'marketReasoning', 'readerFit', 'riskNotes'] as const)('缺少 %s 不能通过', field => {
    expect(ideaQualityIssues({ ...qualityIdea(), [field]: '' }, [])).toContain(`缺少 ${field}`)
  })
  it('重复一本来源和没有机制解释的来源都不能凑足两本依据', () => {
    const idea = qualityIdea()
    expect(ideaQualityIssues({ ...idea, trendBasis: [idea.trendBasis[0], idea.trendBasis[0]] }, [])).not.toEqual([])
    idea.trendBasis[1].mechanism = ''
    expect(ideaQualityIssues(idea, [])).not.toEqual([])
  })
  it.each([
    { titleCandidates: ['甲', '甲', '乙'] }, { titleCandidates: ['甲'] }, { titleCandidates: ['甲', '乙', '丙', '丁'] },
    { titleCandidates: ['书名超过十五字这个书名真的超过十五字', '乙', '丙'] },
    { strategy: '随便' }, { hookLine: '太短' }, { hookLine: '长'.repeat(41) }
  ])('拒绝不合规书名、钩子和策略 %j', patch => {
    expect(ideaQualityIssues({ ...qualityIdea(), ...patch }, [])).not.toEqual([])
  })
  it('改名改背景也不能复用近似能力说明', () => {
    const previous = qualityIdea()
    const next = { ...qualityIdea('新店主', 1), goldenFinger: previous.goldenFinger.replace('护盾', '铠甲') }
    expect(ideaQualityIssues(next, [previous]).join()).toContain('高度相似')
  })
  it.each([undefined, {}, { reviews: [] }, { reviews: [null] }, { reviews: [{ index: 0, content: 'true', originality: true, tags: true, diversity: true }] },
    { reviews: [...JSON.parse(passingReviews(1)).reviews, ...JSON.parse(passingReviews(1)).reviews] }])('终审格式不完整或重复不能放行 %j', payload => {
    expect(parseIdeaReviews(payload, 1)[0].length).toBeGreaterThan(0)
  })
  it('任意语义维度失败都拒收，并保留具体原因', () => {
    for (const key of IDEA_REVIEW_DIMENSIONS) {
      const payload = JSON.parse(passingReviews(1))
      payload.reviews[0][key] = false
      payload.reviews[0].reasons = ['两位女性只有工作分工，没有关系推进']
      expect(parseIdeaReviews(payload, 1)[0]).toContain('两位女性只有工作分工，没有关系推进')
    }
    expect(parseIdeaReviews(JSON.parse(passingReviews(1)), 1)).toEqual([[]])
  })
  it('旧版四项全过的终审也不能绕过新增感情验收', () => {
    expect(parseIdeaReviews({ reviews: [{ index: 0, content: true, originality: true, tags: true, diversity: true }] }, 1)[0].join()).toContain('romancePacing')
  })
  it('真实模型的结构化拒收原因不能在补生成前被静默丢弃', () => {
    const payload = JSON.parse(passingReviews(1))
    payload.reviews[0].content = false
    payload.reviews[0].reasons = [{ item: 'content', reason: '无法主动发力却仍牵绳发信号', requiredModification: '提前验证不需主动发力的通信方法' }]
    const notes = parseIdeaReviews(payload, 1)[0].join('；')
    expect(notes).toContain('无法主动发力却仍牵绳发信号')
    expect(notes).toContain('提前验证不需主动发力的通信方法')
  })
  it('多女主须引用两位人物实际对应章的关系事件，不能全true空口放行', () => {
    const idea = relationshipIdea()
    const context = { ideas: [idea], focusTags: ['多女主'] }
    expect(parseIdeaReviews(JSON.parse(passingReviews(1)), 1, context)[0].length).toBeGreaterThan(0)
    const valid = JSON.parse(passingReviews(1, [idea]))
    expect(parseIdeaReviews(valid, 1, context)).toEqual([[]])
    for (const patch of [{ eventQuote: '编造了她主动向主角告白' }, { chapter: 3 }, { character: '不存在的女性' }, { character: '林月' }]) {
      const bad = structuredClone(valid)
      Object.assign(bad.reviews[0].relationshipAudit.arcs[1], patch)
      expect(parseIdeaReviews(bad, 1, context)[0].length).toBeGreaterThan(0)
    }
  })
  it('比较材料携带历史及已保留方案的具体关系节点', () => {
    const previous = relationshipIdea('保留方案')
    const prompt = buildIdeaReviewPrompt([relationshipIdea('新方案', 1)], ['多女主'], [previous])
    expect(prompt).toContain(previous.openingChapters![0].payoff)
    expect(prompt).toContain('第二章另一女性主动邀约')
    expect(prompt).toContain('不因都没有表白而误判重复')
    expect(prompt).toContain('不能只补一行往事当许可证')
  })
  it('终审覆盖指定标签、多女主关系、历史机制及跨方案结构', () => {
    const prompt = buildIdeaReviewPrompt([qualityIdea()], ['荒野求生', '多女主'], [qualityIdea('潜水员', 1)])
    for (const text of ['荒野求生', '多女主', '关系推进事件', '仅职业分工', '输入、转换规则、输出', '时间、能力、收支', '潜水员', 'diversity']) expect(prompt).toContain(text)
  })
})
