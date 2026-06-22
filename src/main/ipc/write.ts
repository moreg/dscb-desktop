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

  ipcMain.handle(
    'write:generateChapter',
    async (
      e,
      payload: {
        projectId: string
        chapterNumber: number
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
            styleProfileId: styleProfileIdSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        await service.generateChapterStream(
          validated.projectId,
          validated.chapterNumber,
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
    async (e, payload: { projectId: string; chapterNumber: number; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.reviewChapterStream(payload.projectId, payload.chapterNumber, {
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
      payload: { projectId: string; locs: MemoryExtraction['newLocations'] }
    ) => {
      return service.applyNewLocations(payload.projectId, payload.locs)
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
