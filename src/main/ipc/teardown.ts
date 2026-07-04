import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { TeardownService } from '../data/teardown/teardown-service'
import { safeHandle } from './safe-handle'
import { validateInput } from './validation'

const bookNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !/[\\/:*?"<>|]/.test(s), '书名含非法字符')
  .refine((s) => s !== '.' && s !== '..' && !s.includes('..'), '书名不能为 . 或 .. 或包含 ..')

const relPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !s.includes('..'), '路径禁止穿越')

const lengthKindSchema = z.enum(['short', 'long'])

const startTeardownSchema = z.object({
  bookName: bookNameSchema,
  rawText: z.string().min(1).max(2_000_000),
  platform: z.string().max(50).optional(),
  lengthKindOverride: lengthKindSchema.optional()
})

export function registerTeardownIpc(service: TeardownService): void {
  /* 列出全部拆文库条目 */
  safeHandle('teardown:list', async () => service.list())

  /* 启动拆文：落盘原文 + 字数路由 */
  safeHandle('teardown:start', async (_e, input: unknown) => {
    const validated = validateInput(startTeardownSchema, input)
    return service.start(validated)
  })

  /* 运行拆文管道（流式） */
  ipcMain.handle(
    'teardown:run',
    async (e, payload: { bookName: string; lengthKind: 'short' | 'long'; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({
            bookName: bookNameSchema,
            lengthKind: lengthKindSchema,
            requestId: z.string().min(1)
          }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('teardown:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        if (validated.lengthKind === 'long') {
          await service.runLong(validated.bookName, { onToken: send })
        } else {
          await service.runShort(validated.bookName, { onToken: send })
        }
        win?.webContents.send('teardown:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true }
      } catch (err) {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
        win?.webContents.send('teardown:token', { requestId, token: '', done: true })
        throw err
      }
    }
  )

  /* 长篇 Stage 1 停靠后继续 */
  ipcMain.handle(
    'teardown:continue',
    async (e, payload: { bookName: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(
          z.object({ bookName: bookNameSchema, requestId: z.string().min(1) }),
          payload
        )
        const send = (token: string): void => {
          win?.webContents.send('teardown:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        await service.continueLong(validated.bookName, { onToken: send })
        win?.webContents.send('teardown:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true }
      } catch (err) {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
        win?.webContents.send('teardown:token', { requestId, token: '', done: true })
        throw err
      }
    }
  )

  /* 轮询进度 */
  safeHandle('teardown:progress', async (_e, bookName: string) => {
    const validated = validateInput(bookNameSchema, bookName)
    return service.getProgress(validated)
  })

  /* 文件树 */
  safeHandle('teardown:files', async (_e, bookName: string) => {
    const validated = validateInput(bookNameSchema, bookName)
    return service.getFiles(validated)
  })

  /* 读单文件 */
  safeHandle(
    'teardown:readFile',
    async (_e, payload: { bookName: string; path: string }) => {
      const validated = validateInput(
        z.object({ bookName: bookNameSchema, path: relPathSchema }),
        payload
      )
      return service.readFile(validated.bookName, validated.path)
    }
  )

  /* 删除整本书 */
  safeHandle('teardown:delete', async (_e, bookName: string) => {
    const validated = validateInput(bookNameSchema, bookName)
    await service.delete(validated)
  })
}
