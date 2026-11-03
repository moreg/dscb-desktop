import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SettingsRepository } from '../src/main/data/settings-repository'
const mocks = vi.hoisted(() => ({ supported: vi.fn(), show: vi.fn(), handlers: new Map<string, () => void>(), options: [] as unknown[] }))
vi.mock('electron', () => ({ Notification: class {
  static isSupported = mocks.supported
  constructor(options: unknown) { mocks.options.push(options) }
  on(name: string, action: () => void) { mocks.handlers.set(name, action); return this }
  show = mocks.show
} }))
import { notifyChapterCompleted } from '../src/main/chapter-notifications'
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const get = vi.fn()
const settings = { get } as unknown as SettingsRepository
const window = { isDestroyed: vi.fn(), isMinimized: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks(); mocks.options = []; mocks.handlers.clear()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  get.mockResolvedValue({ chapterCompletionNotification: true })
  mocks.supported.mockReturnValue(true); mocks.show.mockImplementation(() => undefined)
  window.isDestroyed.mockReturnValue(false); window.isMinimized.mockReturnValue(true)
})
afterEach(() => { mocks.handlers.get('close')?.(); Object.defineProperty(process, 'platform', descriptor) })
it('创建真实系统通知并在点击后唤回原窗口，不包含正文内容', async () => {
  await notifyChapterCompleted(8, window as unknown as BrowserWindow, new AbortController().signal, settings)
  expect(mocks.options).toEqual([{ title: '本轮续写完成', body: '第 8 章本轮续写已完成，点击返回应用查看正文。' }])
  expect(mocks.show).toHaveBeenCalledOnce()
  mocks.handlers.get('click')!()
  expect(window.restore).toHaveBeenCalledOnce(); expect(window.show).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce()
  window.isDestroyed.mockReturnValue(true)
  mocks.handlers.get('click')!()
  expect(window.focus).toHaveBeenCalledOnce()
})
it.each(['disabled', 'unsupported', 'cancelled', 'webPlatform'])('关闭、不支持、取消或非 Windows 时不显示（%s）', async mode => {
  const controller = new AbortController()
  if (mode === 'disabled') get.mockResolvedValue({ chapterCompletionNotification: false })
  if (mode === 'unsupported') mocks.supported.mockReturnValue(false)
  if (mode === 'cancelled') controller.abort()
  if (mode === 'webPlatform') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  await notifyChapterCompleted(1, null, controller.signal, settings)
  expect(mocks.show).not.toHaveBeenCalled()
})
it('读取设置期间取消，不再弹出通知；设置每次重新读取', async () => {
  const controller = new AbortController()
  get.mockImplementationOnce(async () => { controller.abort(); return { chapterCompletionNotification: true } })
  await notifyChapterCompleted(1, null, controller.signal, settings)
  expect(mocks.show).not.toHaveBeenCalled()
  await notifyChapterCompleted(1, null, new AbortController().signal, settings)
  expect(mocks.show).toHaveBeenCalledOnce()
  get.mockResolvedValue({ chapterCompletionNotification: false })
  await notifyChapterCompleted(1, null, new AbortController().signal, settings)
  expect(mocks.show).toHaveBeenCalledOnce()
})
it('读取失败或系统 API 异常不会向写作流程抛错', async () => {
  get.mockRejectedValueOnce(new Error('配置不可读'))
  await expect(notifyChapterCompleted(1, null, new AbortController().signal, settings)).resolves.toBeUndefined()
  mocks.show.mockImplementationOnce(() => { throw new Error('系统 API 不可用') })
  await expect(notifyChapterCompleted(1, null, new AbortController().signal, settings)).resolves.toBeUndefined()
})
