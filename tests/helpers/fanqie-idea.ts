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
    trendBasis: ['a', 'b'].map(bookId => ({ bookId, title: `测试书${bookId}`, rank: 1, field: 'intro', quote: '契约', mechanism: '用主动毁约把被动困境变成反击机会' })),
    openingChapters: [1, 2, 3].map(chapter => ({ chapter: chapter as 1 | 2 | 3, openingEvent: `债主带来第${chapter}次危机`,
      protagonistAction: '主角利用契约规则反制', conflict: '债主试图更改规则', payoff: '主角保住自己的店铺',
      endHook: '新债主找上门', summaryApplication: '主动推动冲突并兑现回报' }))
  }
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
