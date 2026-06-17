import { ipcMain } from 'electron'
import { MemoryService } from '../data/memory-service'
import type { CreateCharacterInput, UpdateCharacterInput } from '../../shared/types'

export function registerMemoryIpc(service: MemoryService): void {
  ipcMain.handle('memory:character:list', (_e, projectId: string) =>
    service.listCharacters(projectId)
  )
  ipcMain.handle('memory:character:get', (_e, projectId: string, id: string) =>
    service.getCharacter(projectId, id)
  )
  ipcMain.handle(
    'memory:character:create',
    (_e, projectId: string, input: CreateCharacterInput) => service.createCharacter(projectId, input)
  )
  ipcMain.handle(
    'memory:character:update',
    (_e, projectId: string, id: string, patch: UpdateCharacterInput) =>
      service.updateCharacter(projectId, id, patch)
  )
  ipcMain.handle('memory:character:delete', (_e, projectId: string, id: string) =>
    service.deleteCharacter(projectId, id)
  )
  ipcMain.handle('memory:history:list', (_e, projectId: string) => service.listHistory(projectId))
}
