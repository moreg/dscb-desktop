import { contextBridge, ipcRenderer } from 'electron'
import type {
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
  ProviderConfig,
  RhythmEvaluation,
  ChapterFlowResult,
  ListProvidersResult,
  CreateStyleProfileInput,
  UpdateStyleProfileInput,
  TeardownEntry,
  StartTeardownInput,
  TeardownRouteResult,
  TeardownLengthKind,
  TeardownProgressInfo,
  TeardownFileNode,
  TeardownFileContent,
  ScanRankInput,
  ScanResult,
  ScanReportSummary,
  DeslopScanReport,
  DeslopLevel,
  DeslopResult,
  DeslopRulesBundle,
  GenerateCoverInput,
  CoverFile,
  CoverImageConfigSummary,
  CoverImageConfigInput,
  ReviewRulesConfig
} from '../shared/types'

const api = {
  listProjects: () => ipcRenderer.invoke('library:list'),
  scanProjects: () => ipcRenderer.invoke('library:scan'),
  createProject: (input: CreateProjectDataInput) => ipcRenderer.invoke('projects:create', input),
  getProject: (id: string) => ipcRenderer.invoke('projects:get', id),
  setBenchmarkBooks: (projectId: string, books: string[]) =>
    ipcRenderer.invoke('projects:setBenchmarkBooks', { projectId, books }) as Promise<string[]>,
  watchProject: (projectId: string) => ipcRenderer.invoke('projects:watch', projectId) as Promise<boolean>,
  stopWatchProject: () => ipcRenderer.invoke('projects:stopWatch') as Promise<boolean>,
  listStyleProfiles: (projectId: string) => ipcRenderer.invoke('styles:list', projectId),
  createStyleProfile: (projectId: string, input: CreateStyleProfileInput) =>
    ipcRenderer.invoke('styles:create', { projectId, input }),
  updateStyleProfile: (projectId: string, styleProfileId: string, patch: UpdateStyleProfileInput) =>
    ipcRenderer.invoke('styles:update', { projectId, styleProfileId, patch }),
  deleteStyleProfile: (projectId: string, styleProfileId: string) =>
    ipcRenderer.invoke('styles:delete', { projectId, styleProfileId }),
  extractStyleProfile: (projectId: string, sampleText: string, name?: string) =>
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
  /** P19-E：字数汇总（节奏图谱 + 章节进度笔记） */
  getChapterWordSummary: (projectId: string) =>
    ipcRenderer.invoke('chapters:wordSummary', projectId),
  updateChapterMeta: (id: string, n: number, patch: UpdateChapterMetaInput) =>
    ipcRenderer.invoke('chapters:updateMeta', id, n, patch),
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
  configureLlm: (apiKey: string) => ipcRenderer.invoke('llm:configure', apiKey),
  hasLlmKey: () => ipcRenderer.invoke('llm:hasKey'),
  pingLlm: () => ipcRenderer.invoke('llm:ping'),
  listAntigravityModels: () =>
    ipcRenderer.invoke('llm:listAntigravityModels') as Promise<string[]>,
  listCodexModels: () =>
    ipcRenderer.invoke('llm:listCodexModels') as Promise<string[]>,
  listProviders: () => ipcRenderer.invoke('llm:listProviders'),
  upsertProvider: (p: ProviderConfig) => ipcRenderer.invoke('llm:upsertProvider', p),
  deleteProvider: (id: string) => ipcRenderer.invoke('llm:deleteProvider', id),
  setActiveProvider: (id: string) => ipcRenderer.invoke('llm:setActive', id),
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
    return ipcRenderer
      .invoke('llm:generate', { prompt, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
  },
  getMainOutline: (id: string) => ipcRenderer.invoke('outline:getMain', id),
  updateMainOutline: (id: string, patch: Partial<MainOutline>) =>
    ipcRenderer.invoke('outline:updateMain', id, patch),
  generateMainOutline: (id: string) => ipcRenderer.invoke('outline:generateMain', id),
  listDetailedOutline: (id: string) => ipcRenderer.invoke('outline:listDetailed', id),
  updateDetailedOutline: (id: string, chapterNumber: number, patch: Partial<DetailedOutlineItem>) =>
    ipcRenderer.invoke('outline:updateDetailed', id, chapterNumber, patch),
  generateDetailedOutline: (id: string, n: number) =>
    ipcRenderer.invoke('outline:generateDetailed', id, n),
  generateDetailedOutlineRange: (id: string, fromChapter: number, count: number) =>
    ipcRenderer.invoke('outline:generateDetailedRange', id, fromChapter, count) as Promise<DetailedOutlineItem[]>,
  getRhythm: (id: string) => ipcRenderer.invoke('outline:getRhythm', id),
  getVolumes: (id: string) => ipcRenderer.invoke('outline:getVolumes', id),
  getOutlineSections: (id: string) => ipcRenderer.invoke('outline:getSections', id),
  getVolumeOutlines: (id: string) => ipcRenderer.invoke('outline:getVolumeOutlines', id),
  getDiagnostics: (id: string) => ipcRenderer.invoke('diagnostics:report', id),
  listFigures: (id: string) => ipcRenderer.invoke('figure:list', id),
  readFigure: (id: string, fileName: string) => ipcRenderer.invoke('figure:read', id, fileName),
  openFigure: (id: string, fileName: string) => ipcRenderer.invoke('figure:open', id, fileName),
  generateChapterStream: (
    projectId: string,
    chapterNumber: number,
    styleProfileId: string | null | undefined,
    tempContext: string | undefined,
    existingText: string | undefined,
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
    return ipcRenderer
      .invoke('write:generateChapter', { projectId, chapterNumber, styleProfileId, tempContext, existingText, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
  },
  adjustChapterStream: (
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
    return ipcRenderer
      .invoke('write:adjustChapter', { projectId, chapterNumber, content, instruction, styleProfileId, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:reviewChapter', { projectId, chapterNumber, content, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:detectCast', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:detectRelationships', { projectId, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:checkOutline', { projectId, chapterNumber, outline, content, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:extractMemory', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
  },
  applyMemory: (projectId: string, extraction: MemoryExtraction) =>
    ipcRenderer.invoke('write:applyMemory', { projectId, extraction }),
  applyNewCharacters: (
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ) => ipcRenderer.invoke('write:applyNewCharacters', { projectId, chars }),
  applyNewLocations: (
    projectId: string,
    locs: MemoryExtraction['newLocations']
  ) => ipcRenderer.invoke('write:applyNewLocations', { projectId, locs }),
  applyNewForeshadowings: (
    projectId: string,
    fs: MemoryExtraction['newForeshadowings']
  ) => ipcRenderer.invoke('write:applyNewForeshadowings', { projectId, fs }),
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
    return ipcRenderer
      .invoke('write:evaluateRhythm', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
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
    return ipcRenderer
      .invoke('write:generateFigure', { projectId, chapterNumber, requestId })
      .finally(() => ipcRenderer.removeListener('llm:token', handler as never))
  },
  saveFigure: (projectId: string, fileName: string, html: string) =>
    ipcRenderer.invoke('write:saveFigure', { projectId, fileName, html }),
  generateBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
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
    ipcRenderer.on('write:batchChapterComplete', chapterHandler as never)
    if (onToken) ipcRenderer.on('llm:token', tokenHandler as never)
    return ipcRenderer
      .invoke('write:generateBatch', {
        projectId,
        fromChapter,
        toChapter,
        styleProfileId,
        requestId
      })
      .finally(() => {
        ipcRenderer.removeListener('write:batchChapterComplete', chapterHandler as never)
        if (onToken) ipcRenderer.removeListener('llm:token', tokenHandler as never)
      })
  },
  resumeBatch: (
    projectId: string,
    fromChapter: number,
    toChapter: number,
    styleProfileId: string | null | undefined,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    onToken?: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
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
    ipcRenderer.on('write:batchChapterComplete', chapterHandler as never)
    if (onToken) ipcRenderer.on('llm:token', tokenHandler as never)
    return ipcRenderer
      .invoke('write:resumeBatch', {
        projectId,
        fromChapter,
        toChapter,
        styleProfileId,
        requestId
      })
      .finally(() => {
        ipcRenderer.removeListener('write:batchChapterComplete', chapterHandler as never)
        if (onToken) ipcRenderer.removeListener('llm:token', tokenHandler as never)
      })
  },
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
    return ipcRenderer
      .invoke('scan:analyze', { report, platform, requestId })
      .finally(() => ipcRenderer.removeListener('scan:token', handler as never))
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
    return ipcRenderer
      .invoke('deslop:run', { projectId, text, levelOverride, requestId })
      .finally(() => ipcRenderer.removeListener('deslop:token', handler as never)) as Promise<DeslopResult>
  },
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
    return ipcRenderer
      .invoke('deslop:editRulesStream', { instruction, requestId })
      .finally(() => ipcRenderer.removeListener('deslopRules:token', handler as never)) as Promise<string>
  },

  /* ---- 封面生成（story-cover）---- */
  generateCover: (input: GenerateCoverInput) =>
    ipcRenderer.invoke('cover:generate', input) as Promise<CoverFile>,
  listCovers: (projectId: string) =>
    ipcRenderer.invoke('cover:list', projectId) as Promise<CoverFile[]>,
  readCover: (projectId: string, fileName: string) =>
    ipcRenderer.invoke('cover:read', { projectId, fileName }) as Promise<string | null>,
  getCoverImageConfig: () =>
    ipcRenderer.invoke('cover:getConfig') as Promise<CoverImageConfigSummary>,
  setCoverImageConfig: (cfg: Partial<CoverImageConfigInput>) =>
    ipcRenderer.invoke('cover:setConfig', cfg) as Promise<CoverImageConfigSummary>,

  /* ---- 开书（story-long-write Phase 1-3）---- */
  openingCoreSettingsStream: (
    projectId: string,
    brainDump: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:coreSettings', { projectId, brainDump, requestId })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
  openingVolumeOutlineStream: (
    projectId: string,
    coreSettings: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:volumeOutline', { projectId, coreSettings, requestId })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
  openingFirstChaptersStream: (
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    fromChapter: number,
    count: number,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:firstChapters', {
        projectId,
        coreSettings,
        volumeOutline,
        fromChapter,
        count,
        requestId
      })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
  persistOpening: (
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    chaptersMarkdown?: string,
    fromChapter?: number
  ) =>
    ipcRenderer.invoke('opening:persist', {
      projectId,
      coreSettings,
      volumeOutline,
      chaptersMd: chaptersMarkdown,
      fromChapter
    }),
  generateRhythm: (
    projectId: string,
    volumeOutline: string
  ): Promise<{ ok: boolean; html?: string; error?: string }> =>
    ipcRenderer.invoke('opening:generateRhythm', { projectId, volumeOutline }),
  continueCoreSettingsStream: (
    projectId: string,
    brainDump: string,
    partial: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:continueCoreSettings', { projectId, brainDump, partial, requestId })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
  continueVolumeOutlineStream: (
    projectId: string,
    coreSettings: string,
    partial: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:continueVolumeOutline', { projectId, coreSettings, partial, requestId })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
  continueFirstChaptersStream: (
    projectId: string,
    coreSettings: string,
    volumeOutline: string,
    fromChapter: number,
    count: number,
    partial: string,
    onToken: (token: string, done: boolean) => void
  ) => {
    const requestId = crypto.randomUUID()
    const handler = (
      _e: unknown,
      payload: { requestId: string; token: string; done: boolean }
    ) => {
      if (payload.requestId === requestId) onToken(payload.token, payload.done)
    }
    ipcRenderer.on('opening:token', handler as never)
    return ipcRenderer
      .invoke('opening:continueFirstChapters', {
        projectId,
        coreSettings,
        volumeOutline,
        fromChapter,
        count,
        partial,
        requestId
      })
      .finally(() => ipcRenderer.removeListener('opening:token', handler as never))
  },
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
