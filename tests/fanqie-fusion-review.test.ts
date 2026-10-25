import { describe, expect, it } from 'vitest'
import { buildFusionReviewPrompt, chartSourceUsageLimit, sourceReuseIssues, validateFusionReview } from '../src/main/data/fanqie-chart/fusion-review'
import { CHART_IDEAS_PROMPT_VERSION } from '../src/main/data/fanqie-chart/fusion-rules'
import { buildIdeasPrompt } from '../src/main/data/fanqie-chart/prompts'
import { ideaQualityIssues } from '../src/main/data/fanqie-chart/idea-quality'
import { passingFusionReview, qualityIdea } from './helpers/fanqie-idea'

type Payload = { reviews: ReturnType<typeof validateFusionReview>; opening_comparisons: Array<{
  left_index: number; right_index: number; same_conflict: boolean; left_quote: string; right_quote: string; reason: string
}>; chapter_comparisons: Array<{ left_index: number; right_index: number; same_progression: boolean; reason: string;
  left_chain: Array<{ chapter: number; quote: string; change: string }>; right_chain: Array<{ chapter: number; quote: string; change: string }> }> }
function fixture(count = 1) {
  const ideas = Array.from({ length: count }, (_, i) => qualityIdea(`方案${i}`, i))
  const prompt = buildFusionReviewPrompt(ideas)
  return { ideas, payload: JSON.parse(passingFusionReview(prompt)) as Payload }
}

