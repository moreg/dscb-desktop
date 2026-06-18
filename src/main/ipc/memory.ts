import { ipcMain } from 'electron'
import { MemoryService } from '../data/memory-service'
import { MemoryEntityService } from '../data/memory-entity-service'
import type {
  CreateCharacterInput,
  UpdateCharacterInput,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

export function registerMemoryIpc(
  service: MemoryService,
  entityService: MemoryEntityService
): void {
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

  ipcMain.handle('memory:entity:list', (_e, projectId: string, type: MemoryEntityType) =>
    entityService.list(projectId, type)
  )
  ipcMain.handle(
    'memory:entity:create',
    (_e, projectId: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
      entityService.create(projectId, type, input)
  )
  ipcMain.handle(
    'memory:entity:update',
    (_e, projectId: string, type: MemoryEntityType, id: string, patch: UpdateMemoryEntityInput) =>
      entityService.update(projectId, type, id, patch)
  )
  ipcMain.handle(
    'memory:entity:delete',
    (_e, projectId: string, type: MemoryEntityType, id: string) =>
      entityService.delete(projectId, type, id)
  )
}
