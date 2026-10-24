import { describe, expect, it, vi } from 'vitest'
import { SharedPendingTask } from '../src/main/data/shared-pending-task'

describe('shared pending tasks', () => {
  it('shares concurrent calls only, and retries failures instead of caching them', async () => {
    const tasks = new SharedPendingTask<string>()
    const start = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue('passed')
    const first = tasks.run('same', undefined, start)
    const second = tasks.run('same', undefined, start)
    const result = await Promise.allSettled([first, second])
    expect(result.map(item => item.status)).toEqual(['rejected', 'rejected'])
    expect(start).toHaveBeenCalledOnce()
    await expect(tasks.run('same', undefined, start)).resolves.toBe('passed')
    await expect(tasks.run('same', undefined, start)).resolves.toBe('passed')
    expect(start).toHaveBeenCalledTimes(3)
  })

  it('cancels underlying work only when all callers stop, and starts fresh on retry', async () => {
    const tasks = new SharedPendingTask<string>()
    const one = new AbortController()
    const two = new AbortController()
    let sharedSignal!: AbortSignal
    const start = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('LLM_ABORTED')), { once: true }))
    })
    const first = tasks.run('same', one.signal, start)
    const second = tasks.run('same', two.signal, start)
    const results = Promise.allSettled([first, second])
    await Promise.resolve()
    one.abort()
    expect(sharedSignal.aborted).toBe(false)
    two.abort()
    expect(sharedSignal.aborted).toBe(true)
    const retry = tasks.run('same', undefined, async () => 'new task')
    expect((await results).every(item => item.status === 'rejected')).toBe(true)
    await expect(retry).resolves.toBe('new task')
  })

  it('does not combine different contexts or start work for an already cancelled caller', async () => {
    const tasks = new SharedPendingTask<string>()
    const start = vi.fn().mockResolvedValue('passed')
    const controller = new AbortController()
    controller.abort()
    await expect(tasks.run('same', controller.signal, start)).rejects.toThrow('LLM_ABORTED')
    expect(start).not.toHaveBeenCalled()
    await Promise.all([tasks.run('one', undefined, start), tasks.run('two', undefined, start)])
    expect(start).toHaveBeenCalledTimes(2)
  })
})
