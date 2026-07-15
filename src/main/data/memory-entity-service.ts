import type { ProjectService } from './project-service'
import { LocationRepo } from './memory/location-repo'
import { WorldviewRepo } from './memory/worldview-repo'
import { TimelineRepo } from './memory/timeline-repo'
import { PlotPointRepo } from './memory/plot-point-repo'
import { ItemRepo } from './memory/item-repo'
import type {
  MemoryEntity,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

const NOT_IMPLEMENTED = '该操作需 Phase 3 支持，当前为只读阶段。'

/**
 * 记忆实体服务（v4）。所有 5 个类型都从 记忆/<type>/*.md 读，fallback 到 v3 源。
 * - location -> 记忆/地点/*.md（fallback 设定/世界观/地理.md）
 * - worldview -> 记忆/世界观/*.md（fallback 设定/世界观/*.md）
 * - timeline -> 追踪/时间线.md 对照表
 * - plot_point -> 记忆/剧情点/*.md（fallback 细纲/细纲_第NNN章_*.md）
 * - item -> 记忆/道具/*.md
 */
export class MemoryEntityService {
  constructor(private readonly projectService: ProjectService) {}

  async list(projectId: string, type: MemoryEntityType): Promise<MemoryEntity[]> {
    const dir = await this.projectService.resolveDir(projectId)
    switch (type) {
      case 'location':
        return new LocationRepo(dir).list()
      case 'worldview':
        return new WorldviewRepo(dir).list()
      case 'timeline':
        return new TimelineRepo(dir).list()
      case 'plot_point':
        return new PlotPointRepo(dir).list()
      case 'item':
        return new ItemRepo(dir).list()
      default:
        return []
    }
  }

  async create(projectId: string, type: MemoryEntityType, input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const dir = await this.projectService.resolveDir(projectId)
    switch (type) {
      case 'location':
        return new LocationRepo(dir).create(input)
      case 'worldview':
        return new WorldviewRepo(dir).create(input)
      case 'item':
        return new ItemRepo(dir).create(input)
      default:
        throw new Error(NOT_IMPLEMENTED)
    }
  }

  async update(
    projectId: string,
    type: MemoryEntityType,
    id: string,
    patch: UpdateMemoryEntityInput
  ): Promise<MemoryEntity> {
    const dir = await this.projectService.resolveDir(projectId)
    if (type === 'location') {
      const repo = new LocationRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (!existing) throw new Error(`地点不存在：${id}`)
      return (await repo.update(id, patch)) ?? existing
    }
    if (type === 'worldview') {
      const repo = new WorldviewRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (!existing) throw new Error(`世界观条目不存在：${id}`)
      return (await repo.update(id, patch)) ?? existing
    }
    if (type === 'item') {
      const repo = new ItemRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (!existing) throw new Error(`道具不存在：${id}`)
      return (await repo.update(id, patch)) ?? existing
    }
    throw new Error(NOT_IMPLEMENTED)
  }

  async delete(projectId: string, type: MemoryEntityType, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    if (type === 'location') {
      const repo = new LocationRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (existing) await repo.delete(id)
      return
    }
    if (type === 'worldview') {
      const repo = new WorldviewRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (existing) await repo.delete(id)
      return
    }
    if (type === 'item') {
      const repo = new ItemRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (existing) await repo.delete(id)
      return
    }
    throw new Error(NOT_IMPLEMENTED)
  }
}
