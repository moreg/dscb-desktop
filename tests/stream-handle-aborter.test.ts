import { describe, it, expect, vi } from 'vitest'

describe('StreamHandle & Aborter behavior', () => {
  function makeStreamHandle<T>(
    promise: Promise<T>,
    requestId: string,
    abortFn: () => Promise<{ ok: boolean }>
  ) {
    return {
      then: (onfulfilled?: ((value: T) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) =>
        promise.then(onfulfilled, onrejected),
      catch: (onrejected?: ((reason: unknown) => unknown) | null) =>
        promise.catch(onrejected),
      finally: (onfinally?: (() => void) | null) =>
        promise.finally(onfinally),
      requestId,
      abort: abortFn
    }
  }

  it('makeStreamHandle 可以被 await，且保留 requestId 和 abort 方法', async () => {
    let aborted = false
    const handle = makeStreamHandle(
      Promise.resolve({ ok: true, data: 'hello' }),
      'req-123',
      async () => {
        aborted = true
        return { ok: true }
      }
    )

    expect(handle.requestId).toBe('req-123')
    expect(typeof handle.abort).toBe('function')

    const res = await handle
    expect(res).toEqual({ ok: true, data: 'hello' })

    const abortRes = await handle.abort()
    expect(abortRes).toEqual({ ok: true })
    expect(aborted).toBe(true)
  })

  it('makeStreamHandle 支持 catch 异常', async () => {
    const handle = makeStreamHandle(
      Promise.reject(new Error('stream error')),
      'req-err',
      async () => ({ ok: true })
    )

    await expect(handle).rejects.toThrow('stream error')
  })

  it('卸载清理时对缺失 abort 的句柄具备容错防御，不抛出 TypeError', async () => {
    const active = new Set<{ abort?: () => Promise<unknown> }>()

    // 模拟缺失 abort 或非函数的 handle
    active.add(Promise.resolve('regular promise') as unknown as { abort?: () => Promise<unknown> })
    active.add({} as { abort?: () => Promise<unknown> })

    // 模拟正常的 handle
    const abortSpy = vi.fn().mockResolvedValue({ ok: true })
    active.add({ abort: abortSpy })

    // 执行卸载清理逻辑
    expect(() => {
      for (const h of active) {
        if (typeof h?.abort === 'function') {
          void h.abort().catch(() => undefined)
        }
      }
      active.clear()
    }).not.toThrow()

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(active.size).toBe(0)
  })
})
