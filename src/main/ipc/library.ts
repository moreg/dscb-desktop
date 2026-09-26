import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema } from './validation'
import { ProjectService } from '../data/project-service'

const listProjectsQuerySchema = z.object({
  includeArchived: z.boolean().optional()
})

const setArchivedSchema = z.object({
  projectId: projectIdSchema,
  archived: z.boolean()
})

/**
 * library:list 现在走 ProjectService.listProjects()，过滤掉非 v3.2 项目。
 * 默认不返回已归档项目；includeArchived 为 true 时一并返回。
 * library:scan 扫描 projectsRoot 自动发现 v3.2 项目（已归档的不会被重新登记）。
 * library:setArchived 归档/移回书案，不删除项目文件。
 */
export function registerLibraryIpc(service: ProjectService): void {
  safeHandle('library:list', async (_e, payload?: unknown) => {
    const query = validateInput(listProjectsQuerySchema, payload ?? {})
    return service.listProjects(query)
  })
  safeHandle('library:scan', async () => service.scanProjects())
  safeHandle('library:setArchived', async (_e, payload: unknown) => {
    const validated = validateInput(setArchivedSchema, payload)
    return service.setArchived(validated.projectId, validated.archived)
  })
}
