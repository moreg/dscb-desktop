import { joinContinuation } from '../../shared/format-chapter-prose'
import type { ShortStoryDocument, ShortStoryTask } from '../../shared/short-story'

export interface ShortStoryCandidate {
  task: ShortStoryTask
  sectionNumber?: number
  append: boolean
  text: string
  status: 'generating' | 'completed' | 'stopped' | 'failed'
  source: string
  /** 候选旁展示并随恢复稿保存的失败或中断原因。 */
  error?: string
  /** 重试沿用当次要求，避免切换分节后改变修订任务。 */
  instruction?: string
}

/** 普通候选只绑定原稿；修订候选还必须绑定所依据的检查报告。 */
export function shortStoryCandidateSource(story: ShortStoryDocument, task: ShortStoryTask): string {
  return JSON.stringify({ title: story.title, kind: story.kind, genre: story.genre, brief: story.brief,
    requirements: story.requirements, targetWords: story.targetWords, sectionCount: story.sectionCount,
    outline: story.outline, sections: story.sections, ...(task === 'revise' ? { review: story.review } : {}) })
}

export function adoptShortStoryCandidate(story: ShortStoryDocument, candidate: ShortStoryCandidate): ShortStoryDocument {
  if (shortStoryCandidateSource(story, candidate.task) !== candidate.source) {
    throw new Error('原稿或检查报告已变化，请重新生成，或复制候选自行编辑。')
  }
  if (!candidate.text.trim()) throw new Error('候选正文为空，请生成后再采用。')
  if (candidate.task === 'outline') return { ...story, outline: candidate.text, review: '' }
  if (candidate.task === 'review') return { ...story, review: candidate.text }
  if (!story.sections.some(item => item.number === candidate.sectionNumber)) throw new Error('候选对应的分节不存在，请重新生成。')
  if (candidate.task === 'revise') {
    if (candidate.status !== 'completed') throw new Error('修订尚未完成，请重新生成；已收到的文本可复制后手动编辑。')
    if (candidate.text.length > 40000) throw new Error('修订正文超过单节 40000 字符限制，请精简候选后再采用。')
    const totalLength = story.sections.reduce((sum, item) => sum + (item.number === candidate.sectionNumber ? candidate.text.length : item.content.length), 0)
    if (totalLength > 300000) throw new Error('采用后正文合计超过 300000 字符限制，请精简候选后再采用。')
  }
  return {
    ...story, review: '',
    sections: story.sections.map(item => item.number === candidate.sectionNumber
      ? { ...item, content: candidate.task === 'section' && candidate.append ? joinContinuation(item.content, candidate.text) : candidate.text }
      : item)
  }
}
