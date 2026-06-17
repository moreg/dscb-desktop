import { contextBridge, ipcRenderer } from 'electron'
import type { CreateProjectInput } from '../main/data/library-repository'

const api = {
  listProjects: () => ipcRenderer.invoke('library:list'),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke('library:create', input)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
