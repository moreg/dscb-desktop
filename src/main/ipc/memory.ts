import { safeHandle } from './safe-handle'
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
  safeHandle('memory:character:list', (_e, projectId: string) =>
    service.listCharacters(projectId)
  )
  safeHandle('memory:character:get', (_e, projectId: string, id: string) =>
    service.getCharacter(projectId, id)
  )
  safeHandle(
    'memory:character:create',
    (_e, projectId: string, input: CreateCharacterInput) => service.createCharacter(projectId, input)
  )
  safeHandle(
    'memory:character:update',
    (_e, projectId: string, id: string, patch: UpdateCharacterInput) =>
      service.updateCharacter(projectId, id, patch)
  )
  safeHandle('memory:character:delete', (_e, projectId: string, id: string) =>
    service.deleteCharacter(projectId, id)
  )
  safeHandle('memory:history:list', (_e, projectId: string) => service.listHistory(projectId))

  safeHandle('memory:entity:list', (_e, projectId: string, type: MemoryEntityType) =>
    entityService.list(projectId, type)
  )
  safeHandle(
    'memory:entity:create',
    (_e, projectId: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
      entityService.create(projectId, type, input)
  )
  safeHandle(
    'memory:entity:update',
    (_e, projectId: string, type: MemoryEntityType, id: string, patch: UpdateMemoryEntityInput) =>
      entityService.update(projectId, type, id, patch)
  )
  safeHandle(
    'memory:entity:delete',
    (_e, projectId: string, type: MemoryEntityType, id: string) =>
      entityService.delete(projectId, type, id)
  )

  safeHandle('memory:foreshadowing:list', (_e, projectId: string) =>
    service.listForeshadowings(projectId)
  )
  safeHandle(
    'memory:foreshadowing:create',
    (_e, projectId: string, input: CreateForeshadowingInput) =>
      service.createForeshadowing(projectId, input)
  )
  safeHandle(
    'memory:foreshadowing:update',
    (_e, projectId: string, id: string, patch: UpdateForeshadowingInput) =>
      service.updateForeshadowing(projectId, id, patch)
  )
  safeHandle('memory:foreshadowing:delete', (_e, projectId: string, id: string) =>
    service.deleteForeshadowing(projectId, id)
  )
  safeHandle(
    'memory:foreshadowing:plant',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.plantForeshadowing(projectId, id, chapterNumber)
  )
  safeHandle(
    'memory:foreshadowing:collect',
    (_e, projectId: string, id: string, chapterNumber: number) =>
      service.collectForeshadowing(projectId, id, chapterNumber)
  )
  safeHandle('memory:foreshadowing:markMissed', (_e, projectId: string, id: string) =>
    service.markForeshadowingMissed(projectId, id)
  )

  safeHandle('memory:relationship:list', (_e, projectId: string) =>
    service.listRelationships(projectId)
  )
  safeHandle(
    'memory:relationship:create',
    (_e, projectId: string, input: CreateRelationshipInput) =>
      service.createRelationship(projectId, input)
  )
  safeHandle(
    'memory:relationship:update',
    (_e, projectId: string, id: string, patch: UpdateRelationshipInput) =>
      service.updateRelationship(projectId, id, patch)
  )
  safeHandle('memory:relationship:delete', (_e, projectId: string, id: string) =>
    service.deleteRelationship(projectId, id)
  )
}
