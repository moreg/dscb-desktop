import { MemoryService } from '../data/memory-service'
import { MemoryEntityService } from '../data/memory-entity-service'
import { safeHandle } from './safe-handle'
import { registerCollectionIpc } from './register-collection'
import type {
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

export function registerMemoryIpc(
  service: MemoryService,
  entityService: MemoryEntityService
): void {
  registerCollectionIpc('memory:character', {
    list: (pid) => service.listCharacters(pid),
    get: (pid, id) => service.getCharacter(pid, id),
    create: (pid, input) => service.createCharacter(pid, input),
    update: (pid, id, patch) => service.updateCharacter(pid, id, patch),
    delete: (pid, id) => service.deleteCharacter(pid, id)
  })

  registerCollectionIpc('memory:relationship', {
    list: (pid) => service.listRelationships(pid),
    create: (pid, input) => service.createRelationship(pid, input),
    update: (pid, id, patch) => service.updateRelationship(pid, id, patch),
    delete: (pid, id) => service.deleteRelationship(pid, id)
  })

  registerCollectionIpc('memory:foreshadowing', {
    list: (pid) => service.listForeshadowings(pid),
    create: (pid, input) => service.createForeshadowing(pid, input),
    update: (pid, id, patch) => service.updateForeshadowing(pid, id, patch),
    delete: (pid, id) => service.deleteForeshadowing(pid, id)
  })
  safeHandle('memory:foreshadowing:plant', (_e, pid: string, id: string, n: number) =>
    service.plantForeshadowing(pid, id, n)
  )
  safeHandle('memory:foreshadowing:collect', (_e, pid: string, id: string, n: number) =>
    service.collectForeshadowing(pid, id, n)
  )
  safeHandle('memory:foreshadowing:markMissed', (_e, pid: string, id: string) =>
    service.markForeshadowingMissed(pid, id)
  )

  safeHandle('memory:entity:list', (_e, pid: string, type: MemoryEntityType) =>
    entityService.list(pid, type)
  )
  safeHandle(
    'memory:entity:create',
    (_e, pid: string, type: MemoryEntityType, input: CreateMemoryEntityInput) =>
      entityService.create(pid, type, input)
  )
  safeHandle(
    'memory:entity:update',
    (_e, pid: string, type: MemoryEntityType, id: string, patch: UpdateMemoryEntityInput) =>
      entityService.update(pid, type, id, patch)
  )
  safeHandle('memory:entity:delete', (_e, pid: string, type: MemoryEntityType, id: string) =>
    entityService.delete(pid, type, id)
  )

  safeHandle('memory:history:list', (_e, pid: string) => service.listHistory(pid))
}
