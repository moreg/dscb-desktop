import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FanqieBookDetail } from '../src/shared/fanqie-chart'

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanup: new Map<number, () => void>(), writes: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const memo = <T,>(fn: () => T, deps: unknown[]) => {
    const i = hooks.cursor++, prior = hooks.slots[i] as { value: T; deps: unknown[] } | undefined
    if (!prior || deps.some((v, n) => !Object.is(v, prior.deps[n]))) hooks.slots[i] = { value: fn(), deps }
    return (hooks.slots[i] as { value: T }).value
  }
  return { ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const i = hooks.cursor++
      if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [hooks.slots[i], (next: T) => { hooks.writes++; hooks.slots[i] = next }]
    },
    useRef: <T,>(initial: T) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i] },
    useMemo: memo,
    useCallback: <T,>(fn: T, deps: unknown[]) => memo(() => fn, deps),
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = hooks.cursor++, prior = hooks.slots[i] as unknown[] | undefined
      if (!prior || deps.some((v, n) => !Object.is(v, prior[n]))) {
        hooks.slots[i] = deps
        hooks.effects.push(() => { hooks.cleanup.get(i)?.(); const stop = fn(); if (stop) hooks.cleanup.set(i, stop) })
      }
    }
  }
})
import Modal from '../src/renderer/src/FanqieBookDetailModal'

const load = vi.fn(), fetchBatch = vi.fn()
let bookId: string
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function detail(id: string, chapters = false): FanqieBookDetail {
  return { bookId: id, title: `书名${id}`, author: '', cover: '', intro: '', genre: '', wordCount: '', readCount: '', status: '', tags: [],
    chapters: chapters ? [{ id: 'chapter', title: '首章', index: 1, needPay: false, isLocked: false }] : [], cachedChapterIds: [], updatedAt: '' }
}
function render() {
  hooks.cursor = 0
  const tree = Modal({ bookId, onClose: () => {} })
  hooks.effects.splice(0).forEach(effect => effect())
  return tree
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function unmount() { for (const cleanup of hooks.cleanup.values()) cleanup(); hooks.cleanup.clear() }
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanup.clear(); hooks.writes = 0
  load.mockReset(); fetchBatch.mockReset(); bookId = 'A'
  vi.stubGlobal('React', React)
  vi.stubGlobal('window', { api: { getFanqieBookDetail: load, fetchFanqieChaptersBatch: fetchBatch } })
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

it('ignores a late response from the previous book without starting its prefetch', async () => {
  const first = deferred<FanqieBookDetail>()
  load.mockReturnValueOnce(first.promise).mockResolvedValueOnce(detail('B'))
  render(); bookId = 'B'; render(); await flush()
  first.resolve(detail('A', true)); await flush()
  expect(renderToStaticMarkup(render())).toContain('书名B')
  expect(renderToStaticMarkup(render())).not.toContain('书名A')
  expect(fetchBatch).not.toHaveBeenCalled()
  expect(load).toHaveBeenCalledTimes(2)
})

it('does not start downloads after the modal has been closed', async () => {
  const pending = deferred<FanqieBookDetail>()
  load.mockReturnValueOnce(pending.promise)
  render(); unmount()
  const writes = hooks.writes
  pending.resolve(detail('A', true)); await flush()
  expect(hooks.writes).toBe(writes)
  expect(fetchBatch).not.toHaveBeenCalled()
})

it('aborts an active prefetch and ignores its late completion after closing', async () => {
  const pending = deferred<unknown>()
  const abort = vi.fn()
  load.mockResolvedValue(detail('A', true))
  fetchBatch.mockReturnValue(Object.assign(pending.promise, { abort }))
  render(); await flush(); unmount()
  const writes = hooks.writes
  pending.resolve({}); await flush()
  expect(abort).toHaveBeenCalledOnce()
  expect(hooks.writes).toBe(writes)
  expect(load).toHaveBeenCalledOnce()
})
