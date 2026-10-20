import { contextBridge, ipcRenderer } from 'electron'
import { createRendererApi, type IpcTransport } from './api'

contextBridge.exposeInMainWorld(
  'api',
  createRendererApi(ipcRenderer as unknown as IpcTransport)
)
