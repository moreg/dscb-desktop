import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { ProjectWindowRegistry } from './data/project-window-registry'
import { MobileServer } from './mobile/mobile-server'
import { registerAppUpdates } from './app-updates'
import { startBackend } from './backend'
import type { ProjectWindowResult } from './ipc/windows'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
const projectWindows = new ProjectWindowRegistry<BrowserWindow>()
let disposeProjectWatchers: (() => void) | null = null
let mobileServer: MobileServer | null = null
let disposeAppUpdates: (() => void) | null = null

function createWindow(projectId: string | null = null): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (projectId) projectWindows.bind(window, projectId)

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    projectWindows.release(window)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (projectId) rendererUrl.searchParams.set('projectId', projectId)
    void window.loadURL(rendererUrl.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: projectId ? { projectId } : undefined
    })
  }

  return window
}

function bindProjectWindow(window: BrowserWindow, projectId: string | null): ProjectWindowResult {
  const existing = projectWindows.bind(window, projectId)
  if (existing) {
    projectWindows.focus(existing)
    return { ok: false, focusedExisting: true }
  }
  return { ok: true, focusedExisting: false }
}

function openProjectWindow(projectId: string): ProjectWindowResult {
  const existing = projectWindows.get(projectId)
  if (existing) {
    projectWindows.focus(existing)
    return { ok: false, focusedExisting: true }
  }
  createWindow(projectId)
  return { ok: true, focusedExisting: false }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 再次启动始终给出一个真正的书架窗口；未绑定项目的窗口可能正停在设置/扫描等页面。
    createWindow()
  })

  void app.whenReady().then(async () => {
    const backend = await startBackend(app.getPath('userData'), {
      open: openProjectWindow,
      bind: bindProjectWindow
    })
    mobileServer = backend.mobileServer
    disposeProjectWatchers = backend.disposeProjectWatchers

    if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file: https:"
          ]
        }
      })
    })
  }

  disposeAppUpdates = await registerAppUpdates()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

let mobileQuitReady = false
let mobileQuitPending = false
app.on('before-quit', (event) => {
  if (mobileQuitReady || !mobileServer) {
    disposeProjectWatchers?.()
    return
  }
  event.preventDefault()
  if (mobileQuitPending) return
  mobileQuitPending = true
  // 保存暂停检查点后再退出，重启电脑应用时可以继续手机批次。
  void mobileServer.stop().catch((error: unknown) => {
    console.error('[mobile-server] shutdown failed:', error)
  }).finally(() => {
    mobileQuitReady = true
    app.quit()
  })
})

app.on('will-quit', () => { disposeAppUpdates?.() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
