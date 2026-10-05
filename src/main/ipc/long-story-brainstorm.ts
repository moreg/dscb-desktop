import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { LongStoryBrainstormResult } from '../../shared/long-story-brainstorm'
import type { LlmService } from '../data/llm-service'
import {
  buildLongStoryBrainstormPrompt, longStoryBrainstormInputSchema, parseLongStoryBrainstormResult
} from '../data/skill-prompts/long-story-brainstorm'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'
import { safeHandle, safeSend } from './safe-handle'
import { validateInput } from './validation'

const brainstormRequestSchema = longStoryBrainstormInputSchema.extend({ requestId: z.string().uuid() })

export function registerLongStoryBrainstormIpc(llm: LlmService): void {
  safeHandle('longStory:brainstorm', async (e, payload: unknown): Promise<LongStoryBrainstormResult> => {
    const input = validateInput(brainstormRequestSchema, payload)
    const win = BrowserWindow.fromWebContents(e.sender)
    const signal = beginStream(input.requestId)
    const cancelOnClose = () => { abortStream(input.requestId) }
    let receivedText = ''
    let finished = false
    e.sender.once('destroyed', cancelOnClose)
    try {
      if (signal.aborted || e.sender.isDestroyed()) return { ok: false, error: 'LLM_ABORTED' }
      const prompt = buildLongStoryBrainstormPrompt(input)
      let received = false
      const text = await llm.generateStream(prompt.user, {
        systemPrompt: prompt.system,
        maxTokens: prompt.maxTokens,
        meta: { feature: prompt.feature },
        signal,
        onToken: token => {
          if (signal.aborted || finished || !token) return
          received = true
          // 超长返回会被解析器拒绝；累计文本同样限长，原文仍按 token 推送给页面。
          receivedText = (receivedText + token).slice(0, 100001)
          safeSend(win, 'longStory:brainstormToken', { requestId: input.requestId, token, done: false })
        }
      })
      if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
      if (!text.trim()) throw new Error('模型未返回脑洞内容，请重试')
      // 先交付原始返回，再解析；格式错误时用户仍可保存已推送的素材。
      if (!received) safeSend(win, 'longStory:brainstormToken', { requestId: input.requestId, token: text, done: false })
      const parsed = parseLongStoryBrainstormResult(text, { allowPartial: true, previousIdeas: input.previousIdeas })
      return { ok: true, ideas: parsed.ideas, ...(parsed.warning ? { warning: parsed.warning } : {}) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // HTTP 流达到 token 上限或中途断开时 LlmService 会抛错，不会返回累计原文。
      // 仅恢复已推送的完整方案；主动取消不交付迟到结果，也不再发起模型请求。
      if (!signal.aborted && !e.sender.isDestroyed() &&
        (message === 'LLM_OUTPUT_TRUNCATED' || message === 'LLM_TIMEOUT') && receivedText && receivedText.length <= 100000) {
        try {
          const parsed = parseLongStoryBrainstormResult(receivedText, { allowPartial: true, previousIdeas: input.previousIdeas })
          const interruption = message === 'LLM_TIMEOUT' ? '模型响应超时' : '模型输出被截断'
          return { ok: true, ideas: parsed.ideas, warning: parsed.warning
            ? `${interruption}。${parsed.warning}`
            : `${interruption}，已保留 ${parsed.ideas.length} 个完整脑洞；原始文本仍可查看。` }
        } catch { /* 无可用候选时保留原始中断错误，已收到的原文仍可查看。 */ }
      }
      return { ok: false, error: signal.aborted ? 'LLM_ABORTED' : message }
    } finally {
      finished = true
      safeSend(win, 'longStory:brainstormToken', { requestId: input.requestId, token: '', done: true })
      e.sender.removeListener('destroyed', cancelOnClose)
      endStream(input.requestId)
    }
  })
}
