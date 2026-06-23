import {
  CHAPTER_ENDING_RULES,
  CONTINUITY_RULES,
  DEAI_TECHNIQUES,
  DIALOGUE_RULES,
  OUTLINE_THREE_RULES,
  OUTPUT_RULES
} from './chapter-rules'
import { renderForbiddenWordsMarkdown } from './forbidden-words'
import { renderGenreVoiceMarkdown, resolveGenreVoice } from './genre-voice'
import type { StyleProfile } from '../../../shared/types'

export { FORBIDDEN_WORD_CATEGORIES, flattenForbiddenWords } from './forbidden-words'
export { GENRE_VOICES, resolveGenreVoice } from './genre-voice'
export type { GenreKey, GenreVoice } from './genre-voice'

export function buildSystemPrompt(genre?: string, style?: StyleProfile | null): string {
  const voice = resolveGenreVoice(genre)
  const sections: string[] = []

  sections.push(
    '你是番茄小说风格的资深中文网文作者，正在依据用户提供的章节细纲写作正文。请稳定遵守下面的写作守则。'
  )

  sections.push('---')
  sections.push('## 1. 题材定位')
  sections.push(renderGenreVoiceMarkdown(voice))

  if (style) {
    sections.push('---')
    sections.push('## 1.5 文风对齐')
    sections.push(renderStyleProfileMarkdown(style))
  }

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
  sections.push('## 8. 禁用高频词')
  sections.push(renderForbiddenWordsMarkdown())

  return sections.join('\n\n')
}

export function buildHumanizerPrompt(
  genre: string | undefined,
  violationType: string,
  snippet: string
): string {
  const voice = resolveGenreVoice(genre)
  const sections: string[] = []

  sections.push(
    '你是一名专业中文小说文字编辑。任务：把用户给出的一段文字改写得更像真人自然写成，去除 AI 写作痕迹。'
  )

  sections.push('---')
  sections.push('## 1. 题材定位')
  sections.push(renderGenreVoiceMarkdown(voice))

  sections.push('---')
  sections.push('## 2. 改写原则')
  sections.push(
    [
      '1. 不改变原意与事实',
      '2. 删除 AI 写作痕迹',
      '3. 提升可读性与信息密度',
      '4. 保持自然语言节奏',
      '5. 不新增未提供的信息',
      '6. 替换语感必须匹配题材',
      '7. 优先用动作、停顿、可见反应代替抽象解释',
      '8. 长短句交替，不要整段同节奏',
      '9. 不能只删词，必须整体改写这段话'
    ].join('\n')
  )

  sections.push('---')
  sections.push('## 3. 输出格式')
  sections.push(
    [
      '严格按以下结构输出，不要任何解释：',
      '',
      '【改写后】',
      '（完整改写后的段落）',
      '',
      '【改动说明】',
      '- （1-3 条具体改了什么，为什么）'
    ].join('\n')
  )

  sections.push('---')
  sections.push('## 4. 上下文')
  sections.push(`**命中问题**：${violationType}`)
  sections.push('**原文片段**：')
  sections.push('```')
  sections.push(snippet)
  sections.push('```')

  return sections.join('\n\n')
}

function renderStyleProfileMarkdown(style: StyleProfile): string {
  const lines: string[] = []
  lines.push(`**文风名**：${style.name}`)
  lines.push(`- 文风类型：${style.identifiedStyle}`)
  if (style.sentencePatterns.length > 0) {
    lines.push(`- 句式特征：${style.sentencePatterns.join('；')}`)
  }
  if (style.vocabularyPreferences.length > 0) {
    lines.push(`- 词汇偏好：${style.vocabularyPreferences.join('；')}`)
  }
  if (style.punctuationAndRhythm.length > 0) {
    lines.push(`- 标点与节奏：${style.punctuationAndRhythm.join('；')}`)
  }
  if (style.narrativePerspective.length > 0) {
    lines.push(`- 叙事视角：${style.narrativePerspective.join('；')}`)
  }
  if (style.tone.length > 0) {
    lines.push(`- 语气：${style.tone.join('；')}`)
  }
  if (style.narrativeTemplates.length > 0) {
    lines.push(`- 基础叙事模板：${style.narrativeTemplates.join('；')}`)
  }
  // P28：三栏约束（文风 / 人设 / 剧情）—— 告诉续写模型每条归属哪一类，便于精准遵循。
  // 老数据只有 dos/donts 时会被解析层迁到 plotConstraints，这里优先用新三栏，老字段已弃用不再渲染。
  if (style.styleConstraints.length > 0) {
    lines.push(`- 【文风约束】应做：${style.styleConstraints.join('；')}`)
  }
  if (style.characterConstraints.length > 0) {
    lines.push(`- 【人设约束】应做：${style.characterConstraints.join('；')}`)
  }
  if (style.plotConstraints.length > 0) {
    lines.push(`- 【剧情约束】应做：${style.plotConstraints.join('；')}`)
  }
  lines.push('')
  lines.push(style.stylePrompt)
  return lines.join('\n')
}
