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
  getChapterSyncContext: vi.fn(), getChapterSummary: vi.fn(), generateChapterSummary: vi.fn(), syncMemoryIndex: vi.fn(),
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
  props = { projectId: 'p', chapterNumber: 1, draft: '林远入城。', auditReport: null, onClose: vi.fn() }
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

describe('one-click incremental sync UI', () => {
  it.each(['outline', 'prose'])('automatically repairs all seven findings across %s commits', async target => {
    vi.useFakeTimers()
    let pending = 7
    api.checkOutlineStream.mockImplementation((_p, _n, _outline, _draft, token) => {
      token(JSON.stringify(Array.from({ length: pending }, (_, i) => ({ type: 1, priority: 'P2',
        outline: `遗漏事件${i}`, actual: '正文未写', suggestion: '按细纲补入正文' }))), true)
      return stream()
    })
    api.autoRepairOutlineDifference.mockImplementation(async () => ({ status: 'candidate', token: 'verified', target,
      content: props.draft + '补入事件。', reason: '按原细纲修复。' }))
    api.commitOutlineLocalRepair.mockImplementation(async () => { pending-- })
    props.onBeginAutoRepairCommit = vi.fn(() => true)
    props.onFinishAutoRepairCommit = vi.fn((_original, content) => {
      if (content) props = { ...props, draft: content }
      return true
    })
    render(); await flush(); click('⟳ 一键同步'); await flush()
    for (let i = 0; i < 20; i++) { render(); await flush(); await vi.advanceTimersByTimeAsync(1); await flush() }
    expect(api.autoRepairOutlineDifference).toHaveBeenCalledTimes(7)
    expect(api.commitOutlineLocalRepair).toHaveBeenCalledTimes(7)
    expect(renderToStaticMarkup(render())).toContain('无差异')
    expect(api.autoApplyExtractedMemory).toHaveBeenCalledTimes(1)
  })
  it('reports stalled repairs and offers a fresh automatic retry for missing prose', async () => {
    vi.useFakeTimers()
    api.checkOutlineStream.mockImplementation((_p, _n, _outline, _draft, token) => {
      token(JSON.stringify([{ type: 1, priority: 'P2', outline: '张伟展示技能', actual: '未展示', suggestion: '补写展示' }]), true)
      return stream()
    })
    api.autoRepairOutlineDifference.mockResolvedValue({ status: 'candidate', token: 'verified', target: 'outline', content: props.draft })
    props.onBeginAutoRepairCommit = vi.fn(() => true)
    props.onFinishAutoRepairCommit = vi.fn(() => true)
    render(); await flush(); click('⟳ 一键同步'); await flush()
    for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(1); await flush() }
    expect(api.commitOutlineLocalRepair).toHaveBeenCalledTimes(3)
    expect(renderToStaticMarkup(render())).toContain('连续 3 次复核后待处理项未减少')
    api.autoRepairOutlineDifference.mockResolvedValue({ status: 'unresolved', reason: '缺少可定位证据。' })
    click('自动修复剩余差异'); await flush()
    expect(api.autoRepairOutlineDifference).toHaveBeenCalledTimes(4)
    expect(renderToStaticMarkup(render())).toContain('缺少可定位证据。')
  })
  it('runs core steps on one snapshot, reuses successful analysis, and supports explicit full reanalysis', async () => {
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(api.extractMemoryStream.mock.calls[0].slice(3)).toEqual([props.draft, true])
    expect(api.evaluateRhythmStream).not.toHaveBeenCalled()
    expect(api.generateFigureStream).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).toContain('已自动处理')
    expect(api.autoApplyExtractedMemory).toHaveBeenCalledTimes(1)
    click('⟳ 一键同步'); await flush()
    expect(api.checkOutlineStream).toHaveBeenCalledTimes(1)
    expect(api.extractMemoryStream).toHaveBeenCalledTimes(1)
    expect(api.generateChapterSummary).toHaveBeenCalledTimes(2)
    expect(api.autoApplyExtractedMemory).toHaveBeenCalledTimes(2)
    click('重新分析全部'); await flush()
    expect(api.extractMemoryStream.mock.calls.at(-1)?.slice(3)).toEqual([props.draft, false])
    expect(api.generateChapterSummary.mock.calls.at(-1)?.[3]).toBe(true)
  })
  it('keeps unresolved outline differences and held memory visible after automatic processing', async () => {
    api.checkOutlineStream.mockImplementation((_p, _n, _outline, _draft, token) => {
      token(JSON.stringify([{ type: 3, priority: 'P2', outline: '计划升级', actual: '实际升级', suggestion: '核对' }]), true)
      return stream()
    })
    api.autoApplyExtractedMemory.mockResolvedValue({ memory: { applied: { characters: 0, locations: 0, items: 0, foreshadowings: 0, plotPoints: 0, stateChanges: 0, collected: 0 }, heldBack: ['缺少正文证据'], entitiesReviewed: false, errors: [] }, settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }, extraction: { settingsPatches: [], settingsSuggestions: [] } })
    render(); await flush(); click('⟳ 一键同步'); await flush()
    const html = renderToStaticMarkup(render())
    expect(api.autoResolveOutlineDiffs).toHaveBeenCalledTimes(1)
    expect(html).toContain('有待处理项')
    expect(html).toContain('缺少正文证据')
  })
  it('refuses unsaved prose before any analysis or index writes', async () => {
    api.getChapterSyncContext.mockRejectedValue(new Error('请先保存正文再同步'))
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(api.syncMemoryIndex).not.toHaveBeenCalled()
    expect(api.extractMemoryStream).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).toContain('请先保存正文再同步')
  })
  it('retries malformed memory output without redoing the valid outline check', async () => {
    api.extractMemoryStream.mockImplementationOnce((_p, _n, token) => { token('{}', true); return stream() })
    render(); await flush(); click('⟳ 一键同步'); await flush()
    expect(renderToStaticMarkup(render())).toContain('失败，可补跑')
    click('⟳ 一键同步'); await flush()
    expect(api.extractMemoryStream).toHaveBeenCalledTimes(2)
    expect(api.checkOutlineStream).toHaveBeenCalledTimes(1)
  })
  it('optional extras use the same snapshot and leave rhythm results awaiting confirmation', async () => {
    render(); await flush()
    const checkbox = find(render(), element => element.type === 'input' && element.props.type === 'checkbox')
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } })
    click('⟳ 一键同步'); await flush()
    expect(api.evaluateRhythmStream.mock.calls[0][3]).toBe(props.draft)
    expect(api.generateFigureStream.mock.calls[0][3]).toBe(props.draft)
    expect(api.applyRhythmEvaluation).not.toHaveBeenCalled()
  })
  it('aborts old streams and does not start old-summary work after switching chapters', async () => {
    let finish!: (value: { ok: boolean }) => void
    api.extractMemoryStream.mockReturnValue(Object.assign(new Promise(resolve => { finish = resolve }), { requestId: 'pending', abort }))
    render(); await flush(); click('⟳ 一键同步'); await flush()
    props = { ...props, chapterNumber: 2, draft: '新章正文。' }; render(); await flush()
    expect(abort).toHaveBeenCalled()
    finish({ ok: false }); await flush()
    expect(api.generateChapterSummary).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).not.toContain('总耗时：')
  })
})
