import { describe, expect, it, vi } from 'vitest'
import { AsyncLimiter } from '../src/main/data/async-limiter'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('AsyncLimiter', () => {
  it('shares bounded capacity and starts the next task after a slot is released', async () => {
    const limiter = new AsyncLimiter(2)
    const gates = Array.from({ length: 4 }, deferred)
    const started: number[] = []
    let active = 0
    let peak = 0
    const tasks = gates.map((gate, index) => limiter.run(async () => {
      started.push(index)
      peak = Math.max(peak, ++active)
      await gate.promise
      active--
    }))
    try {
      await vi.waitFor(() => expect(started).toEqual([0, 1]))
      gates[0].resolve()
      await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
      expect(peak).toBe(2)
    } finally {
      gates.forEach(gate => gate.resolve())
      await Promise.all(tasks)
    }
    expect(peak).toBe(2)
  })

  it('removes cancelled waiting tasks without invoking them', async () => {
    const limiter = new AsyncLimiter(1)
    const gate = deferred()
    const first = limiter.run(() => gate.promise)
    const controller = new AbortController()
    const action = vi.fn(async () => {})
    const queued = limiter.run(action, controller.signal)
    const rejection = expect(queued).rejects.toThrow('操作已取消')
    controller.abort()
    await rejection
    gate.resolve()
    await first
    await limiter.run(async () => {})
    expect(action).not.toHaveBeenCalled()
  })

  it('releases capacity after failure and rejects already-aborted work', async () => {
    const limiter = new AsyncLimiter(1)
    await expect(limiter.run(async () => { throw new Error('模型故障') })).rejects.toThrow('模型故障')
    expect(await limiter.run(async () => '恢复')).toBe('恢复')
    const controller = new AbortController()
    controller.abort()
    const action = vi.fn(async () => '不应调用')
    await expect(limiter.run(action, controller.signal)).rejects.toThrow('操作已取消')
    expect(action).not.toHaveBeenCalled()
  })
})
