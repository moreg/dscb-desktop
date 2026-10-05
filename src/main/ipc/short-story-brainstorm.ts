import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { ShortStoryBrainstormResult } from '../../shared/short-story'
import type { LlmService } from '../data/llm-service'
import {
  buildShortStoryBrainstormPrompt,
  mergeShortStoryIdeaRewrite,
  parseShortStoryBrainstormResult,
  shortStoryBrainstormInputSchema
} from '../data/skill-prompts/short-story-brainstorm'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'
import { safeHandle, safeSend } from './safe-handle'
import { validateInput } from './validation'

const brainstormRequestSchema = shortStoryBrainstormInputSchema.extend({ requestId: z.string().uuid() })

export function registerShortStoryBrainstormIpc(llm: LlmService): void {
  safeHandle('shortStory:brainstorm', async (e, payload: unknown): Promise<ShortStoryBrainstormResult> => {
    // 校验失败直接在 IPC 边界拒绝，避免建立流或占用模型调用。
    const input = validateInput(brainstormRequestSchema, payload)
    const win = BrowserWindow.fromWebContents(e.sender)
    const signal = beginStream(input.requestId)
    const cancelOnClose = () => { abortStream(input.requestId) }
    e.sender.once('destroyed', cancelOnClose)
    try {
      if (signal.aborted || e.sender.isDestroyed()) return { ok: false, error: 'LLM_ABORTED' }
      const prompt = buildShortStoryBrainstormPrompt(input)
      let received = false
      const text = await llm.generateStream(prompt.user, {
        systemPrompt: prompt.system,
        maxTokens: prompt.maxTokens,
        meta: { feature: prompt.feature },
        signal,
        onToken: token => {
          if (signal.aborted || !token) return
          received = true
          safeSend(win, 'shortStory:brainstormToken', { requestId: input.requestId, token, done: false })
        }
      })
      if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
      if (!text.trim()) throw new Error('模型未返回脑洞内容，请重试')
      // 结构解析失败时也先交付原文，让用户可以保留和自行采用素材。
      if (!received) safeSend(win, 'shortStory:brainstormToken', { requestId: input.requestId, token: text, done: false })
      const parsed = parseShortStoryBrainstormResult(text, {
        allowPartial: !input.rewrite,
        expectedCount: input.rewrite ? 1 : 3,
        previousIdeas: input.rewrite ? undefined : input.previousIdeas
      })
      const ideas = input.rewrite ? [mergeShortStoryIdeaRewrite(input.rewrite, parsed.ideas[0])] : parsed.ideas
      return { ok: true, ideas, ...(parsed.warning ? { warning: parsed.warning } : {}) }
    } catch (err) {
      return { ok: false, error: signal.aborted ? 'LLM_ABORTED' : err instanceof Error ? err.message : String(err) }
    } finally {
      safeSend(win, 'shortStory:brainstormToken', { requestId: input.requestId, token: '', done: true })
      e.sender.removeListener('destroyed', cancelOnClose)
      endStream(input.requestId)
    }
  })
}
