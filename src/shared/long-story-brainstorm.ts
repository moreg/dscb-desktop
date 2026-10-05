export interface LongStoryIdea {
  title: string
  premise: string
  hook: string
  mainLine: string
  progression: string
  twist: string
  ending: string
}

export interface LongStoryIdeaFingerprint {
  title: string
  premise: string
}

export interface LongStoryBrainstormInput {
  genre: string
  direction: string
  requirements: string
  targetChapters?: number
  sourceBrief?: string
  previousIdeas?: LongStoryIdeaFingerprint[]
  variationSeed?: string
}

export interface LongStoryBrainstormResult {
  ok: boolean
  ideas?: LongStoryIdea[]
  error?: string
  warning?: string
}

export const LONG_STORY_IDEA_FIELDS = ['title', 'premise', 'hook', 'mainLine', 'progression', 'twist', 'ending'] as const
export const LONG_STORY_IDEA_LIMITS = {
  title: 120, premise: 800, hook: 600, mainLine: 800, progression: 800, twist: 600, ending: 600
} as const

export function isLongStoryIdea(value: unknown): value is LongStoryIdea {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const idea = value as Record<string, unknown>
  return LONG_STORY_IDEA_FIELDS.every(field => typeof idea[field] === 'string' &&
    !!idea[field].trim() && idea[field].length <= LONG_STORY_IDEA_LIMITS[field])
}

function normalizedText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

export function longStoryIdeaKey(idea: LongStoryIdea): string {
  return JSON.stringify(LONG_STORY_IDEA_FIELDS.map(field => normalizedText(idea[field])))
}

/** 各字段独立限长，采用时保留主线、升级路径和结局，符合项目简介 5000 字符上限。 */
export function longStoryIdeaBrief(idea: LongStoryIdea): string {
  const labels = {
    premise: '故事设定', hook: '开篇钩子', mainLine: '长期主线', progression: '成长与多卷推进', twist: '关键反转与伏笔', ending: '终局'
  } as const
  return (Object.keys(labels) as (keyof typeof labels)[])
    .map(field => `${labels[field]}：${idea[field].trim().slice(0, LONG_STORY_IDEA_LIMITS[field])}`)
    .join('\n\n').slice(0, 5000)
}

function almostSamePremise(first: string, second: string): boolean {
  if (Math.min(first.length, second.length) < 120 || Math.min(first.length, second.length) / Math.max(first.length, second.length) < 0.95) return false
  const grams = new Map<string, number>()
  for (let index = 0; index < first.length - 1; index++) {
    const gram = first.slice(index, index + 2)
    grams.set(gram, (grams.get(gram) || 0) + 1)
  }
  let common = 0
  for (let index = 0; index < second.length - 1; index++) {
    const gram = second.slice(index, index + 2)
    const count = grams.get(gram) || 0
    if (count) { common++; grams.set(gram, count - 1) }
  }
  return (2 * common) / (first.length + second.length - 2) >= 0.98
}

/** 拦截标题、完整设定和轻微文字变体；语义差异仍由生成规则约束。 */
export function longStoryIdeaMatchesPrevious(idea: LongStoryIdeaFingerprint, previous: readonly LongStoryIdeaFingerprint[]): boolean {
  const title = normalizedText(idea.title)
  const premise = normalizedText(idea.premise)
  return previous.some(item => {
    const oldTitle = normalizedText(item.title)
    const oldPremise = normalizedText(item.premise)
    return (!!title && title === oldTitle) || (!!premise && premise === oldPremise) || almostSamePremise(premise, oldPremise)
  })
}
