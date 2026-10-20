import { z } from 'zod'
import { dialog } from 'electron'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema } from './validation'
import { ProjectService } from '../data/project-service'
import { sanitizeTitle } from '../data/skill-format/prose-repo'

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

  safeHandle(
    'library:exportPackage',
    async (_e, payload: unknown): Promise<{ canceled: boolean; path?: string }> => {
      const { projectId } = validateInput(z.object({ projectId: projectIdSchema }), payload)
      const data = await service.getProjectData(projectId)
      const result = await dialog.showSaveDialog({
        title: '导出小说包',
        defaultPath: `${sanitizeTitle(data.name)}.dscb.zip`,
        filters: [{ name: '大神持笔小说包', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      const zipPath = result.filePath.toLowerCase().endsWith('.zip') ? result.filePath : `${result.filePath}.zip`
      await service.exportProjectPackage(projectId, zipPath)
      return { canceled: false, path: zipPath }
    }
  )

  safeHandle(
    'library:importPackage',
    async (): Promise<{ canceled: boolean; project?: Awaited<ReturnType<ProjectService['importProjectPackage']>> }> => {
      const result = await dialog.showOpenDialog({
        title: '导入小说包',
        filters: [{ name: '大神持笔小说包', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      const project = await service.importProjectPackage(result.filePaths[0])
      return { canceled: false, project }
    }
  )
}
