import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefinementCandidate, RefinementResult } from '../src/shared/chapter-refinement'
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
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = hooks.cursor++, prior = hooks.slots[i] as unknown[] | undefined
      if (!prior || deps.some((v, n) => !Object.is(v, prior[n]))) {
        hooks.slots[i] = deps
        hooks.effects.push(() => { hooks.cleanup.get(i)?.(); const stop = fn(); if (stop) hooks.cleanup.set(i, stop); else hooks.cleanup.delete(i) })
      }
    }
  }
})
import Panel, { clampRefinementPanel } from '../src/renderer/src/ChapterRefinementPanel'
const candidate: RefinementCandidate = { version: 1, id: 'candidate-1', input: { projectId: 'p', chapterNumber: 1, content: '原文句子。', goal: 'expression', instruction: '' },
  baseRevision: '', contextHash: '', candidate: '精修句子。', changes: ['改善表达'], attempts: 1, status: 'ready', updatedAt: '',
  verdict: { passed: true, factsPreserved: true, goalMet: true, assessment: '保留事实', issues: [], evidence: [{ before: '原文句子。', after: '精修句子。', reason: '精修' }] } }
const refine = vi.fn(), load = vi.fn(), commit = vi.fn(), discard = vi.fn(), committed = vi.fn(), abort = vi.fn(), onOpen = vi.fn(), onBusy = vi.fn()
let props: Parameters<typeof Panel>[0]
function render() {
  hooks.cursor = 0
  const tree = Panel(props)
  hooks.effects.splice(0).forEach(effect => effect())
  return tree
}
function button(node: React.ReactNode, text: string): React.ReactElement<{ onClick: () => void; disabled?: boolean }> {
  if (React.isValidElement<{ children?: React.ReactNode; onClick: () => void; disabled?: boolean }>(node)) {
    if (node.type === 'button' && node.props.children === text) return node as ReturnType<typeof button>
    for (const child of React.Children.toArray(node.props.children)) { try { return button(child, text) } catch { /* search siblings */ } }
  }
  throw new Error(`missing button ${text}`)
}
function header(node: React.ReactNode): React.ReactElement<{ onMouseDown?: (event: { target: { closest: (selector: string) => null }; preventDefault: () => void; clientX: number; clientY: number }) => void }> {
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    if (node.type === 'header') return node as ReturnType<typeof header>
    for (const child of React.Children.toArray(node.props.children)) { try { return header(child) } catch { /* search siblings */ } }
  }
  throw new Error('missing header')
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const handle = (result: Promise<RefinementResult>) => Object.assign(result, { requestId: 'request', abort })
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanup.clear(); hooks.writes = 0
  vi.clearAllMocks(); abort.mockResolvedValue({ ok: true }); load.mockResolvedValue(null); commit.mockResolvedValue({ content: candidate.candidate })
  refine.mockReturnValue(handle(Promise.resolve({ ok: true, candidate: structuredClone(candidate) })))
  vi.stubGlobal('React', React)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { api: { refineChapter: refine, loadRefinement: load, commitRefinement: commit, discardRefinement: discard } })
  props = { projectId: 'p', chapterNumber: 1, content: candidate.input.content, selection: { start: 0, end: 4 }, open: true, disabled: false,
    autoTrigger: 0, autoAlreadyPolished: false, onOpen, onClose: vi.fn(), beforeRun: async () => true, onBusyChange: onBusy, onCommitted: committed, onUsage: vi.fn() }
})
afterEach(() => { for (const cleanup of hooks.cleanup.values()) cleanup(); vi.unstubAllGlobals() })
describe('refinement panel behavior', () => {
  it('keeps candidates separate until adoption, passes selected scope and blocks stale drafts', async () => {
    render(); await flush()
    button(render(), '生成精修候选').props.onClick(); await flush()
    expect(refine.mock.calls[0][0].selection).toEqual({ start: 0, end: 4 })
    expect(committed).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(render())).toContain('自动核验通过')
    expect(button(render(), '采用并保存').props.disabled).toBe(false)
    props = { ...props, content: '作者刚改的正文' }
    expect(button(render(), '采用并保存').props.disabled).toBe(true)
    props = { ...props, content: candidate.input.content }
    button(render(), '采用并保存').props.onClick(); await flush()
    expect(commit).toHaveBeenCalledWith('p', 1, 'candidate-1', '原文句子。', false)
    expect(committed).toHaveBeenCalledWith('原文句子。', '精修句子。')
    expect(renderToStaticMarkup(render())).toContain('撤销本次精修')
  })
  it('restores a rejected candidate for comparison without enabling adoption or starting a model call', async () => {
    load.mockResolvedValue({ ...candidate, status: 'rejected', verdict: { ...candidate.verdict, passed: false, issues: ['事实变化'] } })
    render(); await flush()
    const tree = render()
    expect(renderToStaticMarkup(tree)).toContain('事实变化')
    expect(button(tree, '采用并保存').props.disabled).toBe(true)
    expect(button(tree, '采用此条').props.disabled).toBe(false)
    expect(refine).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
  })
  it('lets a rejected candidate be adopted hunk by hunk', async () => {
    load.mockResolvedValue({ ...candidate, status: 'rejected', verdict: { ...candidate.verdict, passed: false, issues: ['事实变化'] } })
    commit.mockResolvedValue({ content: candidate.candidate, candidate: { ...candidate, status: 'accepted' } })
    render(); await flush()
    button(render(), '采用此条').props.onClick(); await flush()
    expect(commit).toHaveBeenCalledWith('p', 1, 'candidate-1', '原文句子。', false, 0)
    expect(committed).toHaveBeenCalledWith('原文句子。', '精修句子。')
  })
  it('cancels on unmount and ignores late results without writing to the next chapter UI', async () => {
    let finish!: (value: RefinementResult) => void
    refine.mockReturnValue(handle(new Promise(resolve => { finish = resolve })))
    render(); await flush(); button(render(), '生成精修候选').props.onClick(); await flush()
    button(render(), '停止').props.onClick(); expect(abort).toHaveBeenCalled()
    for (const cleanup of hooks.cleanup.values()) cleanup()
    const writes = hooks.writes
    finish({ ok: true, candidate }); await flush()
    expect(hooks.writes).toBe(writes); expect(committed).not.toHaveBeenCalled()
  })
  it('automatic candidates are opt-in and successful existing expression checks are not rerun', async () => {
    render(); await flush(); props = { ...props, autoTrigger: 1 }; render(); await flush()
    expect(refine).not.toHaveBeenCalled()
    for (const cleanup of hooks.cleanup.values()) cleanup()
    hooks.slots = []; hooks.cleanup.clear()
    vi.stubGlobal('localStorage', { getItem: () => '1', setItem: vi.fn() })
    props = { ...props, autoTrigger: 0, autoAlreadyPolished: true }; render(); await flush()
    props = { ...props, autoTrigger: 1 }; render(); await flush()
    expect(refine).not.toHaveBeenCalled()
    props = { ...props, autoTrigger: 2, autoAlreadyPolished: false }; render(); await flush()
    expect(refine).toHaveBeenCalledOnce(); expect(committed).not.toHaveBeenCalled()
    expect(refine.mock.calls[0][0].selection).toBeUndefined()
  })
  it('surfaces a commit conflict while retaining the candidate and original editor content', async () => {
    load.mockResolvedValue(candidate); commit.mockRejectedValue(new Error('磁盘正文已变化'))
    render(); await flush(); button(render(), '采用并保存').props.onClick(); await flush()
    expect(renderToStaticMarkup(render())).toContain('磁盘正文已变化')
    expect(committed).not.toHaveBeenCalled()
  })
  it('keeps the floating panel inside the viewport', () => {
    expect(clampRefinementPanel(-40, -12, 720, 900, { width: 1280, height: 800 })).toEqual({
      left: 8, top: 8, width: 720, height: 784
    })
    expect(clampRefinementPanel(4000, 4000, 720, 400, { width: 1000, height: 600 })).toMatchObject({
      left: 272, top: 520, width: 720, height: 400
    })
  })
  it('drags from the title bar without starting when the handle has no layout yet', () => {
    const node = header(render())
    expect(typeof node.props.onMouseDown).toBe('function')
    node.props.onMouseDown?.({ target: { closest: () => null }, preventDefault() {}, clientX: 40, clientY: 20 })
    expect(renderToStaticMarkup(render())).toContain('refinement-panel')
  })
  it('adopts a single displayed hunk without taking the rest of the candidate', async () => {
    const source = '甲段。\n\n乙段。\n\n丙段。'
    const rewritten = '甲段改。\n\n乙段。\n\n丙段改。'
    const merged = '甲段改。\n\n乙段。\n\n丙段。'
    const multi: RefinementCandidate = {
      ...candidate,
      input: { ...candidate.input, content: source },
      candidate: rewritten,
      verdict: { ...candidate.verdict!, evidence: [{ before: '甲段。', after: '甲段改。', reason: '精修' }] }
    }
    load.mockResolvedValue(multi)
    commit.mockResolvedValue({ content: merged, candidate: { ...multi, adoptedContent: merged } })
    props = { ...props, content: source }
    render(); await flush()
    expect(renderToStaticMarkup(render())).toContain('采用此条')
    expect(button(render(), '采用此条').props.disabled).toBe(false)
    button(render(), '采用此条').props.onClick(); await flush()
    expect(commit).toHaveBeenCalledWith('p', 1, 'candidate-1', source, false, 0)
    expect(committed).toHaveBeenCalledWith(source, merged)
    expect(renderToStaticMarkup(render())).toContain('已采用第 1 条并保存')
    expect(renderToStaticMarkup(render())).toContain('采用剩余并保存')
  })
})
