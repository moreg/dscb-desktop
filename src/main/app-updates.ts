import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './data/atomic'
import { safeHandle, safeSend } from './ipc/safe-handle'
import type { AppUpdateState } from '../shared/app-update'

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined
  if (!Array.isArray(notes)) return undefined
  // GitHub may supply HTML; preserve the source for safe formatting in the renderer.
  return notes.map(({ version, note }) => {
    const content = note?.trim()
    return content ? `## ${version}\n\n${content}` : undefined
  }).filter(Boolean).join('\n\n') || undefined
}

/** No forced quit: installation runs only after the user closes the app normally. */
export async function registerAppUpdates(): Promise<() => void> {
  const preferencesFile = join(app.getPath('userData'), 'config', 'updates.json')
  const preferences = await readJson(preferencesFile, { autoCheck: true }).catch(() => ({ autoCheck: true }))
  let state: AppUpdateState = {
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === 'win32',
    autoCheck: preferences.autoCheck !== false,
    status: 'idle'
  }
  let busy = false
  const publish = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch }
    for (const win of BrowserWindow.getAllWindows()) safeSend(win, 'updates:state', state)
  }
  const fail = () => publish({
    status: 'error',
    error: '更新失败。请检查 GitHub 连接，或确认 Releases 已发布安装包和 latest.yml 后重试。'
  })

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
  const onDownloaded = (info: UpdateInfo) => publish({
    status: 'downloaded', version: info.version, percent: 100, error: undefined,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? (state.version === info.version ? state.releaseNotes : undefined)
  })
  autoUpdater.on('update-available', onAvailable)
  autoUpdater.on('update-not-available', onCurrent)
  autoUpdater.on('download-progress', onProgress)
  autoUpdater.on('update-downloaded', onDownloaded)
  autoUpdater.on('error', fail)

  const check = async (automatic = false) => {
    if (!state.supported || busy || state.status === 'downloaded' || state.status === 'downloading') return state
    // Respect the startup-check preference and keep an already available update visible.
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
  return () => {
    clearTimeout(startup)
    autoUpdater.removeListener('update-available', onAvailable)
    autoUpdater.removeListener('update-not-available', onCurrent)
    autoUpdater.removeListener('download-progress', onProgress)
    autoUpdater.removeListener('update-downloaded', onDownloaded)
    // Keep the error listener for installer failures emitted during the later quit event.
  }
}
