import { ipcMain } from 'electron'
import { MemoryService } from '../data/memory-service'
import { MemoryEntityService } from '../data/memory-entity-service'
import type {
  CreateCharacterInput,
  UpdateCharacterInput,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput,
  CreateForeshadowingInput,
  UpdateForeshadowingInput,
  CreateRelationshipInput,
  UpdateRelationshipInput
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

  ipcMain.handle('memory:foreshadowing:list', (_e, projectId: string) =>
    service.listForeshadowings(projectId)
  )
  ipcMain.handle(
    'memory:foreshadowing:create',
    (_e, projectId: string, input: CreateForeshadowingInput) =>
      service.createForeshadowing(projectId, input)
  )
  ipcMain.handle(
    'memory:foreshadowing:update',
    (_e, projectId: string, id: string, patch: UpdateForeshadowingInput) =>
      service.updateForeshadowing(projectId, id, patch)
  )
  ipcMain.handle('memory:foreshadowing:delete', (_e, projectId: string, id: string) =>
    service.deleteForeshadowing(projectId, id)
  )
  ipcMain.handle(
    'memory:foreshadowing:plant',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.plantForeshadowing(projectId, id, chapterNumber)
  )
  ipcMain.handle(
    'memory:foreshadowing:collect',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.collectForeshadowing(projectId, id, chapterNumber)
  )
  ipcMain.handle('memory:foreshadowing:markMissed', (_e, projectId: string, id: string) =>
    service.markForeshadowingMissed(projectId, id)
  )

  ipcMain.handle('memory:relationship:list', (_e, projectId: string) =>
    service.listRelationships(projectId)
  )
  ipcMain.handle(
    'memory:relationship:create',
    (_e, projectId: string, input: CreateRelationshipInput) =>
      service.createRelationship(projectId, input)
  )
  ipcMain.handle(
    'memory:relationship:update',
    (_e, projectId: string, id: string, patch: UpdateRelationshipInput) =>
      service.updateRelationship(projectId, id, patch)
  )
  ipcMain.handle('memory:relationship:delete', (_e, projectId: string, id: string) =>
    service.deleteRelationship(projectId, id)
  )
}
