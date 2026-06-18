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
  UpdateRelationshipInput
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
    ipcRenderer.invoke('memory:relationship:delete', id, rid)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
