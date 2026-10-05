import { z } from 'zod'
import type { LongStoryIdea } from '../../shared/long-story-brainstorm'
import type { ShortStoryIdea } from '../../shared/short-story'
import type { LlmService } from '../data/llm-service'
import {
  buildLongStoryBrainstormPrompt,
  longStoryBrainstormInputSchema,
  parseLongStoryBrainstormResult
} from '../data/skill-prompts/long-story-brainstorm'
import {
  buildShortStoryBrainstormPrompt,
  shortStoryBrainstormInputSchema,
  parseShortStoryBrainstormResult
} from '../data/skill-prompts/short-story-brainstorm'

const targetWordsSchema = shortStoryBrainstormInputSchema.shape.targetWords
const targetChaptersSchema = longStoryBrainstormInputSchema.shape.targetChapters
const shortInputSchema = shortStoryBrainstormInputSchema.omit({ excludedIdeas: true, rewrite: true })

export const mobileBrainstormInputSchema = z.discriminatedUnion('kind', [
  longStoryBrainstormInputSchema.extend({
    kind: z.literal('long'),
    targetWords: targetWordsSchema.optional()
  }),
  shortInputSchema.extend({
    kind: z.literal('short'),
    targetWords: targetWordsSchema.default(8_000),
    targetChapters: targetChaptersSchema
  }),
  shortInputSchema.extend({
    kind: z.literal('medium'),
    targetWords: targetWordsSchema.default(30_000),
    targetChapters: targetChaptersSchema
  })
])

export type MobileBrainstormInput = z.input<typeof mobileBrainstormInputSchema>

export interface MobileBrainstormResult {
  ok: boolean
  ideas?: Array<LongStoryIdea | ShortStoryIdea>
  warning?: string
  rawText?: string
  error?: string
}

export interface MobileBrainstormGenerator {
  generate(input: MobileBrainstormInput, signal: AbortSignal): Promise<MobileBrainstormResult>
}

const MAX_RAW_TEXT_CHARS = 200_000

/** Uses the desktop brainstorm prompts without creating a project or writing any files. */
export class MobileBrainstormService implements MobileBrainstormGenerator {
  constructor(private readonly llm: Pick<LlmService, 'generateStream'>) {}

  async generate(input: MobileBrainstormInput, signal: AbortSignal): Promise<MobileBrainstormResult> {
    if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
    const validated = mobileBrainstormInputSchema.safeParse(input)
    if (!validated.success) return { ok: false, error: '脑洞参数无效，请检查输入内容' }
    const data = validated.data
    const prompt = data.kind === 'long'
      ? buildLongStoryBrainstormPrompt(data)
      : buildShortStoryBrainstormPrompt({
          ...data,
          excludedIdeas: data.previousIdeas?.map((idea) => `${idea.title}：${idea.premise}`.slice(0, 1_500))
        })
    const parse = (text: string) => data.kind === 'long'
      ? parseLongStoryBrainstormResult(text, { allowPartial: true, previousIdeas: data.previousIdeas })
      : parseShortStoryBrainstormResult(text, { allowPartial: true, previousIdeas: data.previousIdeas })
    let receivedText = ''
    let rawText: string
    let finished = false
    try {
      try {
        rawText = await this.llm.generateStream(prompt.user, {
          systemPrompt: prompt.system,
          maxTokens: prompt.maxTokens,
          meta: { feature: prompt.feature },
          signal,
          onToken: (token) => {
            if (signal.aborted || finished || !token) return
            receivedText = (receivedText + token).slice(0, MAX_RAW_TEXT_CHARS)
          }
        })
      } catch (error) {
        if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
        rawText = receivedText
        const code = error instanceof Error ? error.message : ''
        if ((code === 'LLM_OUTPUT_TRUNCATED' || code === 'LLM_TIMEOUT') && rawText) {
          try {
            const parsed = parse(rawText)
            const interruption = code === 'LLM_TIMEOUT' ? '模型响应超时' : '模型输出被截断'
            return {
              ok: true,
              ideas: parsed.ideas,
              warning: `${interruption}。${parsed.warning || `已保留 ${parsed.ideas.length} 个完整脑洞；原始文本仍可查看。`}`,
              rawText
            }
          } catch { /* Preserve received text even when no complete idea can be recovered. */ }
        }
        return { ok: false, error: publicGenerationError(code), ...(rawText ? { rawText } : {}) }
      }
      if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
      // A bounded raw copy remains available when the output fails schema validation.
      rawText = rawText.slice(0, MAX_RAW_TEXT_CHARS)
      try {
        const parsed = parse(rawText)
        return { ok: true, ideas: parsed.ideas, ...(parsed.warning ? { warning: parsed.warning } : {}), rawText }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : '脑洞结果无法解析，原始内容仍保留',
          rawText
        }
      }
    } finally {
      finished = true
    }
  }
}

function publicGenerationError(code: string): string {
  const messages: Record<string, string> = {
    LLM_ABORTED: 'LLM_ABORTED',
    LLM_NOT_CONFIGURED: '请先在电脑端设置 AI 模型',
    LLM_AUTH_FAILED: 'AI 模型认证失败，请检查电脑端配置',
    LLM_RATE_LIMIT: 'AI 请求过于频繁，请稍后重试',
    LLM_TIMEOUT: '模型响应超时，请重试',
    LLM_OUTPUT_TRUNCATED: '模型输出被截断，请换一批；已收到的原始内容仍保留',
    LLM_RESPONSE_TOO_LARGE: '脑洞返回内容过长，请精简要求后重试'
  }
  return messages[code] || '脑洞生成失败，请检查电脑端 AI 连接后重试'
}
