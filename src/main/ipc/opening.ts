import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { OpeningService } from '../data/opening-service'
import { validateInput, projectIdSchema } from './validation'

const brainDumpSchema = z.string().min(1).max(20_000)
const coreSettingsSchema = z.string().min(1).max(50_000)
const volumeOutlineSchema = z.string().min(1).max(200_000)
const chaptersMdSchema = z.string().min(1).max(200_000)
// 开书细纲范围与章号上界大于通用 chapterNumberSchema，按本服务约定保持独立定义
const chapterNumberSchema = z.number().int().min(1).max(9999)
const countSchema = z.number().int().min(1).max(30)
const requestIdSchema = z.string().min(1)

export function registerOpeningIpc(service: OpeningService): void {
  /* Step 1：脑洞 → 核心设定表（流式） */
  ipcMain.handle(
    'opening:coreSettings',
    async (e, payload: { projectId: string; brainDump: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            brainDump: brainDumpSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const markdown = await service.generateCoreSettings(
          validated.projectId,
          validated.brainDump,
          { onToken: send }
        )
        win?.webContents.send('opening:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* Step 2：核心设定 → 卷级大纲（流式） */
  ipcMain.handle(
    'opening:volumeOutline',
    async (e, payload: { projectId: string; coreSettings: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            coreSettings: coreSettingsSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const markdown = await service.generateVolumeOutline(
          validated.projectId,
          validated.coreSettings,
          { onToken: send }
        )
        win?.webContents.send('opening:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* 手动续写：核心设定 */
  ipcMain.handle(
    'opening:continueCoreSettings',
    async (e, payload: { projectId: string; brainDump: string; partial: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            brainDump: brainDumpSchema,
            partial: coreSettingsSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', { requestId: validated.requestId, token, done: false })
        }
        const markdown = await service.continueCoreSettings(
          validated.projectId, validated.brainDump, validated.partial, { onToken: send }
        )
        win?.webContents.send('opening:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* 手动续写：卷级大纲 */
  ipcMain.handle(
    'opening:continueVolumeOutline',
    async (e, payload: { projectId: string; coreSettings: string; partial: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            coreSettings: coreSettingsSchema,
            partial: volumeOutlineSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', { requestId: validated.requestId, token, done: false })
        }
        const markdown = await service.continueVolumeOutline(
          validated.projectId, validated.coreSettings, validated.partial, { onToken: send }
        )
        win?.webContents.send('opening:token', { requestId: validated.requestId, token: '', done: true })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* Step 3：核心设定 + 卷级大纲 → 前 N 章细纲（流式） */
  ipcMain.handle(
    'opening:firstChapters',
    async (e, payload: {
      projectId: string
      coreSettings: string
      volumeOutline: string
      fromChapter: number
      count: number
      requestId: string
    }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            coreSettings: coreSettingsSchema,
            volumeOutline: volumeOutlineSchema,
            fromChapter: chapterNumberSchema,
            count: countSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const markdown = await service.generateFirstChapters(
          validated.projectId,
          validated.coreSettings,
          validated.volumeOutline,
          validated.fromChapter,
          validated.count,
          { onToken: send }
        )
        win?.webContents.send('opening:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* 手动续写：前 N 章细纲 */
  ipcMain.handle(
    'opening:continueFirstChapters',
    async (e, payload: {
      projectId: string
      coreSettings: string
      volumeOutline: string
      fromChapter: number
      count: number
      partial: string
      requestId: string
    }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      try {
        const validated = validateInput(
          z.object({
            projectId: projectIdSchema,
            coreSettings: coreSettingsSchema,
            volumeOutline: volumeOutlineSchema,
            fromChapter: chapterNumberSchema,
            count: countSchema,
            partial: chaptersMdSchema,
            requestId: requestIdSchema
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('opening:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        const markdown = await service.continueFirstChapters(
          validated.projectId,
          validated.coreSettings,
          validated.volumeOutline,
          validated.fromChapter,
          validated.count,
          validated.partial,
          { onToken: send }
        )
        win?.webContents.send('opening:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true, markdown }
      } catch (err) {
        win?.webContents.send('opening:token', { requestId, token: '', done: true })
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /* Step 4：落盘 */
  const persistSchema = z.object({
    projectId: projectIdSchema,
    coreSettings: coreSettingsSchema,
    volumeOutline: volumeOutlineSchema,
    chaptersMd: chaptersMdSchema.optional(),
    fromChapter: chapterNumberSchema.optional()
  })

  ipcMain.handle('opening:persist', async (_e, payload: unknown) => {
    const validated = validateInput(persistSchema, payload)
    return service.persistOpening(
      validated.projectId,
      validated.coreSettings,
      validated.volumeOutline,
      validated.chaptersMd,
      validated.fromChapter
    )
  })

  /* 节奏图谱预览：大纲确认后、细纲生成前生成 HTML（不落盘） */
  const generateRhythmSchema = z.object({
    projectId: projectIdSchema,
    volumeOutline: volumeOutlineSchema
  })

  ipcMain.handle('opening:generateRhythm', async (_e, payload: unknown) => {
    const validated = validateInput(generateRhythmSchema, payload)
    try {
      const html = await service.generateRhythmHtml(
        validated.projectId,
        validated.volumeOutline
      )
      return { ok: true as const, html }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
}
