import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateState } from '../shared/app-update'
import type {
  AutoDeslopResult,
  SavedChapterPolishResult,
  DiagnosticFixKind,
  ListProjectsQuery,
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateCharacterInput,
  UpdateCharacterInput,
  CreateChapterVersionInput,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput,
  CreateForeshadowingInput,
  UpdateForeshadowingInput,
  CreateRelationshipInput,
  UpdateRelationshipInput,
  MainOutline,
  DetailedOutlineItem,
  MemoryExtraction,
  MemoryApplyResult,
  SettingsApplyResult,
  ProviderConfig,
  RhythmEvaluation,
  ChapterFlowResult,
  ChapterGenerationStage,
  ChapterStreamResult,
  FeatureCategory,
  FeatureRoutingEntry,
  CreateStyleProfileInput,
  UpdateStyleProfileInput,
  StartTeardownInput,
  TeardownLengthKind,
  TeardownProgressInfo,
  TeardownFileNode,
  TeardownFileContent,
  ScanRankInput,
  ScanResult,
  ScanReportSummary,
  DeslopScanReport,
  DeslopStructureReport,
  DeslopLevel,
  DeslopResult,
  DeslopRulesBundle,
  GenerateCoverInput,
  ExtractCoverPromptInput,
  CoverPromptDraft,
  CoverFile,
  CoverGenerationTaskState,
  UpdateCoverCropInput,
  CoverImageConfigSummary,
  CoverImageConfigInput,
  CoverLearningLibrarySummary,
  CoverLearningRunResult,
  CoverLearningOptions,
  CoverLearningTaskState,
  CoverLearningContext,
  UpdateCoverFeedbackInput,
  BookTestState,
  PatchBookTestInput,
  GenerateBookTestTitlesInput,
  UpdateBookTestCandidateInput,
  ReviewRulesConfig,
  MobileServerStatus,
  StreamHandleOf
} from '../shared/types'

