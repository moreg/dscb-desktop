import { ipcMain, BrowserWindow } from 'electron'
import { WriteService } from '../data/write-service'
import { safeHandle } from './safe-handle'
import type { MemoryExtraction, RhythmEvaluation } from '../../shared/types'
import { validateInput, projectIdSchema, chapterNumberSchema, chapterContentSchema } from './validation'
import { z } from 'zod'

const styleProfileIdSchema = z.string().min(1).max(255).nullable().optional()

export function registerWriteIpc(service: WriteService): void {
  safeHandle(
    'write:auditChapter',
    async (_e, payload: { projectId: string; content: string }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema
        }),
        payload
      )
      return service.auditChapter(validated.projectId, validated.content)
    }
  )

  safeHandle(
    'write:humanizeSegment',
    async (
      _e,
      payload: { projectId: string; snippet: string; violationType: string; chapterNumber?: number }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          snippet: z.string().max(50_000),
          violationType: z.string().min(1).max(100),
          chapterNumber: chapterNumberSchema.optional()
        }),
        payload
      )
      return service.humanizeSegment(
        validated.projectId,
        validated.snippet,
        validated.violationType,
        validated.chapterNumber
      )
    }
  )

  /** LLM 深度审稿（M3）：跑角色崩坏/逻辑漏洞等语义检查，返回 findings 列表 */
  safeHandle(
    'write:runDeepReview',
    async (_e, payload: { projectId: string; content: string; chapterNumber: number }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema,
          chapterNumber: chapterNumberSchema
        }),
        payload
      )
      return service.runDeepReview(validated.projectId, validated.content, validated.chapterNumber)
    }
  )

  /** 结构化审核报告（对齐正文审核技能第 6 步）：聚合算法 + LLM 检查为 10 节报告 */
  safeHandle(
    'write:reviewReport',
    async (_e, payload: { projectId: string; content: string; chapterNumber: number }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          content: chapterContentSchema,
          chapterNumber: chapterNumberSchema
        }),
        payload
      )
      return service.generateReviewReport(
        validated.projectId,
        validated.content,
        validated.chapterNumber
      )
    }
  )

  ipcMain.handle(
    'write:generateChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        styleProfileId?: string | null
        tempContext?: string
        existingText?: string
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            styleProfileId: styleProfileIdSchema,
            tempContext: z.string().optional(),
            existingText: z.string().optional(),
            requestId: z.string().min(1)
          }),
          payload
        )
        await service.generateChapterStream(
          validated.projectId,
          validated.chapterNumber,
          validated.styleProfileId,
          {
            tempContext: validated.tempContext,
            existingText: validated.existingText,
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: validated.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:adjustChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        instruction: string
        styleProfileId?: string | null
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            content: chapterContentSchema,
            instruction: z.string().min(1).max(10_000),
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        await service.adjustChapterStream(
          validated.projectId,
          validated.chapterNumber,
          validated.content,
          validated.instruction,
          validated.styleProfileId,
          {
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: validated.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:reviewChapter',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; content?: string; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.reviewChapterStream(payload.projectId, payload.chapterNumber, payload.content, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /** 正文追问：基于本章正文 + 设定流式回答用户的写作疑问，不修改正文 */
  ipcMain.handle(
    'write:answerChapterQuestion',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        content: string
        question: string
        history: { role: 'user' | 'assistant'; text: string }[]
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            chapterNumber: chapterNumberSchema,
            content: chapterContentSchema,
            question: z.string().min(1).max(10_000),
            history: z
              .array(
                z.object({
                  role: z.enum(['user', 'assistant']),
                  text: z.string().max(20_000)
                })
              )
              .max(40)
              .default([]),
            requestId: z.string().min(1)
          }),
          payload
        )
        await service.answerChapterQuestionStream(
          validated.projectId,
          validated.chapterNumber,
          validated.content,
          validated.question,
          validated.history,
          {
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: validated.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:detectCast',
    async (e, payload: { projectId: string; chapterNumber: number; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.detectCastStream(payload.projectId, payload.chapterNumber, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:detectRelationships',
    async (e, payload: { projectId: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.detectRelationshipsStream(payload.projectId, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:checkOutline',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
        outline: string
        content: string
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.checkOutlineStream(
          payload.projectId,
          payload.chapterNumber,
          payload.outline,
          payload.content,
          {
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: payload.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:extractMemory',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.extractMemoryStream(payload.projectId, payload.chapterNumber, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:applyMemory',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.applyMemory(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:syncChapterAfterWrite',
    async (
      _e,
      payload: { projectId: string; chapterNumber: number; content: string }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema
        }),
        payload
      )
      return service.syncChapterAfterWrite(
        validated.projectId,
        validated.chapterNumber,
        validated.content
      )
    }
  )

  safeHandle(
    'write:previewMemoryApply',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.previewMemoryApply(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:previewSettingsApply',
    async (_e, payload: { projectId: string; extraction: MemoryExtraction }) => {
      return service.previewSettingsApply(payload.projectId, payload.extraction)
    }
  )

  safeHandle(
    'write:applySettingsPatches',
    async (
      _e,
      payload: { projectId: string; extraction: MemoryExtraction; onlyAuto?: boolean }
    ) => {
      return service.applySettingsPatches(payload.projectId, payload.extraction, {
        onlyAuto: payload.onlyAuto
      })
    }
  )

  safeHandle(
    'write:applyNewCharacters',
    async (
      _e,
      payload: { projectId: string; chars: MemoryExtraction['newCharacters'] }
    ) => {
      return service.applyNewCharacters(payload.projectId, payload.chars)
    }
  )

  safeHandle(
    'write:applyNewLocations',
    async (
      _e,
      payload: {
        projectId: string
        locs: MemoryExtraction['newLocations']
        chapterNumber?: number
      }
    ) => {
      return service.applyNewLocations(
        payload.projectId,
        payload.locs,
        payload.chapterNumber
      )
    }
  )

  safeHandle(
    'write:applyNewItems',
    async (
      _e,
      payload: { projectId: string; items: MemoryExtraction['newItems'] }
    ) => {
      return service.applyNewItems(payload.projectId, payload.items)
    }
  )

  safeHandle(
    'write:applyNewForeshadowings',
    async (
      _e,
      payload: { projectId: string; fs: MemoryExtraction['newForeshadowings'] }
    ) => {
      return service.applyNewForeshadowings(payload.projectId, payload.fs)
    }
  )

  /**
   * 解析并应用伏笔回执：把 LLM 在正文末尾写下的【本章伏笔回执】同步到伏笔库。
   * 输入 chapterNumber + receipt JSON；返回实际变更条数 + skipped 列表。
   */
  safeHandle(
    'write:applyForeshadowReceipt',
    async (
      _e,
      payload: {
        projectId: string
        chapterNumber: number
        receipt: { planted?: string[]; collected?: string[] }
      }
    ) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          receipt: z.object({
            planted: z.array(z.string().min(1).max(500)).max(50).optional(),
            collected: z.array(z.string().min(1).max(500)).max(50).optional()
          })
        }),
        payload
      )
      return service.applyForeshadowReceipt(
        validated.projectId,
        validated.chapterNumber,
        validated.receipt
      )
    }
  )

  ipcMain.handle(
    'write:evaluateRhythm',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.evaluateRhythmStream(payload.projectId, payload.chapterNumber, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:applyRhythmEvaluation',
    async (_e, payload: { projectId: string; evaluation: RhythmEvaluation }) => {
      return service.applyRhythmEvaluation(payload.projectId, payload.evaluation)
    }
  )

  ipcMain.handle(
    'write:generateFigure',
    async (
      e,
      payload: { projectId: string; chapterNumber: number; requestId: string }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.generateFigureStream(payload.projectId, payload.chapterNumber, {
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  safeHandle(
    'write:saveFigure',
    async (_e, payload: { projectId: string; fileName: string; html: string }) => {
      return service.saveFigure(payload.projectId, payload.fileName, payload.html)
    }
  )

  ipcMain.handle(
    'write:generateBatch',
    async (
      e,
      payload: {
        projectId: string
        fromChapter: number
        toChapter: number
        styleProfileId?: string | null
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            fromChapter: chapterNumberSchema,
            toChapter: chapterNumberSchema,
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        const progress = await service.generateChaptersBatch(
          validated.projectId,
          validated.fromChapter,
          validated.toChapter,
          (chapter, result) => {
            win?.webContents.send('write:batchChapterComplete', {
              requestId: validated.requestId,
              chapter,
              result
            })
          },
          validated.styleProfileId,
          {
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: validated.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true, progress }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'write:resumeBatch',
    async (
      e,
      payload: {
        projectId: string
        fromChapter: number
        toChapter: number
        styleProfileId?: string | null
        requestId: string
      }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            fromChapter: chapterNumberSchema,
            toChapter: chapterNumberSchema,
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        const progress = await service.resumeChaptersBatch(
          validated.projectId,
          validated.fromChapter,
          validated.toChapter,
          (chapter, result) => {
            win?.webContents.send('write:batchChapterComplete', {
              requestId: validated.requestId,
              chapter,
              result
            })
          },
          validated.styleProfileId,
          {
            onToken: (token) =>
              win?.webContents.send('llm:token', {
                requestId: validated.requestId,
                token,
                done: false
              })
          }
        )
        win?.webContents.send('llm:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true, progress }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
