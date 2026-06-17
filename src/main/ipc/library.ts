import { ipcMain } from 'electron'
import { LibraryRepository, type CreateProjectInput } from '../data/library-repository'
import type { ProjectMeta } from '../../shared/types'

export function registerLibraryIpc(repo: LibraryRepository): void {
  ipcMain.handle('library:list', async (): Promise<ProjectMeta[]> => repo.list())
  ipcMain.handle(
    'library:create',
    async (_e, input: CreateProjectInput): Promise<ProjectMeta> => repo.create(input)
  )
}
