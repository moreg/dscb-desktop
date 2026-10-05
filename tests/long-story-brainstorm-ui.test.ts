import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi, ProjectMeta, StreamHandleOf } from '../src/shared/types'
import type { LongStoryBrainstormResult, LongStoryIdea } from '../src/shared/long-story-brainstorm'
import { longStoryIdeaBrief } from '../src/shared/long-story-brainstorm'

interface Effect { deps?: readonly unknown[]; cleanup?: () => void; run?: () => void | (() => void) }
interface HookContext { slots: unknown[]; cursor: number; effects: Map<number, Effect>; dirty: boolean; writes: number }
const hooks = vi.hoisted(() => ({ current: null as HookContext | null, contexts: new Map<string, HookContext>() }))

// 直接触发生产组件 JSX 的事件，并保留 hooks、依赖变化和 cleanup，无需 DOM 依赖。
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const context = hooks.current!; const index = context.cursor++
      if (!(index in context.slots)) context.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [context.slots[index] as T, (value: T | ((prior: T) => T)) => {
        const next = typeof value === 'function' ? (value as (prior: T) => T)(context.slots[index] as T) : value
        if (!Object.is(next, context.slots[index])) { context.slots[index] = next; context.dirty = true; context.writes++ }
      }]
    },
    useRef: <T,>(initial: T) => {
      const context = hooks.current!; const index = context.cursor++
      if (!(index in context.slots)) context.slots[index] = { current: initial }
      return context.slots[index] as { current: T }
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const context = hooks.current!; const index = context.cursor++
      const previous = context.effects.get(index)
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps![at]))) {
        context.effects.set(index, { deps, cleanup: previous?.cleanup, run })
      }
    }
  }
})

import BrainstormPage from '../src/renderer/src/BrainstormPage'
import LongStoryBrainstorm from '../src/renderer/src/LongStoryBrainstorm'
import NewProjectDialog from '../src/renderer/src/NewProjectDialog'
import {
  appendLongStoryBrainstormBatch, emptyLongStoryBrainstormRecovery, LONG_STORY_BRAINSTORM_PREFIX,
  readLongStoryBrainstormRecovery, writeLongStoryBrainstormRecovery
} from '../src/renderer/src/long-story-brainstorm-library'
import { BRAINSTORM_PAGE_DRAFT_KEY } from '../src/renderer/src/brainstorm-page-draft'

