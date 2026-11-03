import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanup: new Map<number, () => void>(), writes: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const i = hooks.cursor++
      if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [hooks.slots[i] as T, (next: T | ((v: T) => T)) => { hooks.writes++; hooks.slots[i] = typeof next === 'function' ? (next as (v: T) => T)(hooks.slots[i] as T) : next }]
    },
    useRef: <T,>(initial: T) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i] as { current: T } },
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = hooks.cursor++, prior = hooks.slots[i] as unknown[] | undefined
      if (!prior || deps.some((v, n) => !Object.is(v, prior[n]))) {
        hooks.slots[i] = deps
        hooks.effects.push(() => { hooks.cleanup.get(i)?.(); const stop = fn(); if (stop) hooks.cleanup.set(i, stop); else hooks.cleanup.delete(i) })
      }
    }
  }
})
vi.mock('../src/renderer/src/ChapterAuditPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/ChapterSelfCheckPanel', () => ({ default: () => null }))
import Panel from '../src/renderer/src/ChapterFlowPanel'
const memoryJson = JSON.stringify({ newPlotPoints: [], characterStateChanges: [], collectedForeshadowings: [] })
const summary = { schemaVersion: 1, chapterNumber: 1, sourceHash: 'hash', generatedAt: '', events: [], stateChanges: [], openThreads: [], stale: false }
const api = {
  syncChapterWorkflow: vi.fn(), getChapterSyncContext: vi.fn(), getChapterSummary: vi.fn(), generateChapterSummary: vi.fn(), syncMemoryIndex: vi.fn(),
  checkOutlineStream: vi.fn(), extractMemoryStream: vi.fn(), previewMemoryApply: vi.fn(), previewSettingsApply: vi.fn(),
  listDetailedOutline: vi.fn(), autoResolveOutlineDiffs: vi.fn(), autoApplyExtractedMemory: vi.fn(),
  autoRepairOutlineDifference: vi.fn(), commitOutlineLocalRepair: vi.fn(),
  getRhythm: vi.fn(), evaluateRhythmStream: vi.fn(), generateFigureStream: vi.fn(), applyRhythmEvaluation: vi.fn()
}
const abort = vi.fn(async () => ({ ok: true }))
const stream = (result = { ok: true }) => Object.assign(Promise.resolve(result), { requestId: 'test', abort })
let props: Parameters<typeof Panel>[0]
function render() {
  hooks.cursor = 0
  const tree = Panel(props)
  hooks.effects.splice(0).forEach(effect => effect())
  return tree
}
function find(node: React.ReactNode, match: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>> {
  if (React.isValidElement<Record<string, unknown>>(node)) {
    if (match(node)) return node
    for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
      try { return find(child, match) } catch { /* siblings */ }
    }
  }
  throw new Error('Element not found')
}
const button = (label: string) => find(render(), element => element.type === 'button' && element.props.children === label)
const click = (label: string) => (button(label).props.onClick as () => void)()
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve() }
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanup.clear()
  vi.clearAllMocks()
  vi.stubGlobal('React', React)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { api, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  props = { projectId: 'p', chapterNumber: 1, draft: '林远入城。', auditReport: null, onClose: vi.fn(), onBeginAutoRepairCommit: vi.fn(() => true), onFinishAutoRepairCommit: vi.fn(() => true) }
  abort.mockClear()
  api.syncChapterWorkflow.mockImplementation(() => stream({ saved: { content: props.draft, meta: { chapterNumber: 1 } }, steps: [{ id: 'outline', status: 'handled', elapsedMs: 25 }] } as never))
  api.getChapterSyncContext.mockResolvedValue('same')
  api.getChapterSummary.mockResolvedValue(null)
  api.generateChapterSummary.mockResolvedValue(summary)
  api.syncMemoryIndex.mockResolvedValue({ errors: [] })
  api.checkOutlineStream.mockImplementation((_p, _n, _outline, _draft, token) => { token('[]', true); return stream() })
  api.extractMemoryStream.mockImplementation((_p, _n, token) => { token(memoryJson, true); return stream() })
  api.previewMemoryApply.mockResolvedValue({ diffs: [], applicableCount: 0, confirmCount: 0 })
  api.previewSettingsApply.mockResolvedValue({ diffs: [], autoCount: 0, confirmCount: 0, suggestionCount: 0 })
  api.listDetailedOutline.mockResolvedValue([{ chapterNumber: 1 }])
  api.autoResolveOutlineDiffs.mockResolvedValue([])
  api.autoRepairOutlineDifference.mockResolvedValue({ status: 'unresolved', reason: '需要更多证据。' })
  api.commitOutlineLocalRepair.mockResolvedValue(undefined)
  api.autoApplyExtractedMemory.mockResolvedValue({ memory: { applied: { characters: 0, locations: 0, items: 0, foreshadowings: 0, plotPoints: 0, stateChanges: 0, collected: 0 }, entitiesReviewed: true, errors: [] }, settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }, extraction: { settingsPatches: [], settingsSuggestions: [] } })
  api.getRhythm.mockResolvedValue([{ chapter: 1, emotion: 5 }])
  api.evaluateRhythmStream.mockImplementation((_p, _n, token) => { token('{"actualEmotion":5,"reason":"自然"}', true); return stream() })
  api.generateFigureStream.mockImplementation((_p, _n, token) => { token('{"shouldGenerate":false,"reason":"普通场景"}', true); return stream() })
})
afterEach(() => { for (const cleanup of hooks.cleanup.values()) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('backend chapter sync UI', () => {
  it('delegates ordering and repair to one cancellable backend request', async () => {
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(api.syncChapterWorkflow).toHaveBeenCalledWith('p', 1, props.draft,
      { force: undefined, skipMemory: false, extras: false }, expect.any(Function))
    expect(api.autoRepairOutlineDifference).not.toHaveBeenCalled()
    expect(api.extractMemoryStream).not.toHaveBeenCalled()
    expect(props.onFinishAutoRepairCommit).toHaveBeenCalledWith(props.draft, props.draft)
    expect(renderToStaticMarkup(render())).toContain('已自动处理')
  })
  it('forwards explicit reanalysis instead of managing frontend receipts', async () => {
    render(); await flush(); click('⟳ 一键同步'); await flush()
    click('重新分析全部'); await flush()
    expect(api.syncChapterWorkflow.mock.calls.at(-1)?.[3]).toMatchObject({ force: true })
  })
  it('restores a repair already saved by an otherwise incomplete workflow', async () => {
    api.syncChapterWorkflow.mockImplementation(() => stream({ saved: { content: '林远在城门外等候。' },
      steps: [{ id: 'memory', status: 'failed', elapsedMs: 12 }], error: '记忆核验未完成' } as never))
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(props.onFinishAutoRepairCommit).toHaveBeenCalledWith(props.draft, '林远在城门外等候。')
    expect(renderToStaticMarkup(render())).toContain('记忆核验未完成')
  })
  it('can stop a running backend workflow and always releases the editor', async () => {
    let finish!: (value: unknown) => void
    const pending = Object.assign(new Promise(resolve => { finish = resolve }), { requestId: 'sync', abort })
    api.syncChapterWorkflow.mockReturnValue(pending)
    render(); await flush(); click('⟳ 一键同步'); await flush()
    click('停止同步'); await flush()
    expect(abort).toHaveBeenCalledOnce()
    finish({ steps: [], error: 'LLM_ABORTED' }); await flush()
    expect(props.onFinishAutoRepairCommit).toHaveBeenCalledWith(props.draft, null)
    expect(renderToStaticMarkup(render())).toContain('已取消')
  })
  it('cancels when the chapter changes and does not adopt stale results', async () => {
    let finish!: (value: unknown) => void
    api.syncChapterWorkflow.mockReturnValue(Object.assign(new Promise(resolve => { finish = resolve }), { requestId: 'old', abort }))
    render(); await flush(); click('⟳ 一键同步'); await flush()
    props = { ...props, chapterNumber: 2, draft: '作者的新正文。' }; render(); await flush()
    expect(abort).toHaveBeenCalledOnce()
    finish({ steps: [], saved: { content: '旧请求修复稿。' } }); await flush()
    expect(props.onFinishAutoRepairCommit).not.toHaveBeenCalledWith(expect.anything(), '旧请求修复稿。')
  })
  it('does not start a workflow if the editor snapshot cannot be locked', async () => {
    props.onBeginAutoRepairCommit = () => false
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(api.syncChapterWorkflow).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).toContain('请保存后同步')
  })
  it('releases the editor after a transport error', async () => {
    api.syncChapterWorkflow.mockReturnValue(Object.assign(Promise.reject(new Error('连接中断')), { requestId: 'error', abort }))
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(props.onFinishAutoRepairCommit).toHaveBeenCalledWith(props.draft, null)
    expect(renderToStaticMarkup(render())).toContain('连接中断')
  })
})