function makeStreamHandle<T>(
  promise: Promise<T>,
  requestId: string
): StreamHandleOf<T> {
  return {
    then: (onfulfilled?: ((value: T) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) =>
      promise.then(onfulfilled, onrejected),
    catch: (onrejected?: ((reason: unknown) => unknown) | null) =>
      promise.catch(onrejected),
    finally: (onfinally?: (() => void) | null) =>
      promise.finally(onfinally),
    requestId,
    abort: () => ipcRenderer.invoke('llm:abort', requestId) as Promise<{ ok: boolean }>
  } as unknown as StreamHandleOf<T>
}

const api = {
  getAppUpdateState: () => ipcRenderer.invoke('updates:getState') as Promise<AppUpdateState>,
  checkAppUpdate: () => ipcRenderer.invoke('updates:check') as Promise<AppUpdateState>,
  downloadAppUpdate: () => ipcRenderer.invoke('updates:download') as Promise<AppUpdateState>,
  setAppUpdateAutoCheck: (enabled: boolean) => ipcRenderer.invoke('updates:setAutoCheck', enabled) as Promise<AppUpdateState>,
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => {
    const handler = (_event: unknown, state: AppUpdateState) => callback(state)
    ipcRenderer.on('updates:state', handler)
    return () => { ipcRenderer.removeListener('updates:state', handler) }
  },
  listProjects: (query?: ListProjectsQuery) => ipcRenderer.invoke('library:list', query ?? {}),
  setProjectArchived: (projectId: string, archived: boolean) =>
    ipcRenderer.invoke('library:setArchived', { projectId, archived }),
  getMobileServerStatus: () =>
    ipcRenderer.invoke('mobile:status') as Promise<MobileServerStatus>,
  startMobileServer: () =>
    ipcRenderer.invoke('mobile:start') as Promise<MobileServerStatus>,
  stopMobileServer: () =>
    ipcRenderer.invoke('mobile:stop') as Promise<MobileServerStatus>,
  refreshMobilePairing: () =>
    ipcRenderer.invoke('mobile:refreshPairing') as Promise<MobileServerStatus>,
  openProjectWindow: (projectId: string) =>
    ipcRenderer.invoke('windows:openProject', projectId) as Promise<{
      ok: boolean
      focusedExisting: boolean
    }>,
  bindProjectWindow: (projectId: string | null) =>
    ipcRenderer.invoke('windows:bindProject', projectId) as Promise<{
      ok: boolean
      focusedExisting: boolean
    }>,
  scanProjects: () => ipcRenderer.invoke('library:scan'),
  createProject: (input: CreateProjectDataInput) => ipcRenderer.invoke('projects:create', input),
  getProject: (id: string) => ipcRenderer.invoke('projects:get', id),
  updateProjectInfo: (projectId: string, info: { name: string; description?: string }) =>
    ipcRenderer.invoke('projects:updateInfo', { projectId, ...info }),
  setBenchmarkBooks: (projectId: string, books: string[]) =>
    ipcRenderer.invoke('projects:setBenchmarkBooks', { projectId, books }) as Promise<string[]>,
  addTitleCandidate: (projectId: string, candidate: { name: string; description: string; seed?: string }) =>
    ipcRenderer.invoke('projects:addTitleCandidate', { projectId, ...candidate }),
  removeTitleCandidate: (projectId: string, candidateId: string) =>
    ipcRenderer.invoke('projects:removeTitleCandidate', { projectId, candidateId }),
  watchProject: (projectId: string) => ipcRenderer.invoke('projects:watch', projectId) as Promise<boolean>,
  stopWatchProject: () => ipcRenderer.invoke('projects:stopWatch') as Promise<boolean>,
  listStyleProfiles: () => ipcRenderer.invoke('styles:list'),
  createStyleProfile: (input: CreateStyleProfileInput) =>
    ipcRenderer.invoke('styles:create', { input }),
  updateStyleProfile: (styleProfileId: string, patch: UpdateStyleProfileInput) =>
    ipcRenderer.invoke('styles:update', { styleProfileId, patch }),
  deleteStyleProfile: (styleProfileId: string) =>
    ipcRenderer.invoke('styles:delete', { styleProfileId }),
  extractStyleProfile: (projectId: string | undefined, sampleText: string, name?: string) =>
    ipcRenderer.invoke('styles:extract', { projectId, sampleText, name }),
  setProjectDefaultStyleProfile: (projectId: string, styleProfileId: string | null) =>
    ipcRenderer.invoke('projects:setDefaultStyleProfile', { projectId, styleProfileId }),
  /** 选择本地文本文件用于文风提取 */
  selectTextFile: () =>
    ipcRenderer.invoke('dialog:selectTextFile'),
  listChapters: (id: string) => ipcRenderer.invoke('chapters:list', id),
  getChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:get', id, n),
  createChapter: (id: string, input: CreateChapterInput) =>
    ipcRenderer.invoke('chapters:create', id, input),
  updateChapterContent: (id: string, n: number, content: string) =>
    ipcRenderer.invoke('chapters:updateContent', id, n, content),
  // P19-A：自动保存草稿
  saveDraft: (projectId: string, chapterNumber: number, content: string) =>
    ipcRenderer.invoke('chapters:saveDraft', projectId, chapterNumber, content),
  readDraft: (projectId: string, chapterNumber: number) =>
    ipcRenderer.invoke('chapters:readDraft', projectId, chapterNumber),
  discardDraft: (projectId: string, chapterNumber: number) =>
    ipcRenderer.invoke('chapters:discardDraft', projectId, chapterNumber),
  /** P19-E：字数汇总（正文 / 节奏图谱） */
  getChapterWordSummary: (projectId: string) =>
    ipcRenderer.invoke('chapters:wordSummary', projectId),
  updateChapterMeta: (id: string, n: number, patch: UpdateChapterMetaInput) =>
    ipcRenderer.invoke('chapters:updateMeta', id, n, patch),
  /** AI 章名命名：基于当前未保存草稿生成候选章名（绝不写盘，需用户确认） */
  suggestChapterName: (
    projectId: string,
    chapterNumber: number,
    currentTitle: string,
    draft: string,
    genre?: string
  ) =>
    ipcRenderer.invoke('chapters:suggestName', {
      projectId,
      chapterNumber,
      currentTitle,
      draft,
      genre
    }) as Promise<{ ok: boolean; title: string; reason: string; error?: string }>,
  deleteChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:delete', id, n),
  listCharacters: (id: string) => ipcRenderer.invoke('memory:character:list', id),
  getCharacter: (id: string, cid: string) => ipcRenderer.invoke('memory:character:get', id, cid),
  createCharacter: (id: string, input: CreateCharacterInput) =>
    ipcRenderer.invoke('memory:character:create', id, input),
  updateCharacter: (id: string, cid: string, patch: UpdateCharacterInput) =>
    ipcRenderer.invoke('memory:character:update', id, cid, patch),
  deleteCharacter: (id: string, cid: string) => ipcRenderer.invoke('memory:character:delete', id, cid),
  listHistory: (id: string) => ipcRenderer.invoke('memory:history:list', id),
  listChapterVersions: (id: string, n: number) =>
    ipcRenderer.invoke('chapters:listVersions', id, n),
  getChapterVersion: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:getVersion', id, n, vn),
  createChapterVersion: (id: string, n: number, input: CreateChapterVersionInput) =>
    ipcRenderer.invoke('chapters:createVersion', id, n, input),
  deleteChapterVersion: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:deleteVersion', id, n, vn),
  rollbackChapter: (id: string, n: number, vn: number) =>
    ipcRenderer.invoke('chapters:rollback', id, n, vn),
  listMemoryEntities: (id: string, type: MemoryEntityType) =>
    ipcRenderer.invoke('memory:entity:list', id, type),
  createMemoryEntity: (id: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
    ipcRenderer.invoke('memory:entity:create', id, type, input),
  updateMemoryEntity: (
    id: string,
    type: MemoryEntityType,
    entityId: string,
    patch: UpdateMemoryEntityInput
  ) => ipcRenderer.invoke('memory:entity:update', id, type, entityId, patch),
  deleteMemoryEntity: (id: string, type: MemoryEntityType, entityId: string) =>
    ipcRenderer.invoke('memory:entity:delete', id, type, entityId),
  listForeshadowings: (id: string) => ipcRenderer.invoke('memory:foreshadowing:list', id),
  createForeshadowing: (id: string, input: CreateForeshadowingInput) =>
    ipcRenderer.invoke('memory:foreshadowing:create', id, input),
  updateForeshadowing: (id: string, fid: string, patch: UpdateForeshadowingInput) =>
    ipcRenderer.invoke('memory:foreshadowing:update', id, fid, patch),
  deleteForeshadowing: (id: string, fid: string) =>
    ipcRenderer.invoke('memory:foreshadowing:delete', id, fid),
  plantForeshadowing: (id: string, fid: string, chapterNumber: number) =>
    ipcRenderer.invoke('memory:foreshadowing:plant', id, fid, chapterNumber),
  collectForeshadowing: (id: string, fid: string, chapterNumber: number) =>
    ipcRenderer.invoke('memory:foreshadowing:collect', id, fid, chapterNumber),
  markForeshadowingMissed: (id: string, fid: string) =>
    ipcRenderer.invoke('memory:foreshadowing:markMissed', id, fid),
  listRelationships: (id: string) => ipcRenderer.invoke('memory:relationship:list', id),
  createRelationship: (id: string, input: CreateRelationshipInput) =>
    ipcRenderer.invoke('memory:relationship:create', id, input),
  updateRelationship: (id: string, rid: string, patch: UpdateRelationshipInput) =>
    ipcRenderer.invoke('memory:relationship:update', id, rid, patch),
  deleteRelationship: (id: string, rid: string) =>
    ipcRenderer.invoke('memory:relationship:delete', id, rid),
  /** v4：刷新记忆索引（从 设定/ + 追踪/ + 细纲/ 增量同步到 记忆/） */
  syncMemoryIndex: (id: string) => ipcRenderer.invoke('memory:syncIndex', id),
  /** 读取 追踪/ 目录的聚合展示数据（角色状态/时间线/进度/问题/伏笔统计） */
  readTracking: (id: string) => ipcRenderer.invoke('tracking:read', id),
  /** v4：获取实体完整 Markdown（用于详情面板） */
  getMemoryDetail: (id: string, type: string, entityId: string) =>
    ipcRenderer.invoke('memory:getDetail', id, type, entityId),
  /** v4：在系统资源管理器中打开源文件 */
  openMemorySource: (id: string, relativePath: string) =>
    ipcRenderer.invoke('memory:openSource', id, relativePath),
  /** v4：老项目 v3 → v4 一次性迁移（dryRun=true 只预览） */
  migrateV3ToV4: (id: string, options?: { dryRun?: boolean }) =>
    ipcRenderer.invoke('memory:migrateV3ToV4', id, options),
  configureLlm: (apiKey: string) => ipcRenderer.invoke('llm:configure', apiKey),
  hasLlmKey: () => ipcRenderer.invoke('llm:hasKey'),
  pingLlm: () => ipcRenderer.invoke('llm:ping'),
  pingProvider: (id: string) => ipcRenderer.invoke('llm:pingProvider', id),
  listAntigravityModels: () =>
    ipcRenderer.invoke('llm:listAntigravityModels') as Promise<string[]>,
  listCodexModels: () =>
    ipcRenderer.invoke('llm:listCodexModels') as Promise<string[]>,
  getCodexReasoningEffort: () =>
    ipcRenderer.invoke('llm:getCodexReasoningEffort'),
  setCodexReasoningEffort: (effort: import('../shared/types').ReasoningEffort) =>
    ipcRenderer.invoke('llm:setCodexReasoningEffort', effort),
  listGrokModels: () =>
    ipcRenderer.invoke('llm:listGrokModels') as Promise<string[]>,
  listClaudeModels: () =>
    ipcRenderer.invoke('llm:listClaudeModels') as Promise<string[]>,
  listProviders: () => ipcRenderer.invoke('llm:listProviders'),
  upsertProvider: (p: ProviderConfig) => ipcRenderer.invoke('llm:upsertProvider', p),
  deleteProvider: (id: string) => ipcRenderer.invoke('llm:deleteProvider', id),
  setActiveProvider: (id: string) => ipcRenderer.invoke('llm:setActive', id),
  setFeatureRouting: (routing: Partial<Record<FeatureCategory, FeatureRoutingEntry>>) =>
    ipcRenderer.invoke('llm:setFeatureRouting', routing),
  generateStream: (
    prompt: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('llm:generate', { prompt, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  getMainOutline: (id: string) => ipcRenderer.invoke('outline:getMain', id),
  updateMainOutline: (id: string, patch: Partial<MainOutline>) =>
    ipcRenderer.invoke('outline:updateMain', id, patch),
  generateMainOutline: (id: string) => ipcRenderer.invoke('outline:generateMain', id),
  listDetailedOutline: (id: string) => ipcRenderer.invoke('outline:listDetailed', id),
  updateDetailedOutline: (id: string, chapterNumber: number, patch: Partial<DetailedOutlineItem>) =>
    ipcRenderer.invoke('outline:updateDetailed', id, chapterNumber, patch),
  getDetailedOutlineRaw: (id: string, chapterNumber: number) =>
    ipcRenderer.invoke('outline:getDetailedRaw', id, chapterNumber),
  generateDetailedOutline: (id: string, n: number) =>
    ipcRenderer.invoke('outline:generateDetailed', id, n),
  generateDetailedOutlineRange: (id: string, fromChapter: number, count: number) =>
    ipcRenderer.invoke('outline:generateDetailedRange', id, fromChapter, count) as Promise<DetailedOutlineItem[]>,
  getRhythm: (id: string) => ipcRenderer.invoke('outline:getRhythm', id),
  getVolumes: (id: string) => ipcRenderer.invoke('outline:getVolumes', id),
  exportChapters: (projectId: string, volumeNumber?: number) =>
    ipcRenderer.invoke('export:chapters', { projectId, volumeNumber }),
  getOutlineSections: (id: string) => ipcRenderer.invoke('outline:getSections', id),
  getVolumeOutlines: (id: string) => ipcRenderer.invoke('outline:getVolumeOutlines', id),
  getDiagnostics: (id: string) => ipcRenderer.invoke('diagnostics:report', id),
  fixDiagnostic: (id: string, kind: DiagnosticFixKind) =>
    ipcRenderer.invoke('diagnostics:fix', id, kind),
  listFigures: (id: string) => ipcRenderer.invoke('figure:list', id),
  readFigure: (id: string, fileName: string) => ipcRenderer.invoke('figure:read', id, fileName),
  openFigure: (id: string, fileName: string) => ipcRenderer.invoke('figure:open', id, fileName),
  /** 取消进行中的流式生成（传 generate/adjust 返回对象上的 requestId） */
  abortStream: (requestId: string) =>
    ipcRenderer.invoke('llm:abort', requestId) as Promise<{ ok: boolean }>,
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
    styleProfileId: string | null | undefined,
    tempContext: string | undefined,
    existingText: string | undefined,
    onToken: (token: string, done: boolean) => void,
    onGenerationStage?: (stage: ChapterGenerationStage) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    const stageHandler = (
      _e: unknown,
      payload: { requestId: string; stage: ChapterGenerationStage }
    ) => {
      if (payload.requestId === requestId) onGenerationStage?.(payload.stage)
    }
    ipcRenderer.on('llm:token', handler as never)
    if (onGenerationStage) ipcRenderer.on('write:generationStage', stageHandler as never)
    const result = ipcRenderer
      .invoke('write:generateChapter', {
        projectId,
        chapterNumber,
        styleProfileId,
        tempContext,
        existingText,
        requestId
      })
      .finally(() => {
        ipcRenderer.removeListener('llm:token', handler as never)
        if (onGenerationStage) ipcRenderer.removeListener('write:generationStage', stageHandler as never)
      }) as Promise<ChapterStreamResult>
    return makeStreamHandle(result, requestId)
  },
  planAdjustChapterStream: (
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    styleProfileId: string | null | undefined,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:planAdjustChapter', {
        projectId,
        chapterNumber,
        content,
        instruction,
        styleProfileId,
        requestId
      })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  adjustChapterStream: (
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    styleProfileId: string | null | undefined,
    onToken: (token: string, done: boolean) => void,
    confirmedPlan?: string | null,
    onGenerationStage?: (stage: ChapterGenerationStage) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    const stageHandler = (
      _e: unknown,
      payload: { requestId: string; stage: ChapterGenerationStage }
    ) => {
      if (payload.requestId === requestId) onGenerationStage?.(payload.stage)
    }
    ipcRenderer.on('llm:token', handler as never)
    if (onGenerationStage) ipcRenderer.on('write:generationStage', stageHandler as never)
    const result = ipcRenderer
      .invoke('write:adjustChapter', {
        projectId,
        chapterNumber,
        content,
        instruction,
        confirmedPlan: confirmedPlan ?? null,
        styleProfileId,
        requestId
      })
      .finally(() => {
        ipcRenderer.removeListener('llm:token', handler as never)
        if (onGenerationStage) ipcRenderer.removeListener('write:generationStage', stageHandler as never)
      }) as Promise<ChapterStreamResult>
    return makeStreamHandle(result, requestId)
  },
  getProjectsRoot: () => ipcRenderer.invoke('settings:getProjectsRoot'),
  setProjectsRoot: (path: string) => ipcRenderer.invoke('settings:setProjectsRoot', path),
  getTheme: () => ipcRenderer.invoke('settings:getTheme'),
  setTheme: (mode: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke('settings:setTheme', mode),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  reviewChapterStream: (
    projectId: string,
    chapterNumber: number,
    content: string | undefined,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:reviewChapter', { projectId, chapterNumber, content, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  answerChapterQuestionStream: (
    projectId: string,
    chapterNumber: number,
    content: string,
    question: string,
    history: { role: 'user' | 'assistant'; text: string }[],
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:answerChapterQuestion', {
        projectId,
        chapterNumber,
        content,
        question,
        history,
        requestId
      })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  detectCastStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:detectCast', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  detectRelationshipsStream: (
    projectId: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:detectRelationships', { projectId, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  checkOutlineStream: (
    projectId: string,
    chapterNumber: number,
    outline: string,
    content: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:checkOutline', { projectId, chapterNumber, outline, content, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  extractMemoryStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:extractMemory', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  applyMemory: (projectId: string, extraction: MemoryExtraction) =>
    ipcRenderer.invoke('write:applyMemory', { projectId, extraction }),
  invalidateChapterMemorySync: (projectId: string, chapterNumber: number) =>
    ipcRenderer.invoke('write:invalidateChapterMemorySync', { projectId, chapterNumber }),
  syncChapterAfterWrite: (
    projectId: string,
    chapterNumber: number,
    content: string,
    opts?: { force?: boolean }
  ) =>
    ipcRenderer.invoke('write:syncChapterAfterWrite', {
      projectId,
      chapterNumber,
      content,
      force: opts?.force === true
    }),
  getChapterSummary: (projectId: string, chapterNumber: number, content: string) =>
    ipcRenderer.invoke('write:getChapterSummary', { projectId, chapterNumber, content }),
  generateChapterSummary: (projectId: string, chapterNumber: number, content: string, force = false) =>
    ipcRenderer.invoke('write:generateChapterSummary', { projectId, chapterNumber, content, force }),
  selfCheckChapter: (projectId: string, chapterNumber: number, content: string) =>
    ipcRenderer.invoke('write:selfCheckChapter', {
      projectId,
      chapterNumber,
      content
    }),
  fixCharacterPositions: (projectId: string, chapterNumber: number, content: string) =>
    ipcRenderer.invoke('write:fixCharacterPositions', {
      projectId,
      chapterNumber,
      content
    }),
  checkAdjustPlanCompliance: (
    projectId: string,
    chapterNumber: number,
    content: string,
    items: string[]
  ) =>
    ipcRenderer.invoke('write:checkAdjustPlanCompliance', {
      projectId,
      chapterNumber,
      content,
      items
    }),
  undoChapterSync: (
    projectId: string,
    payload: {
      extraction: MemoryExtraction
      memory: MemoryApplyResult
      settings: SettingsApplyResult
    }
  ) =>
    ipcRenderer.invoke('write:undoChapterSync', {
      projectId,
      extraction: payload.extraction,
      memory: payload.memory,
      settings: payload.settings
    }),
  previewMemoryApply: (projectId: string, extraction: MemoryExtraction) =>
    ipcRenderer.invoke('write:previewMemoryApply', { projectId, extraction }),
  previewSettingsApply: (projectId: string, extraction: MemoryExtraction) =>
    ipcRenderer.invoke('write:previewSettingsApply', { projectId, extraction }),
  applySettingsPatches: (
    projectId: string,
    extraction: MemoryExtraction,
    onlyAuto?: boolean
  ) =>
    ipcRenderer.invoke('write:applySettingsPatches', {
      projectId,
      extraction,
      onlyAuto
    }),
  applyNewCharacters: (
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ) => ipcRenderer.invoke('write:applyNewCharacters', { projectId, chars }),
  applyNewLocations: (
    projectId: string,
    locs: MemoryExtraction['newLocations'],
    chapterNumber?: number
  ) =>
    ipcRenderer.invoke('write:applyNewLocations', {
      projectId,
      locs,
      chapterNumber
    }),
  applyNewItems: (
    projectId: string,
    items: MemoryExtraction['newItems']
  ) => ipcRenderer.invoke('write:applyNewItems', { projectId, items }),
  applyNewForeshadowings: (
    projectId: string,
    fs: MemoryExtraction['newForeshadowings']
  ) => ipcRenderer.invoke('write:applyNewForeshadowings', { projectId, fs }),
  applyAllNewEntities: (
    projectId: string,
    chapterNumber: number
  ) => ipcRenderer.invoke('write:applyAllNewEntities', { projectId, chapterNumber }),
  /** 应用 LLM 在正文末尾写下的【本章伏笔回执】到伏笔库 */
  applyForeshadowReceipt: (
    projectId: string,
    chapterNumber: number,
    receipt: { planted?: string[]; collected?: string[] }
  ) =>
    ipcRenderer.invoke('write:applyForeshadowReceipt', {
      projectId,
      chapterNumber,
      receipt
    }) as Promise<{ planted: number; collected: number; skipped: string[] }>,
  evaluateRhythmStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:evaluateRhythm', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  applyRhythmEvaluation: (projectId: string, evaluation: RhythmEvaluation) =>
    ipcRenderer.invoke('write:applyRhythmEvaluation', { projectId, evaluation }),
  generateFigureStream: (
    projectId: string,
    chapterNumber: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('llm:token', handler as never)
    const result = ipcRenderer
      .invoke('write:generateFigure', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },
  saveFigure: (projectId: string, fileName: string, html: string) =>
    ipcRenderer.invoke('write:saveFigure', { projectId, fileName, html }),
  generateBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void,
    // 调用方可自带 requestId，配合 abortStream(requestId) 实现「停止批量续写」
    externalRequestId?: string,
    /** 整批进度：失败后「重试当前章」回传，避免进度从头计数 */
    batchState?: { fromChapter: number; total: number; completed: number[]; pendingPostProcessChapter?: number },
    /** 连续模式：每章写完不暂停，一口气写到 toChapter（「一键写 N 章」） */
    autoContinue?: boolean,
    /** 按本章节奏自动调整生成强度（温度/思考强度），单次调用覆盖，不改保存的 provider 配置 */
    autoStrength?: boolean,
    /** 撞上 429 限流、正在退避等待重试时回调，供 UI 显示「第 N 章限流，30 秒后自动重试」 */
    onRetryWait?: (chapter: number, attempt: number, maxAttempts: number, waitMs: number) => void,
    onGenerationStage?: (stage: ChapterGenerationStage, chapterNumber: number) => void,
    onAutoDeslopResult?: (result: AutoDeslopResult, chapterNumber: number) => void
  ) => {
    const requestId = externalRequestId ?? crypto.randomUUID()
    const chapterHandler = (
      _e: unknown,
      payload: { requestId: string; chapter: number; result: ChapterFlowResult }
    ) => {
      if (payload.requestId === requestId) {
        onChapterComplete(payload.chapter, payload.result)
      }
    }
    const tokenHandler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId && onToken) {
        onToken(payload.token, payload.done)
      }
    }
    const retryWaitHandler = (
      _e: unknown,
      payload: { requestId: string; chapter: number; attempt: number; maxAttempts: number; waitMs: number }
    ) => {
      if (payload.requestId === requestId && onRetryWait) {
        onRetryWait(payload.chapter, payload.attempt, payload.maxAttempts, payload.waitMs)
      }
    }
    const stageHandler = (
      _e: unknown,
      payload: { requestId: string; stage: ChapterGenerationStage; chapterNumber: number }
    ) => {
      if (payload.requestId === requestId) onGenerationStage?.(payload.stage, payload.chapterNumber)
    }
    const autoDeslopHandler = (
      _e: unknown,
      payload: { requestId: string; result: AutoDeslopResult; chapterNumber: number }
    ) => {
      if (payload.requestId === requestId) onAutoDeslopResult?.(payload.result, payload.chapterNumber)
    }
    ipcRenderer.on('write:batchChapterComplete', chapterHandler as never)
    if (onToken) ipcRenderer.on('llm:token', tokenHandler as never)
    if (onRetryWait) ipcRenderer.on('write:batchRetryWait', retryWaitHandler as never)
    if (onGenerationStage) ipcRenderer.on('write:batchGenerationStage', stageHandler as never)
    if (onAutoDeslopResult) ipcRenderer.on('write:batchAutoDeslopResult', autoDeslopHandler as never)
    return ipcRenderer
      .invoke('write:generateBatch', {
        projectId,
        fromChapter,
        toChapter,
        styleProfileId,
        requestId,
        batchState,
        autoContinue,
        autoStrength
      })
      .finally(() => {
        ipcRenderer.removeListener('write:batchChapterComplete', chapterHandler as never)
        if (onToken) ipcRenderer.removeListener('llm:token', tokenHandler as never)
        if (onRetryWait) ipcRenderer.removeListener('write:batchRetryWait', retryWaitHandler as never)
        if (onGenerationStage) ipcRenderer.removeListener('write:batchGenerationStage', stageHandler as never)
        if (onAutoDeslopResult) ipcRenderer.removeListener('write:batchAutoDeslopResult', autoDeslopHandler as never)
      })
  },
  polishChaptersBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: SavedChapterPolishResult) => void,
    onProgress?: (chapter: number, step: string) => void,
    externalRequestId?: string
  ) => {
    const requestId = externalRequestId ?? crypto.randomUUID()
    const chapterHandler = (_e: unknown, payload: { requestId: string; chapter: number; result: SavedChapterPolishResult }) => {
      if (payload.requestId === requestId) onChapterComplete(payload.chapter, payload.result)
    }
    const progressHandler = (_e: unknown, payload: { requestId: string; chapter: number; step: string }) => {
      if (payload.requestId === requestId) onProgress?.(payload.chapter, payload.step)
    }
    ipcRenderer.on('write:batchPolishChapterComplete', chapterHandler as never)
    if (onProgress) ipcRenderer.on('write:batchPolishProgress', progressHandler as never)
    return ipcRenderer.invoke('write:polishChaptersBatch', {
      projectId, fromChapter, toChapter, styleProfileId, requestId
    }).finally(() => {
      ipcRenderer.removeListener('write:batchPolishChapterComplete', chapterHandler as never)
      if (onProgress) ipcRenderer.removeListener('write:batchPolishProgress', progressHandler as never)
    })
  },
  resumeBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void,
    externalRequestId?: string,
    /** 上一次 BatchProgress 的整批进度，用于续跑时延续计数而不是从头计 */
    batchState?: { fromChapter: number; total: number; completed: number[]; pendingPostProcessChapter?: number },
    /** 连续模式：每章写完不暂停，一口气写到 toChapter */
    autoContinue?: boolean,
    /** 按本章节奏自动调整生成强度（温度/思考强度），单次调用覆盖，不改保存的 provider 配置 */
    autoStrength?: boolean,
    /** 撞上 429 限流、正在退避等待重试时回调，供 UI 显示「第 N 章限流，30 秒后自动重试」 */
    onRetryWait?: (chapter: number, attempt: number, maxAttempts: number, waitMs: number) => void,
    onGenerationStage?: (stage: ChapterGenerationStage, chapterNumber: number) => void,
    onAutoDeslopResult?: (result: AutoDeslopResult, chapterNumber: number) => void
  ) => {
    const requestId = externalRequestId ?? crypto.randomUUID()
    const chapterHandler = (
      _e: unknown,
      payload: { requestId: string; chapter: number; result: ChapterFlowResult }
    ) => {
      if (payload.requestId === requestId) {
        onChapterComplete(payload.chapter, payload.result)
      }
    }
    const tokenHandler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId && onToken) {
        onToken(payload.token, payload.done)
      }
    }
    const retryWaitHandler = (
      _e: unknown,
      payload: { requestId: string; chapter: number; attempt: number; maxAttempts: number; waitMs: number }
    ) => {
      if (payload.requestId === requestId && onRetryWait) {
        onRetryWait(payload.chapter, payload.attempt, payload.maxAttempts, payload.waitMs)
      }
    }
    const stageHandler = (
      _e: unknown,
      payload: { requestId: string; stage: ChapterGenerationStage; chapterNumber: number }
    ) => {
      if (payload.requestId === requestId) onGenerationStage?.(payload.stage, payload.chapterNumber)
    }
    const autoDeslopHandler = (
      _e: unknown,
      payload: { requestId: string; result: AutoDeslopResult; chapterNumber: number }
    ) => {
      if (payload.requestId === requestId) onAutoDeslopResult?.(payload.result, payload.chapterNumber)
    }
    ipcRenderer.on('write:batchChapterComplete', chapterHandler as never)
    if (onToken) ipcRenderer.on('llm:token', tokenHandler as never)
    if (onRetryWait) ipcRenderer.on('write:batchRetryWait', retryWaitHandler as never)
    if (onGenerationStage) ipcRenderer.on('write:batchGenerationStage', stageHandler as never)
    if (onAutoDeslopResult) ipcRenderer.on('write:batchAutoDeslopResult', autoDeslopHandler as never)
    return ipcRenderer
      .invoke('write:resumeBatch', {
        projectId,
        fromChapter,
        toChapter,
        styleProfileId,
        requestId,
        batchState,
        autoContinue,
        autoStrength
      })
      .finally(() => {
        ipcRenderer.removeListener('write:batchChapterComplete', chapterHandler as never)
        if (onToken) ipcRenderer.removeListener('llm:token', tokenHandler as never)
        if (onRetryWait) ipcRenderer.removeListener('write:batchRetryWait', retryWaitHandler as never)
        if (onGenerationStage) ipcRenderer.removeListener('write:batchGenerationStage', stageHandler as never)
        if (onAutoDeslopResult) ipcRenderer.removeListener('write:batchAutoDeslopResult', autoDeslopHandler as never)
      })
  },
  listMemoryCandidates: (projectId: string) =>
    ipcRenderer.invoke('memory:listCandidates', { projectId }),
  inspectMemoryCandidate: (projectId: string, chapterNumber: number) =>
    ipcRenderer.invoke('write:inspectMemoryCandidate', { projectId, chapterNumber }),
  forceApplyMemoryCandidateItems: (
    projectId: string,
    chapterNumber: number,
    picks: { kind: string; index: number }[]
  ) =>
    ipcRenderer.invoke('write:forceApplyMemoryCandidateItems', { projectId, chapterNumber, picks }),
  getUsageSummary: () => ipcRenderer.invoke('usage:summary'),
  getUsageDayDetail: (date: string) => ipcRenderer.invoke('usage:dayDetail', date),
  getUsageByProject: () => ipcRenderer.invoke('usage:byProject'),
  getUsageByChapter: () => ipcRenderer.invoke('usage:byChapter'),
  getUsageChapterDetail: (projectId: string, chapterNumber: number) =>
    ipcRenderer.invoke('usage:chapterDetail', projectId, chapterNumber),
  clearUsage: () => ipcRenderer.invoke('usage:clear'),
  getPricing: async () => {
    const all = await ipcRenderer.invoke('settings:getAll')
    return all.pricing
  },
  setPricing: (patch: { inputRate?: number; outputRate?: number }) =>
    ipcRenderer.invoke('settings:setPricing', patch),
  getDailyWordGoal: async () => {
    const all = await ipcRenderer.invoke('settings:getAll')
    return all.dailyWordGoal ?? 3000
  },
  setDailyWordGoal: (goal: number) => ipcRenderer.invoke('settings:setDailyGoal', goal),
  getPomodoroConfig: async () => {
    const all = await ipcRenderer.invoke('settings:getAll')
    return { focus: all.pomodoroFocus ?? 25, brk: all.pomodoroBreak ?? 5 }
  },
  setPomodoroConfig: (cfg: { focus: number; brk: number }) =>
    ipcRenderer.invoke('settings:setPomodoro', cfg),
  auditChapter: (projectId: string, content: string) =>
    ipcRenderer.invoke('write:auditChapter', { projectId, content }),
  humanizeSegment: (
    projectId: string,
    snippet: string,
    violationType: string,
    chapterNumber?: number
  ) =>
    ipcRenderer.invoke('write:humanizeSegment', {
      projectId,
      snippet,
      violationType,
      chapterNumber
    }),
  /** LLM 深度审稿：跑角色崩坏/逻辑漏洞等语义检查，返回 findings */
  runDeepReview: (projectId: string, content: string, chapterNumber: number) =>
    ipcRenderer.invoke('write:runDeepReview', { projectId, content, chapterNumber }),
  /** 结构化审核报告（对齐正文审核技能第 6 步）：10 节报告 */
  generateReviewReport: (projectId: string, content: string, chapterNumber: number) =>
    ipcRenderer.invoke('write:reviewReport', { projectId, content, chapterNumber }),
  getWriteAuditConfig: async () => {
    const all = await ipcRenderer.invoke('settings:getAll')
    return {
      enabled: all.writeAudit?.enabled ?? true,
      mode: all.writeAudit?.mode ?? 'soft'
    }
  },
  setWriteAuditConfig: (cfg: { enabled?: boolean; mode?: 'soft' | 'strict' }) =>
    ipcRenderer.invoke('settings:setWriteAudit', cfg),
  getSettingsEvolution: () =>
    ipcRenderer.invoke('settings:getSettingsEvolution') as Promise<
      'off' | 'confirm_all' | 'auto_high'
    >,
  setSettingsEvolution: (mode: 'off' | 'confirm_all' | 'auto_high') =>
    ipcRenderer.invoke('settings:setSettingsEvolution', mode) as Promise<
      'off' | 'confirm_all' | 'auto_high'
    >,
  getAutoMemorySync: () =>
    ipcRenderer.invoke('settings:getAutoMemorySync') as Promise<boolean>,
  setAutoMemorySync: (enabled: boolean) =>
    ipcRenderer.invoke('settings:setAutoMemorySync', enabled) as Promise<boolean>,
  getAutoPostWritePipeline: () =>
    ipcRenderer.invoke('settings:getAutoPostWritePipeline') as Promise<
      'off' | 'memory_only' | 'full'
    >,
  setAutoPostWritePipeline: (mode: 'off' | 'memory_only' | 'full') =>
    ipcRenderer.invoke('settings:setAutoPostWritePipeline', mode) as Promise<
      'off' | 'memory_only' | 'full'
    >,
  // P13-C：用量预警配置
  getCostAlertConfig: () => ipcRenderer.invoke('settings:getCostAlert'),
  setCostAlertConfig: (cfg: { enabled?: boolean; warning?: number; exceeded?: number }) =>
    ipcRenderer.invoke('settings:setCostAlert', cfg),
  /** AI 高频词配置 */
  getAiHighFreqConfig: () => ipcRenderer.invoke('settings:getAiHighFreq'),
  setAiHighFreqConfig: (cfg: {
    enabled?: boolean
    words?: { word: string; example?: string }[]
  }) => ipcRenderer.invoke('settings:setAiHighFreq', cfg),
  getWritingRequirementTemplates: () => ipcRenderer.invoke('settings:getWritingRequirementTemplates'),
  setWritingRequirementTemplates: (templates: {
    id: string
    name: string
    description: string
    requirements: string[]
  }[]) => ipcRenderer.invoke('settings:setWritingRequirementTemplates', templates),
  getChapterRules: () => ipcRenderer.invoke('settings:getChapterRules'),
  setChapterRules: (overrides: Record<string, string>) =>
    ipcRenderer.invoke('settings:setChapterRules', overrides),
  /** 审稿规则：检查项清单 + 当前配置 */
  getReviewRules: () => ipcRenderer.invoke('settings:getReviewRules'),
  /** 保存审稿规则配置（开关/阈值/词表） */
  setReviewRules: (cfg: Partial<ReviewRulesConfig>) =>
    ipcRenderer.invoke('settings:setReviewRules', cfg),

  /* ---- 拆文库（长/短篇拆文）---- */
  listTeardowns: () => ipcRenderer.invoke('teardown:list'),
  startTeardown: (input: StartTeardownInput) =>
    ipcRenderer.invoke('teardown:start', input),
  runTeardown: (
    bookName: string,
    lengthKind: TeardownLengthKind,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('teardown:token', handler as never)
    return ipcRenderer
      .invoke('teardown:run', { bookName, lengthKind, requestId })
      .finally(() => ipcRenderer.removeListener('teardown:token', handler as never))
  },
  continueTeardown: (
    bookName: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('teardown:token', handler as never)
    return ipcRenderer
      .invoke('teardown:continue', { bookName, requestId })
      .finally(() => ipcRenderer.removeListener('teardown:token', handler as never))
  },
  getTeardownProgress: (bookName: string) =>
    ipcRenderer.invoke('teardown:progress', bookName) as Promise<TeardownProgressInfo>,
  getTeardownFiles: (bookName: string) =>
    ipcRenderer.invoke('teardown:files', bookName) as Promise<TeardownFileNode[]>,
  readTeardownFile: (bookName: string, path: string) =>
    ipcRenderer.invoke('teardown:readFile', { bookName, path }) as Promise<TeardownFileContent | null>,
  deleteTeardown: (bookName: string) =>
    ipcRenderer.invoke('teardown:delete', bookName),

  /* ---- 扫榜（story-long-scan / story-short-scan）---- */
  scanRank: (input: ScanRankInput) =>
    ipcRenderer.invoke('scan:rank', input) as Promise<ScanResult>,
  listScanReports: () =>
    ipcRenderer.invoke('scan:list') as Promise<ScanReportSummary[]>,
  readScanReport: (fileName: string) =>
    ipcRenderer.invoke('scan:read', fileName) as Promise<string | null>,
  deleteScanReport: (fileName: string) =>
    ipcRenderer.invoke('scan:delete', fileName),
  analyzeRankStream: (
    report: string,
    platform: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('scan:token', handler as never)
    const result = ipcRenderer
      .invoke('scan:analyze', { report, platform, requestId })
      .finally(() => ipcRenderer.removeListener('scan:token', handler as never)) as Promise<{
      ok: boolean
      error?: string
    }>
    return makeStreamHandle(result, requestId)
  },

  /* ---- 去 AI 味润色（story-deslop）---- */
  deslopScan: (projectId: string, text: string) =>
    ipcRenderer.invoke('deslop:scan', { projectId, text }) as Promise<DeslopScanReport>,
  deslopStream: (
    projectId: string,
    text: string,
    levelOverride: DeslopLevel | undefined,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('deslop:token', handler as never)
    const result = ipcRenderer
      .invoke('deslop:run', { projectId, text, levelOverride, requestId })
      .finally(() => ipcRenderer.removeListener('deslop:token', handler as never)) as Promise<DeslopResult>
    return makeStreamHandle(result, requestId)
  },
  /** 结构体检：LLM 判定层，只返回诊断清单，不改正文 */
  deslopJudgeStream: (
    projectId: string,
    text: string,
    onToken: (token: string, done: boolean) => void,
    context?: { outlineSummary?: string; chapterGoal?: string }
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('deslopJudge:token', handler as never)
    const result = ipcRenderer
      .invoke('deslop:judge', {
        projectId,
        text,
        requestId,
        outlineSummary: context?.outlineSummary,
        chapterGoal: context?.chapterGoal
      })
      .finally(() =>
        ipcRenderer.removeListener('deslopJudge:token', handler as never)
      ) as Promise<DeslopStructureReport>
    return makeStreamHandle(result, requestId)
  },
  normalizePunctuation: (text: string) =>
    ipcRenderer.invoke('deslop:normalizePunctuation', { text }) as Promise<{
      text: string
      changed: number
    }>,
  getDeslopWhitelist: (projectId: string) =>
    ipcRenderer.invoke('deslop:getWhitelist', projectId) as Promise<string[]>,
  setDeslopWhitelist: (projectId: string, words: string[]) =>
    ipcRenderer.invoke('deslop:setWhitelist', { projectId, words }) as Promise<string[]>,
  /* 去 AI 味规则（设置页展示/编辑/AI 改写） */
  getDeslopRules: () =>
    ipcRenderer.invoke('deslop:getRules') as Promise<DeslopRulesBundle>,
  setDeslopRules: (cfg: {
    textOverrides: Record<string, string>
    bannedWords: string[]
  }) =>
    ipcRenderer.invoke('deslop:setRules', cfg) as Promise<DeslopRulesBundle>,
  editDeslopRulesStream: (
    instruction: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('deslopRules:token', handler as never)
    const result = ipcRenderer
      .invoke('deslop:editRulesStream', { instruction, requestId })
      .finally(() => ipcRenderer.removeListener('deslopRules:token', handler as never)) as Promise<string>
    return makeStreamHandle(result, requestId)
  },

  /* ---- 封面生成（story-cover）---- */
  extractCoverPrompt: (input: ExtractCoverPromptInput) =>
    ipcRenderer.invoke('cover:extractPrompt', input) as Promise<CoverPromptDraft>,
  buildCoverPrompt: (input: GenerateCoverInput) =>
    ipcRenderer.invoke('cover:buildPrompt', input) as Promise<string>,
  getCoverPromptContext: (input: GenerateCoverInput) =>
    ipcRenderer.invoke('cover:getPromptContext', input) as Promise<CoverLearningContext>,
  generateCover: (input: GenerateCoverInput) =>
    ipcRenderer.invoke('cover:generate', input) as Promise<CoverFile>,
  getCoverGenerationTask: (projectId: string) =>
    ipcRenderer.invoke('cover:getGenerationTask', projectId) as Promise<CoverGenerationTaskState | null>,
  cancelCoverGenerationTask: (projectId: string) =>
    ipcRenderer.invoke('cover:cancelGenerationTask', projectId) as Promise<{ ok: boolean }>,
  updateCoverCrop: (input: UpdateCoverCropInput) =>
    ipcRenderer.invoke('cover:updateCrop', input) as Promise<CoverFile>,
  listCovers: (projectId: string) =>
    ipcRenderer.invoke('cover:list', projectId) as Promise<CoverFile[]>,
  updateCoverFeedback: (input: UpdateCoverFeedbackInput) =>
    ipcRenderer.invoke('cover:updateFeedback', input) as Promise<CoverFile>,
  readCover: (projectId: string, fileName: string) =>
    ipcRenderer.invoke('cover:read', { projectId, fileName }) as Promise<string | null>,
  showCoverInFolder: (projectId: string, fileName: string) =>
    ipcRenderer.invoke('cover:showInFolder', { projectId, fileName }) as Promise<{ ok: true }>,
  getCoverImageConfig: () =>
    ipcRenderer.invoke('cover:getConfig') as Promise<CoverImageConfigSummary>,
  setCoverImageConfig: (cfg: Partial<CoverImageConfigInput>) =>
    ipcRenderer.invoke('cover:setConfig', cfg) as Promise<CoverImageConfigSummary>,
  getCoverLearningLibrary: () =>
    ipcRenderer.invoke('cover:getLearningLibrary') as Promise<CoverLearningLibrarySummary>,
  setCoverLearningLibraryDirectory: (directory: string) =>
    ipcRenderer.invoke('cover:setLearningLibraryDirectory', directory) as Promise<CoverLearningLibrarySummary>,
  chooseCoverLearningLibraryDirectory: () =>
    ipcRenderer.invoke('cover:chooseLearningLibraryDirectory') as Promise<CoverLearningLibrarySummary | null>,
  chooseAndLearnCoverFolder: (options: CoverLearningOptions = {}) =>
    ipcRenderer.invoke('cover:chooseAndLearnFolder', options) as Promise<CoverLearningRunResult | null>,
  getCoverLearningTask: () =>
    ipcRenderer.invoke('cover:getLearningTask') as Promise<CoverLearningTaskState | null>,
  cancelCoverLearningTask: () =>
    ipcRenderer.invoke('cover:cancelLearningTask') as Promise<{ ok: boolean }>,
  rollbackCoverLearningRules: () =>
    ipcRenderer.invoke('cover:rollbackLearningRules') as Promise<CoverLearningLibrarySummary>,
  setCoverLearningRuleEnabled: (input: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('cover:setLearningRuleEnabled', input) as Promise<CoverLearningLibrarySummary>,

  getBookTest: (projectId: string) =>
    ipcRenderer.invoke('bookTest:get', projectId) as Promise<BookTestState>,
  patchBookTest: (input: PatchBookTestInput) =>
    ipcRenderer.invoke('bookTest:patch', input) as Promise<BookTestState>,
  generateBookTestTitles: (input: GenerateBookTestTitlesInput) =>
    ipcRenderer.invoke('bookTest:generateTitles', input) as Promise<BookTestState>,
  replaceBookTestTitle: (projectId: string, candidateId: string) =>
    ipcRenderer.invoke('bookTest:replaceTitle', { projectId, id: candidateId }) as Promise<BookTestState>,
  updateBookTestCandidate: (input: UpdateBookTestCandidateInput) =>
    ipcRenderer.invoke('bookTest:update', input) as Promise<BookTestState>,
  deleteBookTestCandidate: (projectId: string, candidateId: string) =>
    ipcRenderer.invoke('bookTest:delete', { projectId, id: candidateId }) as Promise<BookTestState>,
  generateBookTestCover: (projectId: string, candidateId: string, authorName?: string) =>
    ipcRenderer.invoke('bookTest:generateCover', { projectId, id: candidateId, authorName }) as Promise<BookTestState>,

  onProjectFilesChanged: (
    cb: (e: { projectId: string; kind: 'outline' | 'rhythm' | 'progress' | 'characters' | 'prose' }) => void
  ) => {
    const handler = (_e: unknown, payload: { projectId: string; kind: string }) => {
      cb(payload as { projectId: string; kind: 'outline' | 'rhythm' | 'progress' | 'characters' | 'prose' })
    }
    ipcRenderer.on('project:files-changed', handler as never)
    return () => ipcRenderer.removeListener('project:files-changed', handler as never)
  }
} as const

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
