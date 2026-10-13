import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBufferedText } from '../src/shared/buffered-text'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('buffered stream text', () => {
  it('merges a token burst in order into one scheduled update', () => {
    const consume = vi.fn()
    const output = createBufferedText(consume)
    for (let index = 0; index < 1000; index++) output.push(String(index) + ',')
    expect(consume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(40)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0][0]).toBe(Array.from({ length: 1000 }, (_, index) => String(index) + ',').join(''))
  })

  it('flushes completion or cancellation immediately without a duplicate timer update', () => {
    const consume = vi.fn()
    const output = createBufferedText(consume)
    output.push('已收到')
    output.push('的原文')
    output.flush()
    expect(consume).toHaveBeenCalledWith('已收到的原文')
    vi.advanceTimersByTime(100)
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('drops abandoned pending output and can buffer the next run', () => {
    const consume = vi.fn()
    const output = createBufferedText(consume)
    output.push('旧请求')
    output.clear()
    vi.advanceTimersByTime(100)
    expect(consume).not.toHaveBeenCalled()
    output.push('新请求')
    output.flush()
    expect(consume).toHaveBeenCalledWith('新请求')
  })
})