const brainstorm = vi.fn<RendererApi['brainstormLongStory']>()
const createProject = vi.fn<RendererApi['createProject']>()
const selectDirectory = vi.fn<RendererApi['selectDirectory']>()
let storage: Storage
let key: string
let sequence = 0

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
    getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value) }, removeItem: name => { values.delete(name) } }
}
function render<P>(name: string, component: (props: P) => React.ReactElement, props: P): React.ReactElement {
  let context = hooks.contexts.get(name)
  if (!context) { context = { slots: [], cursor: 0, effects: new Map(), dirty: false, writes: 0 }; hooks.contexts.set(name, context) }
  let tree: React.ReactElement
  let rounds = 0
  do {
    context.cursor = 0; context.dirty = false; hooks.current = context
    tree = component(props)
    for (const effect of context.effects.values()) {
      if (!effect.run) continue
      const run = effect.run; effect.run = undefined
      effect.cleanup?.(); effect.cleanup = run() || undefined
    }
    if (++rounds > 10) throw new Error('组件未能稳定渲染')
  } while (context.dirty)
  hooks.current = null
  return tree
}
function unmount(name: string): void {
  const context = hooks.contexts.get(name)
  for (const effect of context?.effects.values() ?? []) effect.cleanup?.()
  hooks.contexts.delete(name)
}
function content(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(content).join('')
  return React.isValidElement<{ children?: React.ReactNode }>(node) ? content(node.props.children) : ''
}
function elements(node: React.ReactNode, predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>>[] {
  if (!React.isValidElement<Record<string, unknown>>(node)) return []
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children as React.ReactNode).flatMap(child => elements(child, predicate))]
}
function button(tree: React.ReactNode, label: string, index = 0): React.ReactElement<{ onClick: () => unknown; disabled?: boolean }> {
  const match = elements(tree, element => element.type === 'button' && content(element.props.children as React.ReactNode) === label)[index]
  if (!match) throw new Error(`缺少按钮 ${label}`)
  return match as React.ReactElement<{ onClick: () => unknown; disabled?: boolean }>
}
function field(tree: React.ReactNode, name: string): React.ReactElement<{ value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void }> {
  const match = elements(tree, element => element.props.id === name || element.props.placeholder === name)[0]
  if (!match) throw new Error(`缺少字段 ${name}`)
  return match as React.ReactElement<{ value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void }>
}
function child<P>(tree: React.ReactNode, component: (props: P) => React.ReactElement): React.ReactElement<P> {
  const match = elements(tree, element => element.type === component)[0]
  if (!match) throw new Error('缺少子组件')
  return match as React.ReactElement<P>
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function stream() {
  const result = deferred<LongStoryBrainstormResult>(); const stopping = deferred<{ ok: boolean }>()
  const abort = vi.fn().mockReturnValue(stopping.promise)
  const handle: StreamHandleOf<LongStoryBrainstormResult> = Object.assign(result.promise, { requestId: key, abort })
  brainstorm.mockReturnValue(handle)
  return { ...result, stopping, abort, handle }
}
async function settled(): Promise<void> { for (let index = 0; index < 5; index++) await Promise.resolve() }
function idea(number: number): LongStoryIdea {
  return { title: `脑洞${number}`, premise: `杂役${number}能修复废弃功法`, hook: '修好功法得到第一笔报酬', mainLine: '建立独立山门',
    progression: '积累功法与弟子，守住山门', twist: '残篇可以组合', ending: '保有山门和能力' }
}
function seedIdeas(recoveryKey = key): void {
  const recovery = { ...appendLongStoryBrainstormBatch(emptyLongStoryBrainstormRecovery(), [idea(1), idea(2), idea(3)], '', '', 'old-batch'), status: 'completed' as const }
  writeLongStoryBrainstormRecovery(recoveryKey, recovery, storage)
}
function project(id = key): ProjectMeta { return { id, name: '保存后的小说', path: `/projects/${id}`, createdAt: '', lastOpenedAt: '' } }
function brain(props: Partial<React.ComponentProps<typeof LongStoryBrainstorm>> = {}) {
  return render('brain', LongStoryBrainstorm, { genre: '玄幻', recoveryKey: key, onAdopt: () => true, ...props })
}
function page() { return render('page', BrainstormPage, { onOpenProjects: () => {} }) }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hooks.contexts.clear()
  vi.stubGlobal('React', React)
  key = `brainstorm-ui-${++sequence}`; storage = memoryStorage()
  vi.stubGlobal('window', { api: { brainstormLongStory: brainstorm, createProject, selectDirectory }, localStorage: storage,
    crypto: { randomUUID: () => `${key}-batch` }, setTimeout, clearTimeout })
})
afterEach(() => {
  for (const name of [...hooks.contexts.keys()]) unmount(name)
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('长篇脑洞真实组件事件', () => {
  it('传递方向与合并要求；同一事件周期不能重复生成、采用或收藏', () => {
    seedIdeas(); const adopted = vi.fn().mockReturnValue(true)
    let tree = brain({ requirements: '父层要求', sourceBrief: '现有想法', targetChapters: 300, onAdopt: adopted })
    field(tree, `ls-brainstorm-direction-${key}`).props.onChange({ target: { value: '修复废功法' } })
    field(tree, `ls-brainstorm-requirements-${key}`).props.onChange({ target: { value: '前期赚到钱' } })
    tree = brain({ requirements: '父层要求', sourceBrief: '现有想法', targetChapters: 300, onAdopt: adopted })
    stream()
    button(tree, '换一批').props.onClick(); button(tree, '换一批').props.onClick()
    button(tree, '采用这个脑洞').props.onClick(); button(tree, '收藏').props.onClick()
    expect(brainstorm).toHaveBeenCalledTimes(1)
    expect(brainstorm.mock.calls[0][0]).toMatchObject({ direction: '修复废功法', requirements: '父层要求\n前期赚到钱', sourceBrief: '现有想法', targetChapters: 300 })
    expect(adopted).not.toHaveBeenCalled()
    expect(readLongStoryBrainstormRecovery(key, storage).recovery.favorites).toHaveLength(0)
  })

  it('停止同步锁只发一次取消，迟到token与成功回包不能替换恢复文本和旧候选', async () => {
    seedIdeas(); const pending = stream(); const busy = vi.fn()
    button(brain({ onBusyChange: busy }), '换一批').props.onClick()
    brainstorm.mock.calls[0][1]('已经收到的文本', false)
    const tree = brain({ onBusyChange: busy })
    button(tree, '停止生成').props.onClick(); button(tree, '停止生成').props.onClick()
    expect(pending.abort).toHaveBeenCalledTimes(1)
    pending.stopping.resolve({ ok: true }); await settled()
    brainstorm.mock.calls[0][1]('迟到文本', false)
    pending.resolve({ ok: true, ideas: [idea(8), idea(9), idea(10)] }); await settled()
    expect(content(brain({ onBusyChange: busy }))).toContain('生成已停止')
    const recovery = readLongStoryBrainstormRecovery(key, storage).recovery
    expect(recovery.raw).toBe('已经收到的文本'); expect(recovery.ideas.map(item => item.title)).toEqual(['脑洞1', '脑洞2', '脑洞3'])
    expect(busy.mock.calls.map(call => call[0])).toEqual([true, false])
  })

  it('取消失败可以重试，流仍能接收token并完成', async () => {
    const pending = stream(); button(brain(), '生成 3 个脑洞').props.onClick()
    button(brain(), '停止生成').props.onClick(); pending.stopping.resolve({ ok: false }); await settled()
    expect(content(brain())).toContain('暂时无法停止')
    brainstorm.mock.calls[0][1]('继续收到', false)
    pending.resolve({ ok: true, ideas: [idea(1), idea(2), idea(3)] }); await settled()
    expect(content(brain())).toContain('生成完成')
    expect(readLongStoryBrainstormRecovery(key, storage).recovery.raw).toBe('继续收到')
  })

  it('卸载后恢复中断文本，旧组件迟到回包不会污染重新挂载的工作区', async () => {
    seedIdeas(); const pending = stream(); button(brain(), '换一批').props.onClick()
    brainstorm.mock.calls[0][1]('中断前收到', false); unmount('brain')
    expect(pending.abort).toHaveBeenCalledOnce()
    expect(content(brain())).toContain('已恢复上次中断前收到的文本')
    brainstorm.mock.calls[0][1]('卸载后迟到', false)
    pending.resolve({ ok: true, ideas: [idea(9)] }); await settled(); vi.advanceTimersByTime(500)
    expect(readLongStoryBrainstormRecovery(key, storage).recovery.raw).toBe('中断前收到')
    expect(content(brain())).toContain('脑洞1'); expect(content(brain())).not.toContain('脑洞9')
  })

  it('同一组件切换恢复key时隔离输入与流结果', async () => {
    const pending = stream(); button(brain(), '生成 3 个脑洞').props.onClick()
    brainstorm.mock.calls[0][1]('原工作区文本', false)
    const nextKey = `${key}-other`; seedIdeas(nextKey)
    let tree = brain({ recoveryKey: nextKey })
    expect(content(tree)).toContain('脑洞1')
    brainstorm.mock.calls[0][1]('迟到', false); pending.resolve({ ok: true, ideas: [idea(9)] }); await settled()
    tree = brain({ recoveryKey: nextKey }); vi.advanceTimersByTime(500)
    expect(content(tree)).not.toContain('脑洞9')
    expect(readLongStoryBrainstormRecovery(key, storage).recovery.raw).toBe('原工作区文本')
    expect(readLongStoryBrainstormRecovery(nextKey, storage).recovery.raw).toBe('')
  })

  it.each([false, true])('收藏写入失败不会改变当前收藏列表（已有收藏：%s）', favorited => {
    seedIdeas()
    if (favorited) {
      const current = readLongStoryBrainstormRecovery(key, storage).recovery
      writeLongStoryBrainstormRecovery(key, { ...current, favorites: [{ idea: idea(1), source: '', createdAt: '' }] }, storage)
    }
    const tree = brain(); const before = storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)
    storage.setItem = () => { throw new Error('QuotaExceededError') }
    button(tree, favorited ? '取消收藏' : '收藏').props.onClick()
    expect(content(brain())).toContain('收藏更改未能保存')
    expect(content(brain())).toContain(`收藏 · ${favorited ? 1 : 0}`)
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe(before)
  })

  it('损坏空记录经过挂载、节流保存和卸载仍原样保留', () => {
    storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + key, '')
    expect(content(brain())).toContain('原记录保留')
    vi.advanceTimersByTime(500); unmount('brain')
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + key)).toBe('')
  })
})

