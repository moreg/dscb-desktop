import { z } from 'zod'

const text = z.string().trim().min(1).max(1800)
export const chapterDirectionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  title: text.max(80),
  connection: text,
  conflict: text,
  tension: text.optional(),
  progression: text,
  ending: text,
  hook: text,
  outlineReason: text
})
export type ChapterDirection = z.infer<typeof chapterDirectionSchema>
export const directionChoiceSchema = z.object({
  token: z.string().uuid(),
  directionId: z.string().min(1).max(40),
  adjustment: z.string().max(6000).optional()
})
export type ChapterDirectionChoice = z.infer<typeof directionChoiceSchema>
export interface ChapterDirections {
  token: string
  chapterNumber: number
  contextHash: string
  directions: ChapterDirection[]
  recommendedId: string
  recommendationReason: string
  missingPreviousProse: boolean
}

export function renderDirection(direction: ChapterDirection, adjustment?: string): string {
  return [
    `方向：${direction.title}`, `承接点：${direction.connection}`, `主要冲突：${direction.conflict}`,
    direction.tension?.trim() ? `场面张力与顾虑：${direction.tension.trim()}` : '',
    `本章推进：${direction.progression}`, `本章落点：${direction.ending}`, `章末悬念：${direction.hook}`,
    `与大纲的关系：${direction.outlineReason}`,
    adjustment?.trim() ? `作者对该方向的调整（优先于上述候选内容）：${adjustment.trim()}` : ''
  ].filter(Boolean).join('\n')
}

/** Only the author's current instruction can authorize the whole story's ending. */
export function authorAllowsStoryEnding(instruction = ''): boolean {
  if (/(?:不|别|勿|禁止|不要|不能|不准|无需|不许).{0,10}(?:完结|终章|最终章|大结局|全书.{0,4}(?:结束|收尾))/.test(instruction)) return false
  // Require a complete imperative clause. Mentions, questions, quoted requests
  // and conditional/future plans must never turn off the default ending policy.
  const unquoted = instruction.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, '')
  const prefix = '(?:(?:请你|请|麻烦|帮我|给我|本次|这次|现在|接下来|直接|今天|立刻|马上|就)\\s*)*'
  const book = '(?:全书|本书|整本书|这本书)'
  const target = `(?:${book}(?:的)?(?:完结|收尾|结束|大结局)|完结(?:章|内容)?|最终章|终章|大结局)`
  const command = new RegExp(`^${prefix}(?:写(?:出)?|生成|安排|进入|完成|允许|可以|需要|要|我要|我决定)(?:${book}(?:的)?)?${target}(?:吧|了)?$`)
  const subjectRequest = new RegExp(`^${prefix}${book}(?:现在|本次|这次)?(?:要|需要|可以|允许|就)?(?:完结|收尾|结束|大结局)(?:吧|了)?$`)
  return (unquoted.match(/[^。！？!?\n；;]+[。！？!?]?/g) ?? []).some(part => {
    if (/[？?]$/.test(part)) return false
    const sentence = part.replace(/[。！!]$/, '')
    for (const match of sentence.matchAll(/[^，,]+/g)) {
      const clause = match[0].trim()
      const earlier = sentence.slice(0, match.index)
      if (/(?:如果|假如|假设|倘若|若|除非|等到|等.{0,20}(?:结束|完成|以后|之后)|以后|将来|未来|届时|到时候)/.test(earlier)) continue
      if (command.test(clause) || subjectRequest.test(clause) || /^(?:完结|大结局|最终章|终章)(?:吧)?$/.test(clause)) return true
    }
    return false
  })
}

export const NO_STORY_ENDING = '用户没有明确授权全书完结：禁止写全书终局、终章、尾声、人物一生归宿或封闭所有后续空间的完结内容。可以结束本章、解决当前冲突或收束阶段剧情，但必须保留符合主线的后续推进空间。大纲结局、最后章号和一键十章的最后一章均不构成完结授权。'
export function storyEndingPolicy(instruction?: string): string {
  return authorAllowsStoryEnding(instruction)
    ? '作者本次明确要求全书完结，允许依照其要求和大纲完成全书收束。'
    : NO_STORY_ENDING
}

export function assertNoUnauthorizedStoryEnding(content: string, instruction?: string): void {
  if (!authorAllowsStoryEnding(instruction) && /(?:^|\n)\s*(?:[（(【[]\s*)?(?:全书完|全书完结|全文完|本书完|本书完结|THE END)(?:\s*[）)】\]])?[。.!！]?\s*$/im.test(content)) {
    throw new Error('LONGFORM_CONFLICT: 用户未授权全书完结，正文出现全书完结标记，未通过交稿核验。')
  }
}

export function assertNoUnauthorizedDirectionEnding(direction: ChapterDirection, instruction?: string): void {
  if (authorAllowsStoryEnding(instruction)) return
  const text = renderDirection(direction)
  assertNoUnauthorizedStoryEnding(text, instruction)
  for (const clause of text.split(/[。！？!?\n；;，,]+/)) {
    const match = clause.match(/(?:(?:全书|整本书|本书)(?:的|到此)?(?:终局|完结|大结局|收尾|收束|结束|最终章|终章|尾声)|(?:进入|迎来|写到|安排|作为|写成)?(?:大结局|最终章|终章)|交代(?:所有|全部)人物(?:的)?一生归宿)/)
    if (!match) continue
    const prefix = clause.slice(0, match.index)
    if (/(?:不|未|勿|别|莫|暂不|尚未|并非|没有|避免|禁止|不写|不进|不作|非)/.test(prefix)) continue
    throw new Error(`方向审核未通过：方向 ${direction.id} 未经允许规划了全书终局。`)
  }
}
