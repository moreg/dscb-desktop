import { BrowserWindow, ipcMain } from 'electron'
import { createBufferedText } from '../../shared/buffered-text'
import { z } from 'zod'
import { FanqieChartService } from '../data/fanqie-chart/service'
import { beginStream, endStream } from '../data/stream-abort-registry'
import { safeHandle, safeSend } from './safe-handle'
import { validateInput } from './validation'

const chartTypeSchema = z
  .string()
  .regex(/^(?:new_book_male|new_book_female|reading_male|reading_female):\d{1,6}$/)

const fetchSchema = z.object({
  chartType: chartTypeSchema,
  force: z.boolean().optional()
})

const analyzeSchema = z.object({
  chartType: chartTypeSchema,
  force: z.boolean().optional(),
  requestId: z.string().min(1).max(80)
})

const ideasSchema = z.object({
  chartType: chartTypeSchema,
  ideaCount: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().min(1).max(20)).max(8).optional(),
  requestId: z.string().min(1).max(80)
})

const bookIdSchema = z.string().min(1).max(50)

const bookDetailSchema = z.object({
  bookId: bookIdSchema,
  knownBook: z.record(z.string(), z.unknown()).optional(),
  force: z.boolean().optional()
})

const chapterContentSchema = z.object({
  bookId: bookIdSchema,
  chapterId: z.string().min(1).max(50),
  knownChapterTitle: z.string().optional(),
  knownBookTitle: z.string().optional(),
  force: z.boolean().optional()
})

const batchFetchSchema = z.object({
  bookId: bookIdSchema,
  limit: z.number().int().min(1).max(500).optional(),
  chapterIds: z.array(z.string().min(1).max(50)).optional(),
  requestId: z.string().min(1).max(80)
})

const exportTxtSchema = z.object({
  bookId: bookIdSchema
})

const multiBatchFetchSchema = z.object({
  books: z
    .array(
      z.object({
        bookId: bookIdSchema,
        title: z.string().max(100).optional()
      })
    )
    .min(1)
    .max(50),
  chapterLimit: z.number().int().min(1).max(50).optional(),
  requestId: z.string().min(1).max(80)
})

export function registerFanqieChartIpc(service: FanqieChartService): void {
  safeHandle('fanqieChart:list', async () => service.list())

  safeHandle('fanqieChart:fetch', async (event, input: unknown) => {
    const validated = validateInput(fetchSchema, input)
    const win = BrowserWindow.fromWebContents(event.sender)
    return service.fetch(validated.chartType, validated.force === true, (message) => {
      safeSend(win, 'fanqieChart:progress', { chartType: validated.chartType, message })
    })
  })

  safeHandle('fanqieChart:delete', async (_event, chartType: unknown) => {
    const validated = validateInput(chartTypeSchema, chartType)
    await service.delete(validated)
  })

  ipcMain.handle('fanqieChart:analyze', async (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const validated = validateInput(analyzeSchema, payload)
    const signal = beginStream(validated.requestId)
    try {
      return await service.analyze(validated.chartType, validated.force === true, (message, analysis) => {
        safeSend(win, 'fanqieChart:progress', { chartType: validated.chartType, message, analysis })
      }, signal)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err), { cause: err })
    } finally {
      endStream(validated.requestId)
    }
  })

  ipcMain.handle('fanqieChart:ideas', async (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const validated = validateInput(ideasSchema, payload)
    const signal = beginStream(validated.requestId)
    const output = createBufferedText(token => {
      safeSend(win, 'fanqieChart:token', { requestId: validated.requestId, token, done: false })
    }, 16)
    let finished = false
    signal.addEventListener('abort', output.flush, { once: true })
    try {
      return await service.generateIdeas(
        validated.chartType,
        validated.ideaCount ?? 3,
        validated.tags ?? [],
        (token) => {
          if (!signal.aborted && !finished) output.push(token)
        },
        signal,
        (message, analysis) => {
          safeSend(win, 'fanqieChart:progress', { chartType: validated.chartType, message, analysis })
        }
      )
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err), { cause: err })
    } finally {
      output.flush()
      finished = true
      output.clear()
      signal.removeEventListener('abort', output.flush)
      endStream(validated.requestId)
      safeSend(win, 'fanqieChart:token', { requestId: validated.requestId, token: '', done: true })
    }
  })

  /* ---- 番茄正文与章节抓取 ---- */
  safeHandle('fanqieNovel:getBookDetail', async (_event, input: unknown) => {
    const validated = validateInput(bookDetailSchema, input)
    return service.getBookDetail(validated.bookId, validated.knownBook as never, validated.force === true)
  })

  safeHandle('fanqieNovel:getChapterContent', async (_event, input: unknown) => {
    const validated = validateInput(chapterContentSchema, input)
    return service.getChapterContent(
      validated.bookId,
      validated.chapterId,
      validated.knownChapterTitle,
      validated.knownBookTitle,
      validated.force === true
    )
  })

  ipcMain.handle('fanqieNovel:fetchChaptersBatch', async (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const validated = validateInput(batchFetchSchema, payload)
    const signal = beginStream(validated.requestId)
    try {
      return await service.fetchChaptersBatch(
        validated.bookId,
        validated.limit ?? 10,
        validated.chapterIds,
        (progress) => {
          safeSend(win, 'fanqieNovel:batchProgress', { requestId: validated.requestId, progress })
        },
        signal
      )
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err), { cause: err })
    } finally {
      endStream(validated.requestId)
    }
  })

  safeHandle('fanqieNovel:exportTxt', async (_event, input: unknown) => {
    const validated = validateInput(exportTxtSchema, input)
    return service.exportBookTxt(validated.bookId)
  })

  safeHandle('fanqieNovel:deleteBookCache', async (_event, input: unknown) => {
    const validated = validateInput(bookIdSchema, input)
    await service.deleteBookCache(validated)
  })

  safeHandle('fanqieNovel:listCachedSummary', async () => {
    return service.listCachedBooksSummary()
  })

  ipcMain.handle('fanqieNovel:fetchMultiBooksBatch', async (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const validated = validateInput(multiBatchFetchSchema, payload)
    const signal = beginStream(validated.requestId)
    try {
      return await service.fetchMultipleBooksChapters(
        validated.books,
        validated.chapterLimit ?? 3,
        (progress) => {
          safeSend(win, 'fanqieNovel:multiBatchProgress', { requestId: validated.requestId, progress })
        },
        signal
      )
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err), { cause: err })
    } finally {
      endStream(validated.requestId)
    }
  })
}
