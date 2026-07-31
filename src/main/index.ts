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
import { CoverPromptService } from './data/cover-prompt-service'
import { CoverLearningLibraryService } from './data/cover-learning-library'
import { registerLibraryIpc } from './ipc/library'
import { registerProjectsIpc } from './ipc/projects'
import { registerChaptersIpc } from './ipc/chapters'
import { registerMemoryIpc } from './ipc/memory'
import { registerTrackingIpc } from './ipc/tracking'
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
import { registerDeslopRulesIpc } from './ipc/deslop-rules'
import { registerCoverIpc } from './ipc/cover'
import { registerScanIpc } from './ipc/scan'
import { registerWindowsIpc, type ProjectWindowResult } from './ipc/windows'
import { ScanService } from './data/scan/scan-service'
import { ChapterNameService } from './data/chapter-name-service'
import { ProjectWindowRegistry } from './data/project-window-registry'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
const projectWindows = new ProjectWindowRegistry<BrowserWindow>()
let disposeProjectWatchers: (() => void) | null = null

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
    const userData = app.getPath('userData')
  const libraryFile = join(userData, 'library.json')
  const defaultProjectsRoot = join(userData, 'projects')
  const settingsFile = join(userData, 'config', 'settings.json')
  const settings = new SettingsRepository(settingsFile)
  const projectsRoot = await settings.getProjectsRoot(defaultProjectsRoot)

  const libraryRepo = new LibraryRepository(libraryFile)
  const projectService = new ProjectService(projectsRoot, libraryRepo, settings)
  const usageRepo = new UsageRepository(join(userData, 'config'))

  // 文件监听器按渲染窗口创建，避免多本书同时打开时互相替换监听目标。
  registerLibraryIpc(projectService)
  disposeProjectWatchers = registerProjectsIpc(projectService)
  registerWindowsIpc({ open: openProjectWindow, bind: bindProjectWindow })
  const chapterService = new ChapterService(projectService)
  registerSettingsIpc(settings, defaultProjectsRoot)
  registerUsageIpc(usageRepo, settings)
  const memoryService = new MemoryService(projectService)
  const memoryEntityService = new MemoryEntityService(projectService)
  registerMemoryIpc(memoryService, memoryEntityService, projectService)
  registerTrackingIpc(projectService)
  const secretFile = join(userData, 'config', 'providers.enc')
  const secret = new SecretStore(secretFile)
  const llmService = new LlmService(secret, usageRepo)
  registerLlmIpc(secret, llmService)

  // 章名命名服务（依赖 LlmService，必须在 llmService 实例化后构造）
  const chapterNameService = new ChapterNameService(llmService)
  registerChaptersIpc(projectService, chapterService, chapterNameService)

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

  // 去 AI 味润色（story-deslop）-- 确定性检测 + LLM 改写
  // 提前实例化，供 WriteService.humanizeSegment 走 deslop pipeline（单条改写与编辑器共用 7 Gate 方法论）
  const deslopService = new DeslopService(llmService)

  // 构造函数参数顺序：(projectService, llm, flow?, reviewFlow?, chapterService?, settings?, benchmarkResolver?, deslopService?)
  // flow/reviewFlow 传 undefined 走默认值（内部 new WriteFlowService(llm)/new ReviewFlowService(llm)）。
  const writeService = new WriteService(
    projectService,
    llmService,
    undefined,
    undefined,
    chapterService,
    settings,
    benchmarkResolver,
    deslopService
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

  registerDeslopIpc(deslopService, projectService, styleProfileService, settings)
  // 去 AI 味规则可配置化（设置页展示/编辑/AI 改写，保存后影响扫描与改写）
  registerDeslopRulesIpc(settings, llmService)

  // 封面生成（story-cover）—— 图像 API + skia-canvas 裁剪
  // 提示词提炼走文本模型（auxiliary 路由），与出图的图像 API 相互独立：
  // 没配图像 Key 也能先把提示词调好，且可用 codex/grok 这类免 Key 的 CLI provider。
  const imageService = new ImageService(settings)
  const coverLearningLibrary = new CoverLearningLibraryService(
    settings,
    join(userData, 'cover-learning-library')
  )
  await coverLearningLibrary.initialize()
  const coverService = new CoverService(projectService, imageService, coverLearningLibrary)
  const coverPromptService = new CoverPromptService(
    projectService,
    llmService,
    outlineService,
    chapterService,
    coverLearningLibrary
  )
  registerCoverIpc(coverService, settings, coverPromptService, coverLearningLibrary)

  // 扫榜（story-long-scan / story-short-scan）—— 采集 + 选题决策
  const scanService = new ScanService(userData, llmService)
  registerScanIpc(scanService)

  if (!process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:"
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
}

app.on('before-quit', () => {
  disposeProjectWatchers?.()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
