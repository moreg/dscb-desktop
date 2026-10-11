import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FanqieChartService } from '../src/main/data/fanqie-chart/service'
import type { LlmService } from '../src/main/data/llm-service'

const live = process.env.FANQIE_LIVE === '1'

describe.skipIf(!live)('番茄榜单真实抓取', () => {
  it('男频都市日常能还原出可读书名', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fanqie-chart-'))
    const llm = { generateStream: async () => '' } as unknown as LlmService
    const service = new FanqieChartService(dir, llm)
    const messages: string[] = []
    const record = await service.fetch('new_book_male:261', true, (message) => {
      messages.push(message)
      console.log(message)
    })
    console.log(record.books.map((book) => `${book.rank}. ${book.title} / ${book.author}`).join('\n'))
    console.log('partial', record.partialReason, 'readable', record.actualCount)
    expect(record.actualCount).toBeGreaterThanOrEqual(8)
    expect(record.books.filter((book) => book.garbled).length).toBeLessThan(record.books.length / 2)
    await rm(dir, { recursive: true, force: true })
  }, 180_000)
})
