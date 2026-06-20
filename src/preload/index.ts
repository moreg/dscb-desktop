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
  ProviderConfig,
  ListProvidersResult
} from '../shared/types'

const api = {
  listProjects: () => ipcRenderer.invoke('library:list'),
  createProject: (input: CreateProjectDataInput) => ipcRenderer.invoke('projects:create', input),
  getProject: (id: string) => ipcRenderer.invoke('projects:get', id),
  listChapters: (id: string) => ipcRenderer.invoke('chapters:list', id),
  getChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:get', id, n),
  createChapter: (id: string, input: CreateChapterInput) =>
    ipcRenderer.invoke('chapters:create', id, input),
  updateChapterContent: (id: string, n: number, content: string) =>
    ipcRenderer.invoke('chapters:updateContent', id, n, content),
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
  generateDetailedOutline: (id: string, n: number) =>
    ipcRenderer.invoke('outline:generateDetailed', id, n),
  generateChapterStream: (
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
      .invoke('write:generateChapter', { projectId, chapterNumber, requestId })
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
      .invoke('write:reviewChapter', { projectId, chapterNumber, requestId })
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
  getUsageSummary: () => ipcRenderer.invoke('usage:summary'),
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
    ipcRenderer.invoke('settings:setPomodoro', cfg)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