describe('v17 融梗复核闸门', () => {
  it('完整的逐来源、逐阶段与整批对比协议才能通过', () => {
    const { ideas, payload } = fixture(3)
    expect(validateFusionReview(payload, ideas)).toHaveLength(3)
    expect(payload.opening_comparisons).toHaveLength(3)
    expect(payload.chapter_comparisons).toHaveLength(3)
  })

  const mutations: Array<[string, (payload: Payload) => void]> = [
    ['漏来源', p => { p.reviews[0].source_checks.pop() }],
    ['只留旧药瓶删药效', p => { p.reviews[0].source_checks[0].deletion_audit.retained_effects_preserved = false }],
    ['未审旧资源效力', p => { p.reviews[0].source_checks[0].deletion_audit.existing_effects = '' }],
    ['来源被新增能力覆盖仍通过', p => { p.reviews[0].source_checks[0].independence_audit.status = 'covered' }],
    ['来源独立增量不明仍通过', p => { p.reviews[0].source_checks[0].independence_audit.status = 'unproven' }],
    ['来源增量使用伪造证据', p => { p.reviews[0].source_checks[0].independence_audit.quote = '禁止正常劳动购物' }],
    ['漏第二章行动检查', p => { p.reviews[0].chapter_action_checks.splice(1, 1) }],
    ['重复章号冒充完整检查', p => { p.reviews[0].chapter_action_checks[1].chapter = 1 }],
    ['三阶段通过掩盖第二章缺环', p => { p.reviews[0].chapter_action_checks[1].loop_closed = false }],
    ['章节行动伪造引文', p => { p.reviews[0].chapter_action_checks[1].quote = '次日到期后再会面仍能按时交货' }],
    ['终局偷换目标', p => { p.reviews[0].resolution_check.required_output = '只确认大家还清醒，不解决原危机' }],
    ['只核验不解决仍通过', p => { p.reviews[0].resolution_check.goal_achieved = false }],
    ['终局操作没有证据', p => { p.reviews[0].resolution_check.quote = '' }],
    ['重复来源', p => { p.reviews[0].source_checks[1].book_id = 'a' }],
    ['伪造引文', p => { p.reviews[0].source_checks[0].quote = '原文里没有的屏蔽沟通禁令' }],
    ['字符串布尔值', p => { Object.assign(p.reviews[0], { passed: 'true' }) }],
    ['缺少目标边界', p => { p.reviews[0].stage_goals[0].boundary_valid = false }],
    ['目标偷换', p => { p.reviews[0].source_checks[0].stage_checks[0].required_output = '必须拿到某一袋指定古代种子而非完成实际目标' }],
    ['把态度当贡献', p => { p.reviews[0].source_checks[0].contribution_type = 'attitude_only' }],
    ['删掉所有既得手段', p => { p.reviews[0].source_checks[0].retained_means = [] }],
    ['未明确删除范围', p => { p.reviews[0].source_checks[0].removed_part = '' }],
    ['跨界闭环缺失仍通过', p => { p.reviews[0].action_checks[0].loop_closed = false }],
    ['漏一个阶段行动链', p => { p.reviews[0].action_checks.pop() }],
    ['伪造跨界传讯', p => { p.reviews[0].action_checks[0].quote = '手机自动跨时传回水位' }],
    ['检测边界不清仍判必需', p => { p.reviews[0].source_checks[0].deletion_audit.dependency_boundary = 'ambiguous' }],
    ['漏检测输入依赖', p => { p.reviews[0].source_checks[0].deletion_audit.input_dependency = '' }],
    ['新批次没有实际新需求', p => { p.reviews[0].stage_goals[2].need_established = false }],
    ['未测试旧库存', p => { p.reviews[0].stage_goals[2].old_stock_test = '' }],
    ['漏前三章方案对', p => { p.chapter_comparisons.pop() }],
    ['重复前三章方案对', p => { p.chapter_comparisons[1] = { ...p.chapter_comparisons[0] } }],
    ['推进链缺第三章', p => { p.chapter_comparisons[0].left_chain.pop() }],
    ['推进链重复章节', p => { p.chapter_comparisons[0].left_chain[2].chapter = 1 }],
    ['推进链假引文', p => { p.chapter_comparisons[0].left_chain[1].quote = '不曾写过的拒绝过量劳动' }],
    ['推进重复仍通过', p => { p.chapter_comparisons[0].same_progression = true }],
    ['只删限制保留核心操作', p => { p.reviews[0].source_checks[0].deletion_audit.core_operation_removed = false }],
    ['删除新增或既得能力', p => { p.reviews[0].source_checks[0].deletion_audit.retained_means_preserved = false }],
    ['取消新增能力触发条件', p => { p.reviews[0].source_checks[0].deletion_audit.activation_conditions_preserved = false }],
    ['删除核查伪造引文', p => { p.reviews[0].source_checks[0].deletion_audit.quote = '原文不存在的兽形规则' }],
    ['未检查购种自繁与实际目标', p => { p.reviews[0].stage_goals[0].material_substitution_test = '' }],
    ['设备场域不明仍判必需', p => { p.reviews[0].source_checks[0].stage_checks[1].execution_audit.evidence_sufficient = false }],
    ['设备场域伪造引文', p => { p.reviews[0].source_checks[0].stage_checks[1].execution_audit.quote = '古代录音设备必然失效' }],
    ['组合可行仍判必需', p => { Object.assign(p.reviews[0].source_checks[0].stage_checks[0].combination_check, { outcome: 'viable', payoff_match: 'equivalent' }) }],
    ['组合未排除仍判必需', p => { p.reviews[0].source_checks[0].stage_checks[2].combination_check.outcome = 'unproven' }],
    ['组合没有保留预警时窗', p => { p.reviews[0].source_checks[0].stage_checks[2].combination_check.time_window = '' }],
    ['组合等效性未证实', p => { p.reviews[0].source_checks[0].stage_checks[2].combination_check.payoff_match = 'unproven' }],
    ['组合阻碍没有证据', p => { p.reviews[0].source_checks[0].stage_checks[2].combination_check.quote = '' }],
    ['后段只有历史贡献', p => { p.reviews[0].source_checks[0].stage_checks[2].required_now = false }],
    ['重复阶段掩盖缺失', p => { p.reviews[0].source_checks[0].stage_checks[2].stage = 'opening' }],
    ['漏阶段目标', p => { p.reviews[0].stage_goals.pop() }],
    ['漏普通交流路线', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks.shift() }],
    ['重复路线掩盖既有队伍', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks[2].kind = 'communication' }],
    ['正常交流可行仍判必需', p => { Object.assign(p.reviews[0].source_checks[0].stage_checks[0].route_checks[0], { outcome: 'viable', payoff_match: 'equivalent' }) }],
    ['人工取物未排除仍判必需', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks[1].outcome = 'unproven' }],
    ['既有队伍能做仍判必需', p => { Object.assign(p.reviews[0].source_checks[0].stage_checks[0].route_checks[2], { outcome: 'viable', payoff_match: 'equivalent' }) }],
    ['等效性未证实', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks[1].payoff_match = 'unproven' }],
    ['阻碍没有引文', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks[0].quote = '' }],
    ['跳过路线没有引文', p => { Object.assign(p.reviews[0].source_checks[0].stage_checks[0].route_checks[0], { outcome: 'not_applicable', quote: '' }) }],
    ['丢失独特回报却算可行', p => { p.reviews[0].source_checks[0].stage_checks[0].route_checks[0].outcome = 'viable' }],
    ['缺失方案对', p => { p.opening_comparisons.pop() }],
    ['重复方案对', p => { p.opening_comparisons[1] = { ...p.opening_comparisons[0] } }],
    ['开场比较伪造引文', p => { p.opening_comparisons[0].left_quote = '没有写过的敌袭护粮' }],
    ['重复开场仍通过', p => { p.opening_comparisons[0].same_conflict = true }]
  ]
  it.each(mutations)('拒收：%s', (_label, mutate) => {
    const { ideas, payload } = fixture(3)
    mutate(payload)
    expect(() => validateFusionReview(payload, ideas)).toThrow('融梗复核无效')
  })

  it('允许有依据的失败报告，不能因它失败而跳过证据核查', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    row.source_checks[0].stage_checks[2].required_now = false
    Object.assign(row.source_checks[0].stage_checks[2].route_checks[2], { outcome: 'viable', payoff_match: 'equivalent' })
    row.issues.push({ kind: 'weak_source_dependency', field: 'pacing_plan', quote: ideas[0].pacingPlan!, reason: '后段既有队伍能完成同一目标，历史贡献不能证明当下必需。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    row.source_checks[0].retained_means[0].quote = '伪造的既有资产'
    expect(() => validateFusionReview(payload, ideas)).toThrow('连续原文')
  })

  it('来源使用上限按整批计算，而非补生成数量', () => {
    expect(chartSourceUsageLimit(3, 6)).toBe(1)
    expect(chartSourceUsageLimit(3, 4)).toBe(2)
    expect(chartSourceUsageLimit(3, 2)).toBe(3)
    expect(sourceReuseIssues([qualityIdea(), qualityIdea('新书', 1)], 3, 6)).toHaveLength(2)
    expect(sourceReuseIssues([qualityIdea(), qualityIdea('新书', 1)], 3, 4)).toEqual([])
  })

  it('失败报告也不得用非法删除范围作为淘汰理由', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    row.issues.push({ kind: 'weak_source_dependency', field: 'power_system', quote: ideas[0].powerSystem!, reason: '只取消时限却继续保留核心操作的错误意见。' })
    row.source_checks[0].deletion_audit.core_operation_removed = false
    expect(() => validateFusionReview(payload, ideas)).toThrow('反事实删除范围不合法')
  })

  it('单项阻断但组合未排除时，可以提交有证据的不通过报告', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    const stage = row.source_checks[0].stage_checks[2]
    stage.required_now = false
    stage.execution_audit.evidence_sufficient = false
    stage.combination_check.outcome = 'unproven'
    stage.combination_check.payoff_match = 'unproven'
    row.issues.push({ kind: 'dependency_bypass', field: 'pacing_plan', quote: ideas[0].pacingPlan!, reason: '正常措施与旧资源组合路径尚未排除，不能判定来源必需。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
  })

  it('标题标签不能冒充两个具体来源，长篇展开缺失不能送审', () => {
    const idea = qualityIdea()
    idea.trendBasis[1].field = 'title'
    idea.pacingPlan = undefined
    expect(ideaQualityIssues(idea, []).join('；')).toContain('简介具体梗')
    expect(ideaQualityIssues(idea, []).join('；')).toContain('pacingPlan')
  })

  it('检测原稿歧义允许合法分支报告，但不得据此判来源必需', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    const check = row.source_checks[0]
    check.deletion_audit.dependency_boundary = 'ambiguous'
    check.deletion_audit.branch_analysis = '独立检测则保留输入，依赖来源则仅保留验证要求；原文尚未拆清两支。'
    check.stage_checks.forEach(stage => { stage.required_now = false })
    row.issues.push({ kind: 'weak_source_dependency', field: 'power_system', quote: ideas[0].powerSystem!, reason: '输入来源边界不清，不将某一条件分支冒充既定事实。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    check.stage_checks[2].required_now = true
    expect(() => validateFusionReview(payload, ideas)).toThrow('检测依赖未证实')
  })

  it('可从实际章节引用行动缺环或推进重复，不能拼接字段制造证据', () => {
    const { ideas, payload } = fixture(3)
    const row = payload.reviews[0]
    row.passed = false
    payload.chapter_comparisons[0].same_progression = true
    row.issues.push({ kind: 'chapter_progression_repeat', field: 'opening_chapters', quote: ideas[0].openingChapters![1].protagonistAction, reason: '第二第三章的实际行动转折重复，需要重构新方案。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    row.issues[0].quote = ideas[0].openingChapters![1].protagonistAction + '\n' + ideas[0].openingChapters![1].payoff
    expect(() => validateFusionReview(payload, ideas)).toThrow('连续原文')
  })

  it('生成和复核均保留历次反事实漏洞规则及实际前三章', () => {
    expect(CHART_IDEAS_PROMPT_VERSION).toBe('chart-ideas-v17-effects-and-resolution')
    const prompt = buildFusionReviewPrompt([qualityIdea()])
    const generation = buildIdeasPrompt({ chartLabel: '测试榜单', category: '都市', chartDate: '2026-10-24', books: [],
      ideaCount: 3, focusTags: [], goldenThreeSummary: { bookCount: 0, chapterCount: 0, directions: [] } })
    for (const text of ['采集致富', '幼童心声', '态度', '历史贡献', '灭绝', '购种', '卖粮', '既有队伍', '设备与渠道', '只删限制、保留核心能力', '本地自繁', '组合', '预警提前量', '跨界核验必须闭合', '新增检测与来源能力', '新批次不能偷换实际目标', '前三章整条推进去重', '保留资源必须保留效力', '来源独立贡献', '三章行动逐章核查', '终局核验必须接上解决动作']) {
      expect(generation).toContain(text)
      expect(prompt).toContain(text)
    }
    expect(prompt).toContain(qualityIdea().openingChapters![0].protagonistAction)
  })

  it('第二章独立失败报告不能被三阶段通过覆盖，并拒绝借用另一章引文', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    row.chapter_action_checks[1].loop_closed = false
    row.issues.push({ kind: 'action_loop_gap', field: 'opening_chapters', quote: ideas[0].openingChapters![1].openingEvent,
      reason: '第二章的执行期限和信息会面顺序没有闭合。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    row.chapter_action_checks[1].quote = ideas[0].openingChapters![0].openingEvent
    expect(() => validateFusionReview(payload, ideas)).toThrow('引文不属于对应章节')
  })

  it('允许终局未解决的有据拒收，但不能继续把后段来源判为必需', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    row.resolution_check.goal_achieved = false
    row.source_checks.forEach(check => { check.stage_checks[2].required_now = false })
    row.issues.push({ kind: 'action_loop_gap', field: 'pacing_plan', quote: ideas[0].pacingPlan!,
      reason: '终局只有确认危险，没有能改变实际结果的操作。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    row.source_checks[0].stage_checks[2].required_now = true
    expect(() => validateFusionReview(payload, ideas)).toThrow('终局未解决')
  })

  it('来源被新增能力覆盖可以拒收，但仍须保留正常劳动和旧资源效果', () => {
    const { ideas, payload } = fixture()
    const row = payload.reviews[0]
    row.passed = false
    row.source_checks[0].independence_audit.status = 'covered'
    row.source_checks[0].stage_checks.forEach(stage => { stage.required_now = false })
    row.issues.push({ kind: 'weak_source_dependency', field: 'power_system', quote: ideas[0].powerSystem!,
      reason: '新增入口已承担该来源贡献，普通劳动和现有技能均保留。' })
    expect(validateFusionReview(payload, ideas)[0].passed).toBe(false)
    row.source_checks[0].deletion_audit.retained_effects_preserved = false
    expect(() => validateFusionReview(payload, ideas)).toThrow('反事实删除范围不合法')
  })
})
