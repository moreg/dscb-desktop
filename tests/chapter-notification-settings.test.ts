import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { registerSettingsIpc } from '../src/main/ipc/settings'
import { createRendererApi } from '../src/preload/api'
const handlers = new Map<string, (e: unknown, payload?: unknown) => Promise<unknown>>()
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/notification-settings' }, dialog: {} }))
vi.mock('../src/main/ipc/safe-handle', () => ({ safeHandle: (name: string, handler: (e: unknown, payload?: unknown) => Promise<unknown>) => handlers.set(name, handler) }))
let root: string, file: string, repo: SettingsRepository
beforeEach(async () => {
  handlers.clear()
  root = await mkdtemp(join(tmpdir(), 'chapter-notification-settings-'))
  file = join(root, 'settings.json'); repo = new SettingsRepository(file)
  registerSettingsIpc(repo, root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('旧配置默认开启，关闭后重启仍保持关闭，与自动记忆设置独立', async () => {
  await writeFile(file, JSON.stringify({ autoPostWritePipeline: 'off' }))
  expect(await handlers.get('settings:getChapterCompletionNotification')!({})).toBe(true)
  expect(await handlers.get('settings:setChapterCompletionNotification')!({}, false)).toBe(false)
  expect((await new SettingsRepository(file).get()).chapterCompletionNotification).toBe(false)
  expect((await repo.get()).autoPostWritePipeline).toBe('off')
  await repo.update({ autoPostWritePipeline: 'full' })
  expect((await repo.get()).chapterCompletionNotification).toBe(false)
  expect(await handlers.get('settings:setChapterCompletionNotification')!({}, true)).toBe(true)
  expect(JSON.parse(await readFile(file, 'utf8')).chapterCompletionNotification).toBe(true)
})
it('非布尔开关值被拒绝，保留原配置', async () => {
  await repo.update({ chapterCompletionNotification: false })
  await expect(handlers.get('settings:setChapterCompletionNotification')!({}, 'true')).rejects.toThrow()
  expect((await repo.get()).chapterCompletionNotification).toBe(false)
})
it('预加载接口读写相同设置通道', async () => {
  const invoke = vi.fn().mockResolvedValue(false)
  const api = createRendererApi({ invoke, on: vi.fn(), removeListener: vi.fn() })
  expect(await api.getChapterCompletionNotification()).toBe(false)
  expect(await api.setChapterCompletionNotification(false)).toBe(false)
  expect(invoke.mock.calls).toEqual([['settings:getChapterCompletionNotification'], ['settings:setChapterCompletionNotification', false]])
})
