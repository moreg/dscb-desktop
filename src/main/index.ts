import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { LibraryRepository } from './data/library-repository'
import { ProjectService } from './data/project-service'
import { ChapterService } from './data/chapter-service'
import { MemoryService } from './data/memory-service'
import { MemoryEntityService } from './data/memory-entity-service'
import { SecretStore } from './data/secret-store'
import { SettingsRepository } from './data/settings-repository'
import { UsageRepository } from './data/usage-repository'
import { LlmService } from './data/llm-service'
import { OutlineService } from './data/outline-service'
import { WriteService } from './data/write-service'
import { DiagnosticsService } from './data/diagnostics-service'
import { FigureService } from './data/figure-service'
import { StyleProfileService } from './data/style-profile-service'
import { registerLibraryIpc } from './ipc/library'
import { registerProjectsIpc } from './ipc/projects'
import { registerChaptersIpc } from './ipc/chapters'
import { registerMemoryIpc } from './ipc/memory'
import { registerLlmIpc } from './ipc/llm'
import { registerOutlineIpc } from './ipc/outline'
import { registerWriteIpc } from './ipc/write'
import { registerSettingsIpc } from './ipc/settings'
import { registerUsageIpc } from './ipc/usage'
import { registerDiagnosticsIpc } from './ipc/diagnostics'
import { registerFigureIpc } from './ipc/figure'
import { registerStyleIpc } from './ipc/styles'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const libraryFile = join(userData, 'library.json')
  const defaultProjectsRoot = join(userData, 'projects')
  const settingsFile = join(userData, 'config', 'settings.json')
  const settings = new SettingsRepository(settingsFile)
  const projectsRoot = await settings.getProjectsRoot(defaultProjectsRoot)

  const libraryRepo = new LibraryRepository(libraryFile)
  const projectService = new ProjectService(projectsRoot, libraryRepo, settings)
  const usageRepo = new UsageRepository(join(userData, 'config'))

  registerLibraryIpc(projectService)
  registerProjectsIpc(projectService)
  const chapterService = new ChapterService(projectService)
  registerChaptersIpc(projectService, chapterService)
  registerSettingsIpc(settings, defaultProjectsRoot)
  registerUsageIpc(usageRepo, settings)
  const memoryService = new MemoryService(projectService)
  const memoryEntityService = new MemoryEntityService(projectService)
  registerMemoryIpc(memoryService, memoryEntityService)
  const secretFile = join(userData, 'config', 'providers.enc')
  const secret = new SecretStore(secretFile)
  const llmService = new LlmService(secret, usageRepo)
  registerLlmIpc(secret, llmService)
  const outlineService = new OutlineService(projectService, llmService)
  registerOutlineIpc(outlineService)
  const writeService = new WriteService(projectService, llmService, undefined, chapterService)
  registerWriteIpc(writeService)
  const diagnosticsService = new DiagnosticsService(projectService)
  registerDiagnosticsIpc(diagnosticsService)
  const figureService = new FigureService(projectService)
  registerFigureIpc(figureService)
  const styleProfileService = new StyleProfileService(projectService, llmService)
  registerStyleIpc(styleProfileService, projectService)

  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
          ]
        }
      })
    })
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
