import type { ProjectService } from './project-service'
import { LocationMdRepo } from './skill-format/location-md-repo'
import { WorldviewMdRepo } from './skill-format/worldview-md-repo'
import { CorePlotMdRepo } from './skill-format/core-plot-md-repo'
import type {
  MemoryEntity,
  MemoryEntityType,
  CreateMemoryEntityInput,
  UpdateMemoryEntityInput
} from '../../shared/types'

const NOT_IMPLEMENTED = '该操作需 Phase 3（回写 记忆系统/*.md）支持，当前为只读阶段。'

/**
 * 记忆实体服务。Phase 2 读取就绪：
 * - location → 记忆系统/地点档案.md
 * - worldview → 记忆系统/世界观设定.md
 * - plot_point → 记忆系统/核心情节.md（每章映射为一个剧情点实体）
 * - timeline → 无 v3.2 源，返回空（技能不产出该文件）
 * mutation 留 Phase 3。
 */
export class MemoryEntityService {
  constructor(private readonly projectService: ProjectService) {}

  async list(projectId: string, type: MemoryEntityType): Promise<MemoryEntity[]> {
    const dir = await this.projectService.resolveDir(projectId)
    switch (type) {
      case 'location':
        return new LocationMdRepo(dir).list()
      case 'worldview':
        return new WorldviewMdRepo(dir).list()
      case 'plot_point':
        return new CorePlotMdRepo(dir).list()
      case 'timeline':
        return []
      default:
        return []
    }
  }

  async create(projectId: string, type: MemoryEntityType, input: CreateMemoryEntityInput): Promise<MemoryEntity> {
    const dir = await this.projectService.resolveDir(projectId)
    switch (type) {
      case 'location':
        return new LocationMdRepo(dir).create(input)
      case 'worldview':
        return new WorldviewMdRepo(dir).create(input)
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
      const repo = new LocationMdRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (!existing) throw new Error(`地点不存在：${id}`)
      return (await repo.update(existing.name, patch)) ?? existing
    }
    if (type === 'worldview') {
      const repo = new WorldviewMdRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (!existing) throw new Error(`世界观条目不存在：${id}`)
      return (await repo.update(existing.name, patch)) ?? existing
    }
    throw new Error(NOT_IMPLEMENTED)
  }

  async delete(projectId: string, type: MemoryEntityType, id: string): Promise<void> {
    const dir = await this.projectService.resolveDir(projectId)
    if (type === 'location') {
      const repo = new LocationMdRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (existing) await repo.delete(existing.name)
      return
    }
    if (type === 'worldview') {
      const repo = new WorldviewMdRepo(dir)
      const existing = (await repo.list()).find((e) => e.id === id)
      if (existing) await repo.delete(existing.name)
      return
    }
    throw new Error(NOT_IMPLEMENTED)
  }
}
