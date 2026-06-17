import { ipcMain } from 'electron'
import { ProjectService } from '../data/project-service'
import type { CreateProjectDataInput } from '../../shared/types'

export function registerProjectsIpc(service: ProjectService): void {
  ipcMain.handle('projects:create', (_e, input: CreateProjectDataInput) => service.create(input))
  ipcMain.handle('projects:get', (_e, id: string) => service.getProjectData(id))
}
