import { join } from 'path'
import { JsonCollectionRepository } from './json-collection-repository'
import type { ProjectService } from './project-service'
import type {
  MemoryEntity,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

const FILE_NAMES: Record<MemoryEntityType, string> = {
  location: 'locations.json',
  worldview: 'worldview.json',
  timeline: 'timeline.json',
  plot_point: 'plot_points.json'
}

export class MemoryEntityService {
  constructor(private readonly projectService: ProjectService) {}

  private async repo(
    projectId: string,
    type: MemoryEntityType
  ): Promise<JsonCollectionRepository<MemoryEntity>> {
    const dir = await this.projectService.resolveDir(projectId)
    return new JsonCollectionRepository<MemoryEntity>(join(dir, 'memory', FILE_NAMES[type]))
  }

  async list(projectId: string, type: MemoryEntityType): Promise<MemoryEntity[]> {
    return (await this.repo(projectId, type)).list()
  }

  async create(
    projectId: string,
    type: MemoryEntityType,
    input: CreateMemoryEntityInput
  ): Promise<MemoryEntity> {
    const now = new Date().toISOString()
    return (await this.repo(projectId, type)).create({ ...input, createdAt: now, updatedAt: now })
  }

  async update(
    projectId: string,
    type: MemoryEntityType,
    id: string,
    patch: UpdateMemoryEntityInput
  ): Promise<MemoryEntity> {
    return (await this.repo(projectId, type)).update(id, {
      ...patch,
      updatedAt: new Date().toISOString()
    })
  }

  async delete(projectId: string, type: MemoryEntityType, id: string): Promise<void> {
    return (await this.repo(projectId, type)).delete(id)
  }
}
