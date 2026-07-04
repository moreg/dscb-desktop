import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { ScanService } from '../data/scan/scan-service'
import { safeHandle } from './safe-handle'
import { validateInput } from './validation'

const platformSchema = z.enum([
  'qidian',
  'fanqie',
  'jjwxc',
  'qimao',
  'ciweimao',
  'dz',
  'heiyan',
  'zhihu'
])
const rankTypeSchema = z.string().min(1).max(50).optional()
const fileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('..') && !s.includes('/') && !s.includes('\\'), '非法文件名')

const scanRankSchema = z.object({
  platform: platformSchema,
  rankType: rankTypeSchema,
  userData: z.string().max(200_000).optional()
})

const scanAnalyzeSchema = z.object({
  report: z.string().min(1).max(200_000),
  platform: z.string().min(1).max(50),
  requestId: z.string().min(1)
})

export function registerScanIpc(scanService: ScanService): void {
  /* 采集榜单 */
  safeHandle('scan:rank', async (_e, input: unknown) => {
    const validated = validateInput(scanRankSchema, input)
    return scanService.scan(validated)
  })

  /* 列出报告 */
  safeHandle('scan:list', async () => scanService.listReports())

  /* 读取报告 */
  safeHandle('scan:read', async (_e, fileName: string) => {
    const validated = validateInput(fileNameSchema, fileName)
    return scanService.readReport(validated)
  })

  /* 删除报告 */
  safeHandle('scan:delete', async (_e, fileName: string) => {
    const validated = validateInput(fileNameSchema, fileName)
    await scanService.deleteReport(validated)
  })

  /* LLM 选题决策（流式） */
  ipcMain.handle(
    'scan:analyze',
    async (e, payload: { report: string; platform: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        const validated = validateInput(scanAnalyzeSchema, payload)
        const send = (token: string): void => {
          win?.webContents.send('scan:token', {
            requestId: validated.requestId,
            token,
            done: false
          })
        }
        await scanService.analyzeRank(validated.report, validated.platform, send)
        win?.webContents.send('scan:token', {
          requestId: validated.requestId,
          token: '',
          done: true
        })
        return { ok: true }
      } catch (err) {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
        win?.webContents.send('scan:token', { requestId, token: '', done: true })
        throw err
      }
    }
  )
}
