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
import { ExportService } from './data/export-service'
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
import { registerExportIpc } from './ipc/export'
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
import { BookTestService } from './data/book-test-service'
import { registerBookTestIpc } from './ipc/book-test'
import { registerScanIpc } from './ipc/scan'
import { registerFanqieChartIpc } from './ipc/fanqie-chart'
import { FanqieChartService } from './data/fanqie-chart/service'
import { registerWindowsIpc, type ProjectWindowActions } from './ipc/windows'
import { ScanService } from './data/scan/scan-service'
import { ChapterNameService } from './data/chapter-name-service'
import { MobileServer } from './mobile/mobile-server'
import { MobileBrainstormService } from './mobile/mobile-brainstorm-service'
import { MobileBatchService } from './mobile/mobile-batch-service'
import { registerMobileIpc } from './ipc/mobile'
import { MobileReferenceService } from './mobile/mobile-reference-service'
import { ShortStoryStorage } from './data/short-story-storage'
import { registerShortStoryIpc } from './ipc/short-story'
import { registerShortStoryStorageIpc } from './ipc/short-story-storage'
import { registerShortStoryBrainstormIpc } from './ipc/short-story-brainstorm'
import { registerLongStoryBrainstormIpc } from './ipc/long-story-brainstorm'

export interface WritingBackend {
  mobileServer: MobileServer
  disposeProjectWatchers: () => void
  stop(): Promise<void>
}

/**
 * 组装写作服务并注册 IPC。桌面版在 Electron ready 之后调用；
 * Web 版用同一入口，窗口行为由调用方提供。
 */
export async function startBackend(userData: string, windows: ProjectWindowActions): Promise<WritingBackend> {
  const libraryFile = join(userData, 'library.json')
  const defaultProjectsRoot = join(userData, 'projects')
  const settingsFile = join(userData, 'config', 'settings.json')
  const settings = new SettingsRepository(settingsFile)
  const projectsRoot = await settings.getProjectsRoot(defaultProjectsRoot)

  const libraryRepo = new LibraryRepository(libraryFile)
  const projectService = new ProjectService(projectsRoot, libraryRepo, settings)
  const usageRepo = new UsageRepository(join(userData, 'config'))

  registerLibraryIpc(projectService)
  const disposeProjectWatchers = registerProjectsIpc(projectService)
  registerWindowsIpc(windows)
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
  const shortStoryStorage = new ShortStoryStorage(
    await settings.getShortStoriesRoot(join(userData, 'short-stories')),
    async path => { await settings.update({ shortStoriesRoot: path }) }
  )
  registerShortStoryIpc(shortStoryStorage, llmService)
  registerShortStoryStorageIpc(shortStoryStorage)
  registerShortStoryBrainstormIpc(llmService)
  registerLongStoryBrainstormIpc(llmService)

  const chapterNameService = new ChapterNameService(llmService, projectService)
  registerChaptersIpc(projectService, chapterService, chapterNameService)

  const outlineService = new OutlineService(projectService, llmService)
  registerOutlineIpc(outlineService)

  const exportService = new ExportService(chapterService, outlineService)
  registerExportIpc(exportService, projectService)

  const teardownRoot = join(userData, 'teardown-library')
  const teardownRepo = new TeardownRepository(teardownRoot)
  const teardownService = new TeardownService(teardownRepo, llmService)
  registerTeardownIpc(teardownService)
  const benchmarkResolver = new BenchmarkResolver(teardownRepo)

  const deslopService = new DeslopService(llmService)
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
  const mobileReferences = new MobileReferenceService(projectService)
  const mobileBatch = new MobileBatchService(
    projectService,
    writeService,
    chapterService,
    mobileReferences,
    join(userData, 'mobile-batches')
  )
  const mobileServer = new MobileServer(
    projectService,
    chapterService,
    mobileReferences,
    writeService,
    new MobileBrainstormService(llmService),
    mobileBatch
  )
  registerMobileIpc(mobileServer)
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
  registerDeslopRulesIpc(settings, llmService)

  const imageService = new ImageService(settings)
  const coverLearningLibrary = new CoverLearningLibraryService(
    settings,
    join(userData, 'cover-learning-library'),
    llmService
  )
  await coverLearningLibrary.initialize()
  const coverPromptService = new CoverPromptService(
    projectService,
    llmService,
    outlineService,
    chapterService,
    coverLearningLibrary
  )
  const coverService = new CoverService(projectService, imageService, coverLearningLibrary, coverPromptService)
  registerCoverIpc(coverService, settings, coverPromptService, coverLearningLibrary)
  const bookTestService = new BookTestService(projectService, outlineService, llmService, coverService)
  registerBookTestIpc(bookTestService)

  const scanService = new ScanService(userData, llmService)
  registerScanIpc(scanService)
  const fanqieChartService = new FanqieChartService(userData, llmService, async () => {
    return (await settings.get()).chartCoversRoot || join(userData, 'covers')
  })
  registerFanqieChartIpc(fanqieChartService)

  return {
    mobileServer,
    disposeProjectWatchers,
    async stop() {
      disposeProjectWatchers()
      await mobileServer.stop()
    }
  }
}
