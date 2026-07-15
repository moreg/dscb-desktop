import type { LlmService } from './llm-service'
import {
  parseChapterNameJson,
  buildChapterNameSystemPrompt,
  buildChapterNameUserPrompt,
  type ChapterNameCandidate
} from '../../shared/parsers'
import type { SuggestChapterNameInput, SuggestChapterNameResult } from '../../shared/types'

export type { ChapterNameCandidate, SuggestChapterNameInput, SuggestChapterNameResult }

/**
 * 章名命名服务。仅生成候选标题，**绝不直接写盘**。
 * - 调用方拿到 result.title 后由用户确认，再走 chapters:updateMeta 持久化。
 * - 失败时返回 ok=false + error，不抛异常（避免渲染端需要 try/catch）。
 *
 * 内部走 LlmService.generateStream（一次非流式生成）；
 * feature='chapter-name' 路由到 opening 大类（与大纲/章名风格路由一致）。
 */
export class ChapterNameService {
  constructor(private readonly llm: LlmService) {}

  async suggest(input: SuggestChapterNameInput): Promise<SuggestChapterNameResult> {
    const system = buildChapterNameSystemPrompt(input.genre, null)
    const user = buildChapterNameUserPrompt({
      chapterNumber: input.chapterNumber,
      currentTitle: input.currentTitle,
      draft: input.draft,
      maxDraftChars: 800
    })

    let raw: string
    try {
      raw = await this.llm.generateStream(user, {
        systemPrompt: system,
        maxTokens: 256, // 章名仅几十字，256 token 已留足
        meta: {
          feature: 'chapter-name',
          projectId: input.projectId,
          chapterNumber: input.chapterNumber
        }
      })
    } catch (err) {
      return {
        ok: false,
        title: '',
        reason: '',
        error: (err as Error)?.message || 'LLM_REQUEST_FAILED'
      }
    }

    const parsed = parseChapterNameJson(raw, input.chapterNumber)
    if (!parsed) {
      return { ok: false, title: '', reason: '', error: 'PARSE_FAILED' }
    }
    return { ok: true, title: parsed.title, reason: parsed.reason }
  }
}