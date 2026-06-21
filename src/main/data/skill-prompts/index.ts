/**
 * 「正文写作」技能 prompt 模块统一入口。
 * 提供 buildSystemPrompt(genre) 给 WriteService 用。
 */

import {
  CHAPTER_ENDING_RULES,
  OUTLINE_THREE_RULES,
  DEAI_TECHNIQUES,
  DIALOGUE_RULES,
  CONTINUITY_RULES,
  OUTPUT_RULES
} from './chapter-rules'
import { renderForbiddenWordsMarkdown } from './forbidden-words'
import { resolveGenreVoice, renderGenreVoiceMarkdown } from './genre-voice'

export { FORBIDDEN_WORD_CATEGORIES, flattenForbiddenWords } from './forbidden-words'
export { GENRE_VOICES, resolveGenreVoice } from './genre-voice'
export type { GenreKey, GenreVoice } from './genre-voice'

/**
 * 构造写作 system prompt。
 *
 * 内容（按从总到细）：
 * 1. 角色定位（番茄金番作者）
 * 2. 题材语感（按 genre 选）
 * 3. 输出要求（字数/格式/章末）
 * 4. 三铁律（细纲遵守）
 * 5. 衔接检查原则
 * 6. 章末硬性原则
 * 7. 7 大去 AI 味技巧
 * 8. 真人对话特征
 * 9. 12 类禁用词清单
 *
 * 整体长度约 2500-3500 字。OpenAI/Anthropic 都能稳定吃下。
 */
export function buildSystemPrompt(genre?: string): string {
  const voice = resolveGenreVoice(genre)
  const sections: string[] = []

  sections.push(
    '你是番茄小说的金番作者，有 30 年的小说写作经验。你正在按用户提供的章节细纲创作正文，遵循下列写作守则。'
  )

  sections.push('---')
  sections.push('## 1. 题材定位')
  sections.push(renderGenreVoiceMarkdown(voice))

  sections.push('---')
  sections.push('## 2. 输出要求')
  sections.push(OUTPUT_RULES)

  sections.push('---')
  sections.push('## 3. 细纲遵守')
  sections.push(OUTLINE_THREE_RULES)

  sections.push('---')
  sections.push('## 4. 衔接检查')
  sections.push(CONTINUITY_RULES)

  sections.push('---')
  sections.push('## 5. 章末硬性原则')
  sections.push(CHAPTER_ENDING_RULES)

  sections.push('---')
  sections.push('## 6. 去 AI 味技巧')
  sections.push(DEAI_TECHNIQUES)

  sections.push('---')
  sections.push('## 7. 对话规则')
  sections.push(DIALOGUE_RULES)

  sections.push('---')
  sections.push('## 8. 禁用高频词（出现即视作 AI 味，必须替换）')
  sections.push(renderForbiddenWordsMarkdown())

  return sections.join('\n\n')
}
