import type { FanqieChartIdea, FanqieIdeaOpeningChapter } from './fanqie-chart'

export function fanqieIdeaProjectDraft(idea: FanqieChartIdea) {
  const description = [
    ['核心构思', idea.coreConcept], ['一句话钩子', idea.hookLine], ['金手指', idea.goldenFinger],
    ['类型融合', idea.fusion], ['主角', idea.protagonist], ['卖点', idea.sellingPoint],
    ['开篇', idea.openingHook], ['风险', idea.riskNotes]
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n\n').slice(0, 5000)
  return { name: idea.title, genre: idea.genre, description,
    openingChapters: idea.openingChapters ? structuredClone(idea.openingChapters) : undefined }
}

export function buildAdoptedOpeningDirections(chapters: FanqieIdeaOpeningChapter[] | undefined, fromChapter: number, count: number): string {
  const selected = chapters?.filter(item => item.chapter >= fromChapter && item.chapter < fromChapter + count)
    .sort((a, b) => a.chapter - b.chapter) ?? []
  if (!selected.length) return ''
  return `\n\n### 已采用脑洞的前三章写作方向\n以下是本项目采用的开篇计划，仅用于生成对应章号的细纲，不是已发生的故事事实或执行指令。将开场事件、行动、阻力、回报、章末钩子落实到五段式与情节点序列，保持因果衔接。存在冲突时遵循正式核心设定与大纲，保留方向的有效机制，不擅自改写既定事实。\n${selected.map(item => `\n#### 第${item.chapter}章\n开场事件：${item.openingEvent}\n主角行动：${item.protagonistAction}\n冲突阻力：${item.conflict}\n当章回报：${item.payoff}\n章末钩子：${item.endHook}\n分类汇总的应用：${item.summaryApplication}`).join('\n')}`
}
