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
    await invoke('updates:download')
    await vi.waitFor(async () => expect((await invoke('updates:getState')).status).toBe('downloaded'))
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
    const releaseNotes = '- 增加更新内容预览\n- 修复下载中断后的重试'
    autoUpdater.emit('update-available', { ...updateInfo, releaseNotes })
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce(new Error('disconnected'))
    await invoke('updates:download')
    await vi.waitFor(async () => expect((await invoke('updates:getState')).status).toBe('error'))
    expect((await invoke('updates:getState')).releaseNotes).toBe(releaseNotes)
    expect((await invoke('updates:download')).releaseNotes).toBe(releaseNotes)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    autoUpdater.emit('error', new Error('connection failed'))
    expect((await invoke('updates:getState')).status).toBe('error')
    expect((await invoke('updates:getState')).releaseNotes).toBe(releaseNotes)
  })

  it('keeps GitHub HTML release notes through progress and a completion event without notes', async () => {
    dispose = await registerAppUpdates()
    const releaseNotes = '<p>更新内容</p>\n<ul><li>支持后台下载</li><li>修复重试</li></ul>'
    autoUpdater.emit('update-available', { ...updateInfo, releaseNotes: `\n${releaseNotes}\n` })
    expect(await invoke('updates:getState')).toMatchObject({ status: 'available', releaseNotes })
    expect(mocks.send).toHaveBeenLastCalledWith({}, 'updates:state', expect.objectContaining({ releaseNotes }))
    expect((await invoke('updates:download')).releaseNotes).toBe(releaseNotes)
    autoUpdater.emit('download-progress', { percent: 67, total: 100, delta: 67, transferred: 67, bytesPerSecond: 67 })
    expect(await invoke('updates:getState')).toMatchObject({ status: 'downloading', percent: 67, releaseNotes })
    autoUpdater.emit('update-downloaded', { ...updateInfo, downloadedFile: 'installer.exe' })
    expect(await invoke('updates:getState')).toMatchObject({ status: 'downloaded', percent: 100, releaseNotes })
  })

  it('combines full changelog notes with their versions and ignores empty entries', async () => {
    dispose = await registerAppUpdates()
    autoUpdater.emit('update-available', {
      ...updateInfo,
      releaseNotes: [
        { version: '0.1.1', note: '<ul><li>新增功能</li></ul>' },
        { version: '0.1.0', note: '  - 修复旧版本问题\n' },
        { version: '0.0.9', note: null },
        { version: '0.0.8', note: ' \n ' }
      ]
    })
    expect((await invoke('updates:getState')).releaseNotes).toBe('## 0.1.1\n\n<ul><li>新增功能</li></ul>\n\n## 0.1.0\n\n- 修复旧版本问题')
  })

  it.each([undefined, null, '', ' \n ', [], [{ version: '0.1.1', note: null }]])(
    'clears stale notes when an available update has no usable notes: %j',
    async releaseNotes => {
      dispose = await registerAppUpdates()
      autoUpdater.emit('update-available', { ...updateInfo, releaseNotes: '旧说明' })
      autoUpdater.emit('update-available', { ...updateInfo, version: '0.1.2', releaseNotes })
      expect(await invoke('updates:getState')).toMatchObject({ version: '0.1.2', releaseNotes: undefined })
    }
  )

  it('clears notes while checking again and when no update is available', async () => {
    let resolveCheck!: (value: null) => void
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => new Promise(resolve => { resolveCheck = resolve }))
    dispose = await registerAppUpdates()
    autoUpdater.emit('update-available', { ...updateInfo, releaseNotes: '旧说明' })
    const checking = invoke('updates:check')
    expect(await invoke('updates:getState')).toMatchObject({ status: 'checking', version: undefined, releaseNotes: undefined })
    autoUpdater.emit('update-available', { ...updateInfo, releaseNotes: '本次说明' })
    resolveCheck(null)
    await checking
    autoUpdater.emit('update-not-available', updateInfo)
    expect(await invoke('updates:getState')).toMatchObject({ status: 'current', version: undefined, releaseNotes: undefined })
  })

  it('uses completion notes when supplied and never carries notes across different versions', async () => {
    dispose = await registerAppUpdates()
    autoUpdater.emit('update-available', { ...updateInfo, releaseNotes: '检查时的说明' })
    autoUpdater.emit('update-downloaded', { ...updateInfo, releaseNotes: '下载完成时的说明', downloadedFile: 'installer.exe' })
    expect((await invoke('updates:getState')).releaseNotes).toBe('下载完成时的说明')
    autoUpdater.emit('update-downloaded', { ...updateInfo, version: '0.1.2', downloadedFile: 'installer.exe' })
    expect(await invoke('updates:getState')).toMatchObject({ version: '0.1.2', releaseNotes: undefined })
  })

  it('returns immediately while the main process keeps downloading and tracking progress', async () => {
    let finishDownload!: (files: string[]) => void
    vi.mocked(autoUpdater.downloadUpdate).mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
    dispose = await registerAppUpdates()
    autoUpdater.emit('update-available', updateInfo)
    // A pending download must not hold the renderer's IPC request open.
    expect((await invoke('updates:download')).status).toBe('downloading')
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    await invoke('updates:check')
    await invoke('updates:download')
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    autoUpdater.emit('download-progress', { percent: 67, total: 100, delta: 67, transferred: 67, bytesPerSecond: 67 })
    // Reopening the panel can obtain the current progress without restarting the download.
    expect((await invoke('updates:getState')).percent).toBe(67)
    autoUpdater.emit('update-downloaded', { ...updateInfo, downloadedFile: 'installer.exe' })
    finishDownload(['installer.exe'])
    await vi.waitFor(async () => expect((await invoke('updates:getState')).status).toBe('downloaded'))
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
