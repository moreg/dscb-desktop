import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'
import type { CreateProjectDataInput } from '../../shared/types'

export function registerProjectsIpc(service: ProjectService): void {
  safeHandle('projects:create', (_e, input: CreateProjectDataInput) => service.create(input))
  safeHandle('projects:get', (_e, id: string) => service.getProjectData(id))
}
