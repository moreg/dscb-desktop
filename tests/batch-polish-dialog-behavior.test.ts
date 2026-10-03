import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChapterMeta, RendererApi, SavedChapterPolishResult } from '../src/shared/types'

// 模拟 hooks 的持久状态，直接操作实际 JSX 上的点击事件，无需新增 DOM 依赖。
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  writes: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [hooks.slots[index] as T, (next: T | ((previous: T) => T)) => {
        hooks.writes++
        hooks.slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.slots[index] as T) : next
      }]
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
      return hooks.slots[index] as { current: T }
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useEffect: (effect: () => void | (() => void)) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) {
        hooks.slots[index] = true
        hooks.effects.push(effect)
      }
    }
  }
})

vi.mock('../src/renderer/src/style-profile/hooks/useProjectStyleData', () => ({
  useProjectStyleData: () => ({ projectData: null, styleProfiles: [], reload: () => {} })
}))

import BatchPolishDialog from '../src/renderer/src/BatchPolishDialog'

const polish = vi.fn<RendererApi['polishChaptersBatch']>()
const abort = vi.fn<RendererApi['abortStream']>()
const refreshed = vi.fn()
const chapter: ChapterMeta = { schemaVersion: 1, updatedAt: '', chapterNumber: 11, title: '', wordCount: 2000, status: 'draft' }
const saved = (chapterNumber: number, error?: string): SavedChapterPolishResult => ({
  chapterNumber, changed: true, error,
  autoDeslop: { status: 'applied', message: '已通过', remainingIssues: 0, repairAttempts: 2 }
})
const failed: SavedChapterPolishResult = {
  chapterNumber: 12, changed: false,
  autoDeslop: { status: 'review_required', message: '核对未通过，已保留原文', remainingIssues: 1,
    repairAttempts: 2, issues: ['原文三天，润色稿五天'] }
}

function render() {
  hooks.cursor = 0
  const tree = BatchPolishDialog({
    projectId: 'project-1', chapters: [chapter], preset: { from: 11, to: 20 },
    onClose: () => {}, onChapterCompleted: refreshed
  })
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) hooks.cleanups.push(cleanup)
  }
  return tree
}

function button(node: React.ReactNode, label: string): React.ReactElement<{ onClick: () => void }> {
  if (React.isValidElement<{ children?: React.ReactNode; onClick: () => void }>(node)) {
    if (node.type === 'button' && node.props.children === label) return node
    for (const child of React.Children.toArray(node.props.children)) {
      try { return button(child, label) } catch { /* 继续搜索同层其它元素 */ }
    }
  }
  throw new Error(`按钮未找到：${label}`)
}

function deferred() {
  let resolve!: (result: Awaited<ReturnType<RendererApi['polishChaptersBatch']>>) => void
  const promise = new Promise<Awaited<ReturnType<RendererApi['polishChaptersBatch']>>>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  hooks.slots = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.cleanups = []
  hooks.writes = 0
  vi.clearAllMocks()
  abort.mockResolvedValue({ ok: true })
  vi.stubGlobal('window', { api: { polishChaptersBatch: polish, abortStream: abort } })
  vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('request-1').mockReturnValueOnce('request-2') })
  vi.stubGlobal('React', React)
})
afterEach(() => vi.unstubAllGlobals())

describe('批量去 AI 味实际交互', () => {
  it('点击开始传入所选范围，实时结果被最终回包合并并展示具体差异', async () => {
    const pending = deferred()
    polish.mockReturnValue(pending.promise)
    button(render(), '开始批量去 AI 味').props.onClick()
    expect(polish.mock.calls[0].slice(0, 4)).toEqual(['project-1', 11, 20, null])
    expect(polish.mock.calls[0][6]).toBe('request-1')
    polish.mock.calls[0][4](11, { ...failed, chapterNumber: 11 })
    polish.mock.calls[0][5]?.(11, 'summary')
    expect(renderToStaticMarkup(render())).toContain('正在更新章节概要')
    pending.resolve({ ok: true, results: [saved(11), failed] })
    await pending.promise
    await Promise.resolve()
    const html = renderToStaticMarkup(render())
    expect(html).toContain('正文已保存')
    expect(html).toContain('原文三天，润色稿五天')
    expect(html).toContain('自动修复 2 次')
    expect(html).toContain('共处理 2 章，已润色 1 章，1 章未通过，已保留原文')
    expect(refreshed).toHaveBeenCalled()
  })

  it('停止中断当前调用，保留已经完成的章节并允许稍后再次处理', async () => {
    const pending = deferred()
    polish.mockReturnValue(pending.promise)
    button(render(), '开始批量去 AI 味').props.onClick()
    polish.mock.calls[0][4](11, saved(11))
    button(render(), '停止').props.onClick()
    expect(abort).toHaveBeenCalledWith('request-1')
    pending.resolve({ ok: false, error: 'AbortError', results: [saved(11)] })
    await pending.promise
    await Promise.resolve()
    const html = renderToStaticMarkup(render())
    expect(html).toContain('已停止，已完成的章节保留')
    expect(html).toContain('第 11 章')
    expect(html).toContain('再次处理所选范围')
    expect(html).not.toContain('AbortError')
  })

  it('卸载时中止请求，迟到的章节事件和最终结果不再修改状态', async () => {
    const pending = deferred()
    polish.mockReturnValue(pending.promise)
    button(render(), '开始批量去 AI 味').props.onClick()
    for (const cleanup of hooks.cleanups) cleanup()
    expect(abort).toHaveBeenCalledWith('request-1')
    const writes = hooks.writes
    polish.mock.calls[0][4](11, saved(11))
    polish.mock.calls[0][5]?.(11, 'saving')
    pending.resolve({ ok: true, results: [saved(11)] })
    await pending.promise
    await Promise.resolve()
    expect(hooks.writes).toBe(writes)
    expect(refreshed).not.toHaveBeenCalled()
  })

  it('开始新批次后忽略前一次请求迟到的章节和进度事件', async () => {
    const first = deferred()
    polish.mockReturnValue(first.promise)
    button(render(), '开始批量去 AI 味').props.onClick()
    const oldCall = polish.mock.calls[0]
    first.resolve({ ok: true, results: [saved(11)] })
    await first.promise
    await Promise.resolve()
    const second = deferred()
    polish.mockReturnValue(second.promise)
    button(render(), '再次处理所选范围').props.onClick()
    expect(polish.mock.calls[1][6]).toBe('request-2')
    const writes = hooks.writes
    const refreshCount = refreshed.mock.calls.length
    oldCall[4](99, saved(99))
    oldCall[5]?.(99, 'saving')
    expect(hooks.writes).toBe(writes)
    expect(refreshed).toHaveBeenCalledTimes(refreshCount)
    second.resolve({ ok: true, results: [saved(11)] })
    await second.promise
    await Promise.resolve()
    expect(renderToStaticMarkup(render())).not.toContain('第 99 章')
  })

  it('正文已保存但概要更新失败时明确显示失败，不误报保留原文', async () => {
    const pending = deferred()
    polish.mockReturnValue(pending.promise)
    button(render(), '开始批量去 AI 味').props.onClick()
    pending.resolve({ ok: true, results: [saved(11, '概要更新失败：模型超时')] })
    await pending.promise
    await Promise.resolve()
    const html = renderToStaticMarkup(render())
    expect(html).toContain('正文已保存；概要更新失败：模型超时')
    expect(html).toContain('1 章正文已保存，后续更新需检查')
    expect(html).not.toContain('1 章未通过，已保留原文')
    expect(html).toContain('class="has-issue"')
  })
})
