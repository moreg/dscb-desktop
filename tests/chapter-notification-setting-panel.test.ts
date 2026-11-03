import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: [] as (() => void)[] }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual,
    useState: <T,>(initial: T) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial; return [hooks.slots[i], (value: T) => { hooks.slots[i] = value }] },
    useRef: <T,>(initial: T) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i] },
    useEffect: (action: () => void | (() => void)) => { const i = hooks.cursor++; if (!(i in hooks.slots)) { hooks.slots[i] = true; hooks.effects.push(() => { const cleanup = action(); if (cleanup) hooks.cleanups.push(cleanup) }) } }
  }
})
import Setting from '../src/renderer/src/ChapterNotificationSetting'
const get = vi.fn(), set = vi.fn()
function render() { hooks.cursor = 0; const tree = Setting(); hooks.effects.splice(0).forEach(action => action()); return tree }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function toggle(node: React.ReactNode): React.ReactElement<{ checked: boolean; disabled: boolean; onChange: (e: { target: { checked: boolean } }) => void }> {
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    if (node.type === 'input') return node as ReturnType<typeof toggle>
    for (const child of React.Children.toArray(node.props.children)) { try { return toggle(child) } catch { /* continue */ } }
  }
  throw new Error('checkbox not found')
}
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = []
  get.mockReset().mockResolvedValue(false); set.mockReset().mockResolvedValue(true)
  vi.stubGlobal('React', React)
  vi.stubGlobal('window', { api: { getChapterCompletionNotification: get, setChapterCompletionNotification: set } })
})
afterEach(() => { hooks.cleanups.forEach(action => action()); vi.unstubAllGlobals() })
it('读取已保存的关闭状态，切换成功后即时显示开启', async () => {
  expect(toggle(render()).props.disabled).toBe(true)
  await flush()
  expect(toggle(render()).props.checked).toBe(false)
  toggle(render()).props.onChange({ target: { checked: true } })
  expect(toggle(render()).props.disabled).toBe(true)
  await flush()
  expect(set).toHaveBeenCalledWith(true)
  expect(toggle(render()).props.checked).toBe(true)
  expect(renderToStaticMarkup(render())).toContain('已开启续写完成通知')
})
it('保存失败保持旧状态，并显示可重试的错误', async () => {
  render(); await flush()
  set.mockRejectedValue(new Error('磁盘不可写'))
  toggle(render()).props.onChange({ target: { checked: true } }); await flush()
  expect(toggle(render()).props.checked).toBe(false)
  expect(toggle(render()).props.disabled).toBe(false)
  expect(renderToStaticMarkup(render())).toContain('通知设置未更改')
})
