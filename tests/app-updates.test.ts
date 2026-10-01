import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { registerAppUpdates } from '../src/main/app-updates'
import { readJson, writeJsonAtomic } from '../src/main/data/atomic'
import type { AppUpdateState } from '../src/shared/app-update'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getVersion: () => '0.1.0', isPackaged: true },
  BrowserWindow: { getAllWindows: () => [{}] }
}))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  return { autoUpdater: Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(), downloadUpdate: vi.fn(),
    autoDownload: true, autoInstallOnAppQuit: false,
    allowPrerelease: true, allowDowngrade: true
  }) }
})
vi.mock('../src/main/data/atomic', () => ({ readJson: vi.fn(), writeJsonAtomic: vi.fn() }))
vi.mock('../src/main/ipc/safe-handle', () => ({
  safeHandle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
  safeSend: mocks.send
}))

const invoke = async (channel: string, value?: unknown) =>
  await mocks.handlers.get(channel)!(undefined, value) as AppUpdateState

const updateInfo = {
  version: '0.1.1', files: [], path: 'installer.exe', sha512: 'test', releaseDate: '2026-10-01'
}

describe('GitHub app updates', () => {
  let dispose: (() => void) | undefined
  let originalPlatform: string
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.handlers.clear()
    originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.assign(app, { isPackaged: true })
    vi.mocked(readJson).mockResolvedValue({ autoCheck: true })
    vi.mocked(writeJsonAtomic).mockResolvedValue(undefined)
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
      autoUpdater.emit('update-not-available', { ...updateInfo, version: '0.1.0' })
      return null
    })
    vi.mocked(autoUpdater.downloadUpdate).mockResolvedValue([])
  })
  afterEach(() => {
    dispose?.()
    autoUpdater.removeAllListeners()
    dispose = undefined
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.useRealTimers()
  })

  it('checks only once after startup, without auto downloading or periodic checks', async () => {
    dispose = await registerAppUpdates()
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.allowPrerelease).toBe(false)
    expect(autoUpdater.allowDowngrade).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('persists the opt-out but still permits manual checks', async () => {
    vi.mocked(readJson).mockResolvedValue({ autoCheck: false })
    dispose = await registerAppUpdates()
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect((await invoke('updates:check')).status).toBe('current')
    expect((await invoke('updates:setAutoCheck', true)).autoCheck).toBe(true)
    expect(writeJsonAtomic).toHaveBeenCalledWith(expect.stringContaining('updates.json'), { autoCheck: true })
    await expect(invoke('updates:setAutoCheck', 'true')).rejects.toThrow('自动检查设置无效')
  })

  it('deduplicates checks and retains downloaded updates until normal quit', async () => {
    let resolveCheck!: (value: null) => void
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => new Promise(resolve => { resolveCheck = resolve }))
    dispose = await registerAppUpdates()
    const checking = invoke('updates:check')
    await invoke('updates:check')
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    autoUpdater.emit('update-available', updateInfo)
    resolveCheck(null)
    expect((await checking).status).toBe('available')
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    vi.mocked(autoUpdater.downloadUpdate).mockImplementation(async () => {
      autoUpdater.emit('download-progress', { percent: 42, total: 100, delta: 42, transferred: 42, bytesPerSecond: 42 })
      expect((await invoke('updates:getState')).percent).toBe(42)
      autoUpdater.emit('update-downloaded', { ...updateInfo, downloadedFile: 'installer.exe' })
      return ['installer.exe']
    })
    expect((await invoke('updates:download')).status).toBe('downloaded')
    await invoke('updates:check')
    await invoke('updates:download')
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('handles check/download failures and allows retry without exposing error details', async () => {
    dispose = await registerAppUpdates()
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(new Error('private network details'))
    const failed = await invoke('updates:check')
    expect(failed.status).toBe('error')
    expect(failed.error).not.toContain('private network details')
    await invoke('updates:check')
    autoUpdater.emit('update-available', updateInfo)
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce(new Error('disconnected'))
    expect((await invoke('updates:download')).status).toBe('error')
    await invoke('updates:download')
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    autoUpdater.emit('error', new Error('connection failed'))
    expect((await invoke('updates:getState')).status).toBe('error')
  })

  it('does no network or downloads in development mode and disposes timers', async () => {
    Object.assign(app, { isPackaged: false })
    dispose = await registerAppUpdates()
    expect((await invoke('updates:getState')).supported).toBe(false)
    await invoke('updates:check')
    await invoke('updates:download')
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    dispose()
    dispose = undefined
    expect(vi.getTimerCount()).toBe(0)
    expect(autoUpdater.listenerCount('update-available')).toBe(0)
  })
})
