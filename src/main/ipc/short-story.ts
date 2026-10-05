import { BrowserWindow, dialog, shell } from 'electron'
import type { ShortStoryStore } from '../data/short-story-storage'
import { LlmService } from '../data/llm-service'
import { buildShortStoryPrompt } from '../data/skill-prompts/short-story'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'
import { writeTextAtomic } from '../data/atomic'
import { sanitizeTitle } from '../data/skill-format/prose-repo'
import { shortStoryCreateSchema, shortStoryDocumentSchema, shortStoryGenerationSchema, shortStoryIdSchema } from '../data/short-story-validation'
import { safeHandle, safeSend } from './safe-handle'
import { validateInput } from './validation'

export function registerShortStoryIpc(stories: ShortStoryStore, llm: LlmService): void {
  safeHandle('shortStory:list', async () => stories.list())
  safeHandle('shortStory:create', async (_e, input: unknown) => stories.create(validateInput(shortStoryCreateSchema, input)))
  safeHandle('shortStory:get', async (_e, id: unknown) => stories.get(validateInput(shortStoryIdSchema, id)))
  safeHandle('shortStory:save', async (_e, input: unknown) => stories.save(validateInput(shortStoryDocumentSchema, input)))

  safeHandle('shortStory:openDirectory', async (_e, id: unknown) => {
    const validated = validateInput(shortStoryIdSchema, id)
    const error = await shell.openPath(await stories.getDirectory(validated))
    if (error) throw new Error(error)
    return { ok: true }
  })

  safeHandle('shortStory:export', async (e, id: unknown) => {
    const validated = validateInput(shortStoryIdSchema, id)
    const story = await stories.get(validated)
    const text = await stories.export(validated)
    const options = {
      title: '导出中短篇正文',
      defaultPath: `${sanitizeTitle(story.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeTextAtomic(result.filePath, text)
    return { canceled: false, path: result.filePath }
  })

  safeHandle('shortStory:generate', async (e, payload: unknown) => {
    const input = validateInput(shortStoryGenerationSchema, payload)
    const win = BrowserWindow.fromWebContents(e.sender)
    const signal = beginStream(input.requestId)
    const cancelOnClose = () => { abortStream(input.requestId) }
    e.sender.once('destroyed', cancelOnClose)
    try {
      if (signal.aborted || e.sender.isDestroyed()) return { ok: false, error: 'LLM_ABORTED' }
      const persisted = await stories.get(input.story.id)
      if (persisted.revision !== input.story.revision || persisted.sourceFingerprint !== input.story.sourceFingerprint) {
        throw new Error('作品已在其他窗口更新，请保存或重新打开后再生成；当前草稿仍保留')
      }
      const prompt = buildShortStoryPrompt(input)
      let received = false
      const text = await llm.generateStream(prompt.user, {
        systemPrompt: prompt.system,
        signal,
        maxTokens: prompt.maxTokens,
        meta: { feature: prompt.feature },
        onToken: token => {
          if (signal.aborted || !token) return
          received = true
          safeSend(win, 'shortStory:token', { requestId: input.requestId, token, done: false })
        }
      })
      if (signal.aborted) return { ok: false, error: 'LLM_ABORTED' }
      if (!text.trim()) throw new Error('模型未返回内容，请重试')
      if (!received) safeSend(win, 'shortStory:token', { requestId: input.requestId, token: text, done: false })
      safeSend(win, 'shortStory:token', { requestId: input.requestId, token: '', done: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: signal.aborted ? 'LLM_ABORTED' : err instanceof Error ? err.message : String(err) }
    } finally {
      e.sender.removeListener('destroyed', cancelOnClose)
      endStream(input.requestId)
    }
  })
}
