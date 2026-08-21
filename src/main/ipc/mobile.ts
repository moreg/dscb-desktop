import { ipcMain } from 'electron'
import type { MobileServer } from '../mobile/mobile-server'

export function registerMobileIpc(server: MobileServer): void {
  ipcMain.handle('mobile:status', () => server.getStatus())
  ipcMain.handle('mobile:start', () => server.start())
  ipcMain.handle('mobile:stop', () => server.stop())
  ipcMain.handle('mobile:refreshPairing', () => server.refreshPairing())
}
