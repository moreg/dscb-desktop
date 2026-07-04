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
import { TeardownRepository } from './data/teardown/teardown-repository'
import { TeardownService } from './data/teardown/teardown-service'
import { BenchmarkResolver } from './data/teardown/benchmark-resolver'
import { DeslopService } from './data/deslop/deslop-service'
import { ImageService } from './data/image-service'
import { CoverService } from './data/cover-service'
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
import { registerTeardownIpc } from './ipc/teardown'
import { registerDeslopIpc } from './ipc/deslop'
import { registerCoverIpc } from './ipc/cover'
import { registerScanIpc } from './ipc/scan'
import { registerOpeningIpc } from './ipc/opening'
import { ScanService } from './data/scan/scan-service'
import { OpeningService } from './data/opening-service'
import { ProjectFileWatcher } from './data/project-file-watcher'

let mainWindow: BrowserWindow | null = null
let fileWatcher: ProjectFileWatcher | null = null

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

  // 文件监听器：用户在外部编辑器改源文件时，自动推送事件让渲染进程刷新。
  // watcher 绑定到主窗口；窗口销毁/退出时 dispose（在 app 事件里调 dispose）。
  fileWatcher = new ProjectFileWatcher(() => mainWindow)

  registerLibraryIpc(projectService)
  registerProjectsIpc(projectService, fileWatcher)
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

  // 拆文库（长/短篇拆文）—— 全局目录，跨项目共享的方法论资产。
  // 提前到 writeService 之前，以便 benchmarkResolver 注入写作召回。
  const teardownRoot = join(userData, 'teardown-library')
  const teardownRepo = new TeardownRepository(teardownRoot)
  const teardownService = new TeardownService(teardownRepo, llmService)
  registerTeardownIpc(teardownService)
  // 对标解析层（项目级 对标/ → 全局 teardown-library/ 回退链），供写作召回
  const benchmarkResolver = new BenchmarkResolver(teardownRepo)

  // 构造函数参数顺序：(projectService, llm, flow?, reviewFlow?, chapterService?, settings?, benchmarkResolver?)
  // flow/reviewFlow 传 undefined 走默认值（内部 new WriteFlowService(llm)/new ReviewFlowService(llm)）。
  const writeService = new WriteService(
    projectService,
    llmService,
    undefined,
    undefined,
    chapterService,
    settings,
    benchmarkResolver
  )
  registerWriteIpc(writeService)
  const diagnosticsService = new DiagnosticsService(projectService)
  registerDiagnosticsIpc(diagnosticsService)
  const figureService = new FigureService(projectService)
  registerFigureIpc(figureService)
  const styleProfileService = new StyleProfileService(
    projectService,
    llmService,
    join(userData, 'config', 'styles.json')
  )
  registerStyleIpc(styleProfileService, projectService)

  // 去 AI 味润色（story-deslop）—— 确定性检测 + LLM 改写
  const deslopService = new DeslopService(llmService)
  registerDeslopIpc(deslopService, projectService, styleProfileService)

  // 封面生成（story-cover）—— 图像 API + skia-canvas 裁剪
  const imageService = new ImageService(settings)
  const coverService = new CoverService(projectService, imageService)
  registerCoverIpc(coverService, settings)

  // 扫榜（story-long-scan / story-short-scan）—— 采集 + 选题决策
  const scanService = new ScanService(userData, llmService)
  registerScanIpc(scanService)

  // 开书（story-long-write Phase 1-3）—— 脑洞 → 核心设定 + 卷级大纲 + 细纲
  const openingService = new OpeningService(projectService, llmService, benchmarkResolver)
  registerOpeningIpc(openingService)

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

app.on('before-quit', () => {
  fileWatcher?.dispose()
})

app.on('window-all-closed', () => {
  fileWatcher?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
