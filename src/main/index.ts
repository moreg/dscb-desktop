import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { LibraryRepository } from './data/library-repository'
import { ProjectService } from './data/project-service'
import { MemoryService } from './data/memory-service'
import { MemoryEntityService } from './data/memory-entity-service'
import { registerLibraryIpc } from './ipc/library'
import { registerProjectsIpc } from './ipc/projects'
import { registerChaptersIpc } from './ipc/chapters'
import { registerMemoryIpc } from './ipc/memory'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
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

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const libraryFile = join(userData, 'library.json')
  const projectsRoot = join(userData, 'projects')
  const libraryRepo = new LibraryRepository(libraryFile)
  const projectService = new ProjectService(projectsRoot, libraryRepo)

  registerLibraryIpc(libraryRepo)
  registerProjectsIpc(projectService)
  registerChaptersIpc(projectService)
  const memoryService = new MemoryService(projectService)
  const memoryEntityService = new MemoryEntityService(projectService)
  registerMemoryIpc(memoryService, memoryEntityService)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
