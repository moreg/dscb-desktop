import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema, projectNameSchema } from './validation'
import { ProjectService } from '../data/project-service'
import { ProjectFileWatcher } from '../data/project-file-watcher'
import type { CreateProjectDataInput } from '../../shared/types'

const bookNameItemSchema = z.string().min(1).max(120)
const benchmarkBooksSchema = z.array(bookNameItemSchema).max(20)

const createProjectSchema = z.object({
  name: projectNameSchema,
  genre: z.string().max(100).optional(),
  description: z.string().max(5000).optional(),
  targetChapters: z.number().int().min(1).max(100_000).optional(),
  chapterWordCount: z.number().int().min(100).max(100_000).optional(),
  customPath: z.string().max(1000).optional()
})

export function registerProjectsIpc(
  service: ProjectService,
  watcher: ProjectFileWatcher
): void {
  safeHandle('projects:create', (_e, input: CreateProjectDataInput) => {
    const validated = validateInput(createProjectSchema, input)
    return service.create(validated)
  })
  safeHandle('projects:get', (_e, id: string) => {
    const validated = validateInput(projectIdSchema, id)
    return service.getProjectData(validated)
  })
  safeHandle(
    'projects:setBenchmarkBooks',
    async (_e, payload: { projectId: string; books: string[] }) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, books: benchmarkBooksSchema }),
        payload
      )
      const updated = await service.updateProjectData(validated.projectId, {
        benchmarkBooks: validated.books
      })
      return updated.benchmarkBooks ?? []
    }
  )
  // 渲染进程进入项目视图时驱动文件监听
  safeHandle('projects:watch', async (_e, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    const dir = await service.resolveDir(validated)
    watcher.watchProject(validated, dir)
    return true
  })
  safeHandle('projects:stopWatch', () => {
    watcher.stopWatching()
    return true
  })
}
