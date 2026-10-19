import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChapterMeta, ChapterSummaryBatchResult, RendererApi } from '../src/shared/types'
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, cleanups: [] as (() => void)[] }))
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const i = hooks.cursor++
    if (!(i in hooks.slots)) hooks.slots[i] = initial
    return [hooks.slots[i], (next: T | ((old: T) => T)) => { hooks.slots[i] = typeof next === 'function' ? (next as (old: T) => T)(hooks.slots[i] as T) : next }]
  },
  useRef: <T,>(initial: T) => {
    const i = hooks.cursor++
    if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }
    return hooks.slots[i]
  },
  useEffect: (effect: () => (() => void)) => {
    const i = hooks.cursor++
    if (!(i in hooks.slots)) { hooks.slots[i] = true; hooks.cleanups.push(effect()) }
  }
}))
import BatchSummaryDialog from '../src/renderer/src/BatchSummaryDialog'
const generate = vi.fn<RendererApi['regenerateSummariesBatch']>()
const abort = vi.fn<RendererApi['abortStream']>()
const chapters = [1, 201].map((n): ChapterMeta => ({ schemaVersion: 1, chapterNumber: n, title: '', wordCount: 2000, status: 'draft', updatedAt: '' }))
function render() { hooks.cursor = 0; return BatchSummaryDialog({ projectId: 'p', chapters, onClose: () => {} }) }
function button(node: React.ReactNode, label: string): React.ReactElement<{ onClick: () => void; disabled?: boolean }> {
  if (React.isValidElement<{ children?: React.ReactNode; onClick: () => void }>(node)) {
    if (node.type === 'button' && node.props.children === label) return node
    for (const child of React.Children.toArray(node.props.children)) {
      try { return button(child, label) } catch { /* Continue through siblings. */ }
    }
  }
  throw new Error(`未找到按钮 ${label}`)
}
function deferred() {
  let resolve!: (value: ChapterSummaryBatchResult) => void
  const promise = new Promise<ChapterSummaryBatchResult>((done) => { resolve = done })
  return { promise, resolve }
}
describe('批量概要界面操作', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    hooks.slots = []; hooks.cursor = 0; hooks.cleanups = []
    generate.mockReset(); abort.mockReset().mockResolvedValue({ ok: true })
    vi.stubGlobal('React', React)
    vi.stubGlobal('window', { api: { regenerateSummariesBatch: generate, abortStream: abort } })
    vi.stubGlobal('crypto', { randomUUID: () => 'summary-request' })
  })
  it('默认选择全书，显示进度、逐章失败与继续补齐，继续时携带成功正文指纹', async () => {
    const pending = deferred(); generate.mockReturnValueOnce(pending.promise)
    button(render(), '开始批量生成概要').props.onClick()
    expect(generate.mock.calls[0][1]).toMatchObject({ fromChapter: 1, toChapter: 201, onlyMissing: false })
    expect(button(render(), '关闭').props.disabled).toBe(true)
    const success = { chapterNumber: 1, status: 'generated' as const, sourceHash: 'a'.repeat(64), continuityCount: 3 }
    generate.mock.calls[0][2](success)
    generate.mock.calls[0][3]?.({ chapter: 201, index: 2, total: 2 })
    expect(renderToStaticMarkup(render())).toContain('正在处理第 201 章')
    pending.resolve({ ok: false, results: [success, { chapterNumber: 201, status: 'failed', error: '超时' }], error: '部分失败' })
    await pending.promise; await Promise.resolve()
    expect(renderToStaticMarkup(render())).toContain('1 章已补齐，1 章失败')
    generate.mockResolvedValue({ ok: true, results: [] })
    button(render(), '继续补齐未完成章节').props.onClick()
    expect(generate.mock.calls[1][1].completed).toEqual([{ chapterNumber: 1, sourceHash: success.sourceHash }])
  })
  it('停止和卸载时取消请求，卸载后的回包不再更新界面', async () => {
    const pending = deferred(); generate.mockReturnValue(pending.promise)
    button(render(), '开始批量生成概要').props.onClick()
    button(render(), '停止').props.onClick()
    expect(abort).toHaveBeenCalledWith('summary-request')
    pending.resolve({ ok: false, stopped: true, results: [] })
    await pending.promise; await Promise.resolve()
    expect(renderToStaticMarkup(render())).toContain('已停止')
    const next = deferred(); generate.mockReturnValue(next.promise)
    button(render(), '继续补齐未完成章节').props.onClick()
    for (const cleanup of hooks.cleanups) cleanup()
    const before = JSON.stringify(hooks.slots)
    generate.mock.calls[1][2]({ chapterNumber: 1, status: 'generated' })
    next.resolve({ ok: true, results: [] })
    await next.promise; await Promise.resolve()
    expect(JSON.stringify(hooks.slots)).toBe(before)
    expect(abort).toHaveBeenCalledTimes(2)
  })
})