describe('脑洞采用和新建项目事件', () => {
  it('父页同步锁拒绝正在生成时编辑/采用，也拒绝同周期重复采用；取消后保留条件', () => {
    storage.setItem(BRAINSTORM_PAGE_DRAFT_KEY, JSON.stringify({ version: 1, genre: '玄幻', targetChapters: '300', sourceBrief: '原始想法' }))
    const tree = page(); const generator = child(tree, LongStoryBrainstorm)
    generator.props.onBusyChange?.(true)
    field(tree, 'brainstorm-genre').props.onChange({ target: { value: '都市' } })
    expect(generator.props.onAdopt(idea(1))).toBe(false)
    generator.props.onBusyChange?.(false)
    expect(generator.props.onAdopt(idea(1))).toBe(true)
    expect(generator.props.onAdopt(idea(2))).toBe(false)
    const modal = child(page(), NewProjectDialog)
    expect(modal.props.initialDraft).toMatchObject({ name: '脑洞1', genre: '玄幻', description: longStoryIdeaBrief(idea(1)), targetChapters: 300 })
    modal.props.onClose()
    expect(field(page(), 'brainstorm-reference').props.value).toBe('原始想法')
    expect(child(page(), LongStoryBrainstorm).props.disabled).toBe(false)
  })

  it('预填草稿只初始化一次；失败保留编辑内容，重试与同周期重复提交只创建一次', async () => {
    seedIdeas('new'); const created = vi.fn(); const close = vi.fn()
    const props = { initialDraft: { name: '脑洞1', genre: '玄幻', description: '初始简介', targetChapters: 300 }, brainstormRecoveryKey: 'new', onCreated: created, onClose: close }
    let tree = render('dialog', NewProjectDialog, props)
    field(tree, '《九霄剑尊》').props.onChange({ target: { value: '编辑后的书名' } })
    tree = render('dialog', NewProjectDialog, { ...props, initialDraft: { ...props.initialDraft, name: '外部新草稿' } })
    expect(field(tree, '《九霄剑尊》').props.value).toBe('编辑后的书名')
    const first = deferred<ProjectMeta>(); createProject.mockReturnValueOnce(first.promise)
    const submit = button(tree, '创建'); submit.props.onClick(); submit.props.onClick(); button(tree, '取消').props.onClick()
    expect(createProject).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
    first.reject(new Error('创建失败')); await settled()
    tree = render('dialog', NewProjectDialog, props)
    expect(content(tree)).toContain('创建失败'); expect(field(tree, '《九霄剑尊》').props.value).toBe('编辑后的书名')
    expect(created).not.toHaveBeenCalled()
    createProject.mockResolvedValueOnce(project()); button(tree, '创建').props.onClick(); await settled()
    expect(createProject).toHaveBeenCalledTimes(2); expect(created).toHaveBeenCalledWith(project(), '')
    expect(readLongStoryBrainstormRecovery(`project:${key}`, storage).recovery.ideas).toHaveLength(3)
  })

  it('普通新建不复制脑洞库；损坏脑洞库复制失败仍报告项目已创建', async () => {
    seedIdeas('new'); createProject.mockResolvedValue(project()); const created = vi.fn()
    const props = { initialDraft: { name: '书名', genre: '', description: '' }, onClose: () => {}, onCreated: created }
    button(render('plain', NewProjectDialog, props), '创建').props.onClick(); await settled()
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + `project:${key}`)).toBeNull()
    const corruptKey = `${key}-corrupt`; storage.setItem(LONG_STORY_BRAINSTORM_PREFIX + corruptKey, '')
    button(render('from-corrupt', NewProjectDialog, { ...props, brainstormRecoveryKey: corruptKey }), '创建').props.onClick(); await settled()
    expect(created).toHaveBeenLastCalledWith(project(), expect.stringContaining('脑洞记录仍保留'))
    expect(storage.getItem(LONG_STORY_BRAINSTORM_PREFIX + corruptKey)).toBe('')
  })

  it('选择目录未返回时不能创建或关闭，返回后使用选定目录创建', async () => {
    const choosing = deferred<string | null>(); selectDirectory.mockReturnValue(choosing.promise)
    const close = vi.fn(); const props = { initialDraft: { name: '书名', genre: '', description: '' }, onClose: close, onCreated: () => {} }
    const tree = render('dialog', NewProjectDialog, props)
    button(tree, '选择').props.onClick(); button(tree, '选择').props.onClick()
    button(tree, '创建').props.onClick(); button(tree, '取消').props.onClick()
    expect(selectDirectory).toHaveBeenCalledOnce(); expect(createProject).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
    choosing.resolve('D:/小说'); await settled()
    createProject.mockResolvedValue(project())
    button(render('dialog', NewProjectDialog, props), '创建').props.onClick(); await settled()
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ customPath: 'D:/小说' }))
  })

  it('选择目录失败展示错误并解除锁，卸载后的目录返回不写状态', async () => {
    const choosing = deferred<string | null>(); selectDirectory.mockReturnValueOnce(choosing.promise)
    const props = { initialDraft: { name: '书名', genre: '', description: '' }, onClose: () => {}, onCreated: () => {} }
    button(render('dialog', NewProjectDialog, props), '选择').props.onClick()
    choosing.reject(new Error('无法打开目录对话框')); await settled()
    const tree = render('dialog', NewProjectDialog, props)
    expect(content(tree)).toContain('无法打开目录对话框'); expect(button(tree, '创建').props.disabled).toBe(false)
    const next = deferred<string | null>(); selectDirectory.mockReturnValueOnce(next.promise)
    button(tree, '选择').props.onClick(); render('dialog', NewProjectDialog, props)
    const context = hooks.contexts.get('dialog')!; unmount('dialog'); const writes = context.writes
    next.resolve('D:/迟到目录'); await settled(); expect(context.writes).toBe(writes)
  })

  it('创建回包晚于卸载时不调用旧对话框完成回调', async () => {
    const creating = deferred<ProjectMeta>(); createProject.mockReturnValue(creating.promise)
    const created = vi.fn(); const props = { initialDraft: { name: '书名', genre: '', description: '' }, onClose: () => {}, onCreated: created }
    button(render('dialog', NewProjectDialog, props), '创建').props.onClick()
    const context = hooks.contexts.get('dialog')!; unmount('dialog'); const writes = context.writes
    creating.resolve(project()); await settled()
    expect(created).not.toHaveBeenCalled(); expect(context.writes).toBe(writes)
  })
})
