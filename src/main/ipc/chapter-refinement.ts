import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { safeHandle, safeSend } from './safe-handle'
import { projectIdSchema, chapterNumberSchema, chapterContentSchema, validateInput } from './validation'
import { beginStream, endStream } from '../data/stream-abort-registry'
import type { ChapterRefinementService } from '../data/chapter-refinement-service'

const address = z.object({ projectId: projectIdSchema, chapterNumber: chapterNumberSchema })
const inputSchema = address.extend({ content: chapterContentSchema, goal: z.enum(['expression', 'dialogue', 'pacing', 'scene', 'custom']),
  instruction: z.string().max(10000), plan: z.string().max(20000).optional(),
  styleProfileId: z.string().max(255).nullable().optional(),
  selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional() })
export function registerChapterRefinementIpc(service: ChapterRefinementService): void {
  safeHandle('refinement:run', async (event, payload: unknown) => {
    const value = validateInput(z.object({ input: inputSchema, action: z.enum(['plan', 'generate']), requestId: z.string().uuid() }), payload)
    const signal = beginStream(value.requestId)
    try {
      const progress = (stage: string): void => safeSend(BrowserWindow.fromWebContents(event.sender), 'refinement:stage', { requestId: value.requestId, stage })
      if (value.action === 'plan') {
        progress('planning')
        return { ok: true, plan: await service.plan(value.input, signal) }
      }
      return { ok: true, candidate: await service.generate(value.input, signal, progress) }
    } catch (error) { return { ok: false, error: (error as Error).message } }
    finally { endStream(value.requestId) }
  })
  safeHandle('refinement:load', async (_event, payload: unknown) => {
    const value = validateInput(address, payload)
    return service.load(value.projectId, value.chapterNumber)
  })
  safeHandle('refinement:discard', async (_event, payload: unknown) => {
    const value = validateInput(address.extend({ id: z.string().uuid() }), payload)
    await service.discard(value.projectId, value.chapterNumber, value.id)
  })
  safeHandle('refinement:commit', async (_event, payload: unknown) => {
    const value = validateInput(address.extend({ id: z.string().uuid(), currentDraft: chapterContentSchema, undo: z.boolean() }), payload)
    return service.commit(value.projectId, value.chapterNumber, value.id, value.currentDraft, value.undo)
  })
}
