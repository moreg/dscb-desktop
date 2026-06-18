import { ipcMain } from 'electron'
import { OutlineService } from '../data/outline-service'

export function registerOutlineIpc(service: OutlineService): void {
  ipcMain.handle('outline:getMain', (_e, projectId: string) => service.getMain(projectId))
  ipcMain.handle('outline:generateMain', (_e, projectId: string) =>
    service.generateMain(projectId)
  )
  ipcMain.handle('outline:listDetailed', (_e, projectId: string) =>
    service.listDetailed(projectId)
  )
  ipcMain.handle('outline:generateDetailed', (_e, projectId: string, chapterNumber: number) =>
    service.generateDetailed(projectId, chapterNumber)
  )
}
