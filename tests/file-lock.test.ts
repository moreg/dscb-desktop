import { describe, it, expect } from 'vitest'
import { withFileLock } from '../src/main/data/file-lock'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('withFileLock', () => {
  it('serializes concurrent runs on same key', async () => {
    const order: string[] = []
    const p1 = withFileLock('k', async () => {
      order.push('1-start')
      await delay(20)
      order.push('1-end')
    })
    const p2 = withFileLock('k', async () => {
      order.push('2-start')
      order.push('2-end')
    })
    await Promise.all([p1, p2])
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end'])
  })

  it('runs different keys in parallel', async () => {
    const order: string[] = []
    const start = Date.now()
    await Promise.all([
      withFileLock('a', async () => {
        order.push('a-start')
        await delay(30)
        order.push('a-end')
      }),
      withFileLock('b', async () => {
        order.push('b-start')
        await delay(30)
        order.push('b-end')
      })
    ])
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(50)
    expect(order).toContain('a-start')
    expect(order).toContain('b-start')
  })

  it('releases lock even if fn throws', async () => {
    await expect(withFileLock('err', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const order: string[] = []
    await withFileLock('err', async () => {
      order.push('after-error')
    })
    expect(order).toEqual(['after-error'])
  })
})
