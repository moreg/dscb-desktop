import { countProseWords } from './word-target'

/** 独立中短篇工作台；篇幅按全文预算，正文按节写完。 */
export type ShortStoryKind = 'short' | 'medium'
export type ShortStoryTask = 'outline' | 'section' | 'review' | 'revise'

export type ShortStoryStorageSelectionResult =
  | { canceled: true }
  | { canceled: false; path: string; copiedCount: number }

export interface ShortStorySection {
  number: number
  title: string
  content: string
}

export interface ShortStoryCreateInput {
  title: string
  kind: ShortStoryKind
  genre: string
  brief: string
  requirements: string
  targetWords: number
  sectionCount: number
}

export interface ShortStoryDocument extends ShortStoryCreateInput {
  id: string
  revision: number
  /** 读取时的稿件指纹，防止外部 Markdown 编辑被旧窗口覆盖。 */
  sourceFingerprint: string
  createdAt: string
  updatedAt: string
  outline: string
  sections: ShortStorySection[]
  review: string
}

export interface ShortStorySummary {
  id: string
  title: string
  kind: ShortStoryKind
  genre: string
  targetWords: number
  sectionCount: number
  writtenWords: number
  completedSections: number
  updatedAt: string
  /** 损坏作品仍在列表中可见，不影响其他作品。 */
  loadError?: string
}

export interface ShortStoryGenerationInput {
  story: ShortStoryDocument
  task: ShortStoryTask
  sectionNumber?: number
  instruction?: string
}

export interface ShortStoryIdea {
  title: string
  premise: string
  hook: string
  twist: string
  ending: string
}

export type ShortStoryRewriteFocus = 'twist' | 'ending' | 'emotion' | 'custom'

export interface ShortStoryIdeaFingerprint {
  title: string
  premise: string
}

export interface ShortStoryIdeaRewrite {
  idea: ShortStoryIdea
  focus: ShortStoryRewriteFocus
  instruction: string
}

/** 脑洞生成不要求先创建作品或填写书名。 */
export interface ShortStoryBrainstormInput {
  genre: string
  direction: string
  requirements: string
  targetWords: number
  sourceBrief?: string
  excludedIdeas?: string[]
  /** 程序用于跨批校验的完整标题与设定，不使用截断的提示摘要。 */
  previousIdeas?: ShortStoryIdeaFingerprint[]
  /** 指定时仅返回一个方案；采用改写前仍保留原方案。 */
  rewrite?: ShortStoryIdeaRewrite
  variationSeed?: string
}

export interface ShortStoryBrainstormResult {
  ok: boolean
  ideas?: ShortStoryIdea[]
  error?: string
  warning?: string
}

export function shortStoryIdeaBrief(idea: ShortStoryIdea): string {
  return `${idea.premise}\n\n开篇钩子：${idea.hook}\n关键反转：${idea.twist}\n结局：${idea.ending}`
}

export const SHORT_STORY_PRESETS = {
  short: { label: '短篇', targetWords: 8000, sectionCount: 4 },
  medium: { label: '中篇', targetWords: 30000, sectionCount: 12 }
} as const

export const SHORT_STORY_MIN_WORDS = 1000
export const SHORT_STORY_MAX_WORDS = 120000
export const SHORT_STORY_MAX_SECTIONS = 60
export const SHORT_STORY_MAX_SECTION_WORDS = 6000

/** 与现有正文统计口径一致，剥除空白。 */
export function shortStoryWordCount(content: string): number {
  return countProseWords(content)
}

/** 余数分给前面的节，预算总和始终等于全文目标。 */
export function shortStorySectionBudgets(targetWords: number, sectionCount: number): number[] {
  if (!Number.isInteger(sectionCount) || sectionCount < 1 || sectionCount > SHORT_STORY_MAX_SECTIONS) return []
  if (!Number.isInteger(targetWords) || targetWords < 1) return []
  const base = Math.floor(targetWords / sectionCount)
  const remainder = targetWords % sectionCount
  return Array.from({ length: sectionCount }, (_, index) => base + (index < remainder ? 1 : 0))
}

export function shortStoryConfigError(input: ShortStoryCreateInput): string | null {
  if (!input.title.trim()) return '请填写作品名'
  if (!Number.isInteger(input.targetWords) || input.targetWords < SHORT_STORY_MIN_WORDS || input.targetWords > SHORT_STORY_MAX_WORDS) {
    return '全文目标需在 1000—120000 字之间'
  }
  if (!Number.isInteger(input.sectionCount) || input.sectionCount < 1 || input.sectionCount > SHORT_STORY_MAX_SECTIONS) {
    return '分节数需在 1—60 节之间'
  }
  if (Math.ceil(input.targetWords / input.sectionCount) > SHORT_STORY_MAX_SECTION_WORDS) {
    return '每节预算最多 6000 字，请增加分节数'
  }
  return null
}

export function shortStorySummary(story: ShortStoryDocument): ShortStorySummary {
  return {
    id: story.id, title: story.title, kind: story.kind, genre: story.genre,
    targetWords: story.targetWords, sectionCount: story.sectionCount,
    writtenWords: story.sections.reduce((sum, section) => sum + shortStoryWordCount(section.content), 0),
    completedSections: story.sections.filter(section => section.content.trim()).length,
    updatedAt: story.updatedAt
  }
}

export function shortStoryFullText(story: ShortStoryDocument): string {
  return `# ${story.title}\n\n` + story.sections
    .map(section => `## 第 ${section.number} 节${section.title ? `：${section.title}` : ''}\n\n${section.content.trim()}`)
    .join('\n\n') + '\n'
}
