import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './data/atomic'
import { safeHandle, safeSend } from './ipc/safe-handle'
import type { AppUpdateState } from '../shared/app-update'
import { activeStreamCount } from './data/stream-abort-registry'
import { activeBatchProjects } from './data/write-batch-lock'

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined
  if (!Array.isArray(notes)) return undefined
  // GitHub may supply HTML; preserve the source for safe formatting in the renderer.
  return notes.map(({ version, note }) => {
    const content = note?.trim()
    return content ? `## ${version}\n\n${content}` : undefined
  }).filter(Boolean).join('\n\n') || undefined
}

/** Restart installation must wait for normal window-close and shutdown guards. */
export async function registerAppUpdates(restoreWindow: () => void = () => {}): Promise<() => void> {
  const preferencesFile = join(app.getPath('userData'), 'config', 'updates.json')
  const preferences = await readJson(preferencesFile, { autoCheck: true }).catch(() => ({ autoCheck: true }))
  let state: AppUpdateState = {
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === 'win32',
    autoCheck: preferences.autoCheck !== false,
    status: 'idle'
  }
  let busy = false
  let restarting = false
  let clearRestartListeners = () => {}
  const promptedVersions = new Set<string>()
  const publish = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch }
    for (const win of BrowserWindow.getAllWindows()) safeSend(win, 'updates:state', state)
  }
  const restartFailed = (message: string) => {
    restarting = false
    clearRestartListeners()
    publish({ status: 'downloaded', error: message })
    if (BrowserWindow.getAllWindows().length === 0) restoreWindow()
  }
  const fail = () => {
    if (restarting) {
      restartFailed('安装更新未能启动，请稍后重试，或从 GitHub Release 下载完整安装包。')
      return
    }
    publish({
      status: 'error',
      error: '更新失败。请检查 GitHub 连接，或确认 Releases 已发布安装包和 latest.yml 后重试。'
    })
  }

  const restart = () => {
    if (!state.supported || state.status !== 'downloaded' || restarting) return state
    if (activeStreamCount() > 0 || activeBatchProjects.size > 0) {
      publish({ error: '仍有生成或批量任务正在进行，请先结束任务，再点击“重启应用并更新”。' })
      return state
    }
    restarting = true
    publish({ status: 'restarting', error: undefined })
    const windows = BrowserWindow.getAllWindows()
    const canceled = () => restartFailed('应用重启已取消。请先保存未保存的内容并结束任务，再点击“重启应用并更新”。')
    const ready = (event: Electron.Event) => {
      // will-quit only runs after every window accepts closing and mobile shutdown completes.
      event.preventDefault()
      clearRestartListeners()
      try { autoUpdater.quitAndInstall(true, true) } catch { fail() }
    }
    clearRestartListeners = () => {
      app.removeListener('will-quit', ready)
      for (const window of windows) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.removeListener('will-prevent-unload', canceled)
      }
    }
    for (const window of windows) window.webContents.once('will-prevent-unload', canceled)
    app.once('will-quit', ready)
    // Defer until the restart IPC response has reached the renderer.
    setImmediate(() => { if (restarting) app.quit() })
    return state
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  const onAvailable = (info: UpdateInfo) => publish({
    status: 'available', version: info.version,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes), error: undefined
  })
  const onCurrent = () => publish({ status: 'current', version: undefined, releaseNotes: undefined, error: undefined })
  const onProgress = (progress: { percent: number }) => publish({ status: 'downloading', percent: Math.max(0, Math.min(100, progress.percent)) })
  const onDownloaded = (info: UpdateInfo) => {
    if (restarting) return
    publish({
      status: 'downloaded', version: info.version, percent: 100, error: undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? (state.version === info.version ? state.releaseNotes : undefined)
    })
    if (!state.supported || promptedVersions.has(info.version)) return
    promptedVersions.add(info.version)
    void dialog.showMessageBox({
      type: 'info', title: '更新已下载',
      message: `版本 ${info.version} 已下载，是否立即重启应用并安装更新？`,
      detail: '只会关闭并重新打开本应用，无需重启电脑。请先保存正文并结束正在进行的任务；安装更新后应用将自动打开。选择“稍后”可继续使用。',
      buttons: ['重启应用并更新', '稍后'], defaultId: 1, cancelId: 1, noLink: true
    }).then(({ response }) => {
      if (response === 0 && state.version === info.version && state.status === 'downloaded') restart()
    }).catch(() => {
      if (state.status === 'downloaded') publish({ error: '无法显示应用重启提示，请在应用更新面板点击“重启应用并更新”。' })
    })
  }
  autoUpdater.on('update-available', onAvailable)
  autoUpdater.on('update-not-available', onCurrent)
  autoUpdater.on('download-progress', onProgress)
  autoUpdater.on('update-downloaded', onDownloaded)
  autoUpdater.on('error', fail)

  const check = async (automatic = false) => {
    if (!state.supported || busy || restarting || state.status === 'downloaded' || state.status === 'downloading') return state
    // Respect the automatic-check preference and keep an already available update visible.
    if (automatic && (!state.autoCheck || state.status === 'available')) return state
    busy = true
    publish({ status: 'checking', error: undefined, version: undefined, releaseNotes: undefined, percent: undefined })
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      fail()
    } finally {
      busy = false
    }
    return state
  }
  safeHandle('updates:getState', () => state)
  safeHandle('updates:check', () => check())
  safeHandle('updates:restart', () => restart())
  safeHandle('updates:setAutoCheck', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('自动检查设置无效')
    await writeJsonAtomic(preferencesFile, { autoCheck: enabled })
    publish({ autoCheck: enabled })
    return state
  })
  safeHandle('updates:download', () => {
    if (!state.supported || busy || !state.version || !['available', 'error'].includes(state.status)) return state
    busy = true
    publish({ status: 'downloading', percent: 0, error: undefined })
    // The main process owns the download; closing the panel or switching pages has no effect.
    // Return immediately so the renderer can send the download to the background.
    void Promise.resolve().then(() => autoUpdater.downloadUpdate()).catch(fail).finally(() => {
      busy = false
    })
    return state
  })

  const startup = setTimeout(() => { void check(true) }, 15_000)
  startup.unref()
  const hourly = setInterval(() => { void check(true) }, 60 * 60 * 1000)
  hourly.unref()
  return () => {
    clearRestartListeners()
    clearTimeout(startup)
    clearInterval(hourly)
    autoUpdater.removeListener('update-available', onAvailable)
    autoUpdater.removeListener('update-not-available', onCurrent)
    autoUpdater.removeListener('download-progress', onProgress)
    autoUpdater.removeListener('update-downloaded', onDownloaded)
    // Keep the error listener for installer failures emitted during the later quit event.
  }
}
