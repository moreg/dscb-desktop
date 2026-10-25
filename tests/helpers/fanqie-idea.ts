import type { FanqieChartIdea } from '../../src/shared/fanqie-chart'

export function qualityIdea(title = '契约店主', variant = 0): FanqieChartIdea {
  const concepts = ['店主以契约反制债主，解救被扣押的街坊', '深海潜水员用声波诱导鱼群寻找沉船', '画师燃烧记忆重现失踪者最后见到的景象']
  const fingers = ['亲手签署的契约能把违约金变成护盾，每天只能使用一次', '收集潮汐声音后可以驱使鱼群朝指定海域游动，离水失效', '消耗童年记忆画出目击者视野，图像仅保留十秒且无法修改过去']
  return {
    title, titleCandidates: [title, title + '新传', title + '奇遇'], strategy: 'fusion', genre: '都市',
    hookLine: '债主上门索要店铺，店主却把违约金变成护盾，当场救回被扣的街坊。',
    goldenFinger: fingers[variant], fusion: '契约规则改变街坊之间的信任关系', coreConcept: concepts[variant],
    sellingPoint: '通过主动选择赢得街坊支持', protagonist: '陈言，店主，想保住店铺却怕承担责任',
    openingHook: '陈言主动签约救回街坊', marketReasoning: '提炼样本里主角主动反制的机制', readerFit: '喜欢规则博弈和群像', riskNotes: '不能临时改写契约规则',
    worldSetting: '街坊的店铺受契约支配，既有财产和正常判断持续保留。',
    powerSystem: '本段仅为复核协议测试素材，能力规则必须在具体节点共同参与。',
    supportingCharacters: '街坊和债主各有职责，既有队伍与正常交流能力保留。',
    coreConflict: '主角要救回街坊并保住店铺，而非必须拿到某一张指定契约。',
    targetAudience: '读者期待规则博弈中的具体行动与兑现，不接受临时增加禁令。',
    pacingPlan: '开篇救回街坊，中段解除街区控制，后段解决最终契约障碍；每段冻结既得收益再审来源。',
    trendBasis: ['a', 'b'].map(bookId => ({ bookId, title: `测试书${bookId}`, rank: 1, field: 'intro', quote: '契约', mechanism: '用主动毁约把被动困境变成反击机会' })),
    openingChapters: [1, 2, 3].map(chapter => ({ chapter: chapter as 1 | 2 | 3, openingEvent: `债主带来第${chapter}次危机`,
      protagonistAction: '主角利用契约规则反制', conflict: '债主试图更改规则', payoff: '主角保住自己的店铺',
      endHook: '新债主找上门', summaryApplication: '主动推动冲突并兑现回报' }))
  }
}

