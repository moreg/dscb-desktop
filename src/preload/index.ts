import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateProjectDataInput,
  CreateChapterInput,
  UpdateChapterMetaInput
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
  deleteChapter: (id: string, n: number) => ipcRenderer.invoke('chapters:delete', id, n)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
