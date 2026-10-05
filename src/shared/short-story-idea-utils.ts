import type { ShortStoryIdea, ShortStoryIdeaFingerprint } from './short-story'

export const SHORT_STORY_IDEA_FIELDS = ['title', 'premise', 'hook', 'twist', 'ending'] as const
export const SHORT_STORY_IDEA_LIMITS = { title: 120, premise: 3000, hook: 1500, twist: 1500, ending: 1500 } as const

export function isShortStoryIdea(value: unknown): value is ShortStoryIdea {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const idea = value as Record<string, unknown>
  return SHORT_STORY_IDEA_FIELDS.every(field => typeof idea[field] === 'string' &&
    !!idea[field].trim() && idea[field].length <= SHORT_STORY_IDEA_LIMITS[field])
}

export function normalizeShortStoryIdeaText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 全内容用于区分改写版本；历史排除则只比较标题与核心设定。 */
export function shortStoryIdeaKey(idea: ShortStoryIdea): string {
  return JSON.stringify(SHORT_STORY_IDEA_FIELDS.map(field => normalizeShortStoryIdeaText(idea[field])))
}

export function shortStoryIdeaFingerprint(idea: ShortStoryIdea): ShortStoryIdeaFingerprint {
  return { title: idea.title.trim(), premise: idea.premise.trim() }
}

/** 设定和反转各有预算，长设定不会挤掉关键反转。 */
export function shortStoryIdeaExclusion(idea: ShortStoryIdea): string {
  return `标题：${idea.title.slice(0, 120)}\n设定：${idea.premise.slice(0, 800)}\n反转：${idea.twist.slice(0, 500)}`
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index++) {
    const gram = text.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  return counts
}

/** 只拦截长设定中的轻微文字变体，不声称能判断语义是否重复。 */
function almostSamePremise(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 120 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.95) return false
  const first = bigrams(a)
  const second = bigrams(b)
  let common = 0
  for (const [gram, count] of first) common += Math.min(count, second.get(gram) || 0)
  return (2 * common) / (a.length + b.length - 2) >= 0.98
}

export function shortStoryIdeaMatchesPrevious(idea: ShortStoryIdeaFingerprint, previous: readonly ShortStoryIdeaFingerprint[]): boolean {
  const title = normalizeShortStoryIdeaText(idea.title)
  const premise = normalizeShortStoryIdeaText(idea.premise)
  return previous.some(item => {
    const oldTitle = normalizeShortStoryIdeaText(item.title)
    const oldPremise = normalizeShortStoryIdeaText(item.premise)
    return (!!title && title === oldTitle) || (!!premise && premise === oldPremise) || almostSamePremise(premise, oldPremise)
  })
}