/** 只用于协议与调用链测试，不代表这些占位故事通过了真实模型的语义审核。 */
export function passingFusionReview(prompt: string): string {
  const materials = JSON.parse(prompt.split('待审材料：\n')[1]) as Array<{
    index: number; opening_hook: string; concept: { golden_finger: string; trend_basis: Array<{ book_id: string }>; opening_chapters: NonNullable<FanqieChartIdea['openingChapters']> };
    expanded: { power_system: string; pacing_plan: string }
  }>
  const stages = ['opening', 'middle', 'late']
  const requiredOutput = '完成此节点已经明确的核心目标与独特回报'
  return JSON.stringify({ reviews: materials.map(material => ({ index: material.index, passed: true,
    stage_goals: stages.map(stage => ({ stage, field: 'pacing_plan', quote: material.expanded.pacing_plan,
      required_output: requiredOutput, distinctive_payoff: '原稿明确承诺的同一个独特回报', equivalent_success: '达成实际目标并完整保留独特回报',
      item_or_channel: '选定的工具与渠道不直接当作目标', necessity_basis: '对应目标的必要条件须由已有原文支持', boundary_valid: true,
      material_substitution_test: '测试占位比较实际成果与可替换的材料渠道', new_requirement: '本节点新增需求具体且未由旧成果覆盖', old_stock_test: '测试用旧资源比较须结合真实原稿核查', need_established: true })),
    action_checks: stages.map(stage => ({ stage, field: 'pacing_plan', quote: material.expanded.pacing_plan,
      known_before: '决策前已存在的位置与线索按原文冻结', verification_route: '测试占位观察与传讯均在启动前完成',
      activation_sequence: '先获取送达信息再作决策并执行实际操作', loop_closed: true, reason: '测试只校验协议，真实行动先后须审稿核实' })),
    chapter_action_checks: material.concept.opening_chapters.map(ch => ({ chapter: ch.chapter, field: 'opening_chapters', quote: ch.protagonistAction,
      timeline: '协议占位：逐章串起准备执行与验收时点', carryover: '协议占位：核对上章承诺与下一章期限',
      loop_closed: true, reason: '测试仅验证协议，不代表真实章节时序已成立' })),
    resolution_check: { field: 'pacing_plan', quote: material.expanded.pacing_plan, required_output: requiredOutput,
      intervention: '协议占位：最终实际操作改变核心障碍', resulting_change: '协议占位：行动结果兑现同一独特回报',
      goal_achieved: true, reason: '测试只核对结构，真实解决动作由模型审查' },
    source_checks: material.concept.trend_basis.map(ref => ({ book_id: ref.book_id, field: 'power_system', quote: material.expanded.power_system,
      reason: '测试协议中具体来源在节点提供必要操作', contribution_type: 'mechanism', removal_effect: '只关闭此来源当前操作再尝试破局',
      remaining_route: '保留全部新增能力与既得资源重新求解', removed_part: '仅关闭本来源实际提供的独特操作',
      independence_audit: { field: 'power_system', quote: material.expanded.power_system, status: 'independent',
        remaining_operations: '其他来源新增能力和正常劳动全部保留', difference: '协议占位：此源提供其余手段不含的操作' },
      deletion_audit: { field: 'power_system', quote: material.expanded.power_system,
        core_operation: '测试占位的来源核心操作已明确关闭', retained_triggers: '新增能力触发条件完整保留而非任意取消',
        core_operation_removed: true, retained_means_preserved: true, activation_conditions_preserved: true,
        retained_effects_preserved: true, existing_effects: '已有成品的效果期限和普通使用权限全部保留',
        reason: '测试仅校验协议，真实反事实必须核实具体操作', dependency_boundary: 'resolved',
        input_dependency: '来源提供输入，新增处理依赖真实取得的数据', branch_analysis: '测试原稿边界明确，没有另行假定独立检测' },
      retained_means: [{ field: 'golden_finger', quote: material.concept.golden_finger, reason: '保留所有新增能力以及已取得的资产' }],
      stage_checks: stages.map(stage => ({ stage, field: 'pacing_plan', quote: material.expanded.pacing_plan,
        fresh_contribution: '此节点尚未完成的新贡献与独特操作', without_source_route: '冻结已有资产后逐项尝试其余手段', required_now: true, required_output: requiredOutput,
        execution_audit: { field: 'power_system', quote: material.expanded.power_system,
          carrier: '此节点实际执行者与设备均按原文保留', operating_scope: '原稿给出的操作场域与启动条件没有变更',
          retained_conditions: '保留此前设备与耗材，测试真实使用条件', evidence_sufficient: true, reason: '测试占位条件，须由真实审核结合场景判定' },
        combination_check: { route: '正常询问加既有队伍与保留能力组合求解', outcome: 'blocked', field: 'power_system', quote: material.expanded.power_system,
          reason: '协议测试占位，真实审核必须串起步骤核对阻碍', payoff_match: 'non_equivalent', payoff_comparison: '此占位组合无法完成相同的实际回报',
          preserved_resources: '所有已得能力资产和正常执行能力均保留', time_window: '从节点原有预警时刻开始而不是灾后才行动' },
        route_checks: ['communication', 'manual_acquisition', 'existing_team'].map(kind => ({ kind,
          route: '按原文资产尝试完成同一目标的具体路线', outcome: 'blocked', field: 'power_system', quote: material.expanded.power_system,
          reason: '测试用阻碍说明必须在真实审核中由原文支持', payoff_match: 'non_equivalent', payoff_comparison: '此占位路线不能兑现相同独特回报' })) })) })), issues: [] })),
    opening_comparisons: materials.flatMap((left, i) => materials.slice(i + 1).map(right => ({
      left_index: left.index, right_index: right.index, same_conflict: false, left_quote: left.opening_hook, right_quote: right.opening_hook,
      reason: '测试用比较说明须由真实模型逐项核查五个冲突要素'
    }))),
    chapter_comparisons: materials.flatMap((left, i) => materials.slice(i + 1).map(right => ({
      left_index: left.index, right_index: right.index, same_progression: false,
      left_chain: left.concept.opening_chapters.map(ch => ({ chapter: ch.chapter, quote: ch.protagonistAction, change: '协议占位：本章行动改变局势并引出下章问题' })),
      right_chain: right.concept.opening_chapters.map(ch => ({ chapter: ch.chapter, quote: ch.protagonistAction, change: '协议占位：本章行动改变局势并引出下章问题' })),
      reason: '测试用整条因果比较，真实故事必须逐章审查实质差异'
    }))) })
}

export function relationshipIdea(title = '关系方案', variant = 0): FanqieChartIdea {
  const idea = qualityIdea(title, variant)
  idea.coreConcept += '；林月二十五岁，想查明失踪者；江雪二十七岁，想保住营地。'
  idea.openingChapters![0].payoff = '林月听完陈言解释后仍保留质疑，但暂时收起了驱逐通知。'
  idea.openingChapters![1].payoff = '江雪发现陈言记得她的旧伤，留下多余的绷带，却仍独自守夜。'
  return idea
}

export function passingReviews(count: number, ideas?: FanqieChartIdea[]): string {
  return JSON.stringify({ reviews: Array.from({ length: count }, (_, index) => ({ index, content: true, originality: true, tags: true, diversity: true,
    romanceNaturalness: true, romancePacing: true, relationshipOriginality: true,
    ...(ideas ? { relationshipAudit: { arcFingerprint: '质疑—延后驱逐；留意旧伤—保留距离', arcs: ['林月', '江雪'].map((character, i) => ({
      character, startingState: '保持距离', chapter: i + 1, eventQuote: ideas[index].openingChapters![i].payoff,
      resultingState: '开始留意，仍有疑问', rationale: '具体的回应使原先判断松动，但没有确认爱意'
    })) } } : {}), reasons: [] })) })
}
