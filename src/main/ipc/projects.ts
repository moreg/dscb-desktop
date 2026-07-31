import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema, projectNameSchema } from './validation'
import { ProjectService } from '../data/project-service'
import { ProjectFileWatcher } from '../data/project-file-watcher'
import { BrowserWindow, type WebContents } from 'electron'
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

const updateProjectInfoSchema = z.object({
  projectId: projectIdSchema,
  name: projectNameSchema,
  description: z.string().max(5000).optional()
})

export function registerProjectsIpc(service: ProjectService): () => void {
  // A watcher belongs to one renderer window. A single global watcher would
  // cause window B to replace window A's subscription when two books are open.
  const watchers = new Map<number, ProjectFileWatcher>()
  const watchGenerations = new Map<number, number>()

  const watcherFor = (sender: WebContents): ProjectFileWatcher => {
    const id = sender.id
    const existing = watchers.get(id)
    if (existing) return existing

    const watcher = new ProjectFileWatcher(() => BrowserWindow.fromWebContents(sender))
    watchers.set(id, watcher)
    sender.once('destroyed', () => {
      watcher.dispose()
      watchers.delete(id)
      watchGenerations.delete(id)
    })
    return watcher
  }

  safeHandle('projects:create', (_e, input: CreateProjectDataInput) => {
    const validated = validateInput(createProjectSchema, input)
    return service.create(validated)
  })
  safeHandle('projects:get', (_e, id: string) => {
    const validated = validateInput(projectIdSchema, id)
    return service.getProjectData(validated)
  })
  safeHandle(
    'projects:updateInfo',
    async (_e, payload: { projectId: string; name: string; description?: string }) => {
      const validated = validateInput(updateProjectInfoSchema, payload)
      return service.updateProjectInfo(validated.projectId, {
        name: validated.name.trim(),
        description: validated.description?.trim() || undefined
      })
    }
  )
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
  safeHandle('projects:watch', async (event, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    const senderId = event.sender.id
    const generation = (watchGenerations.get(senderId) ?? 0) + 1
    watchGenerations.set(senderId, generation)
    const dir = await service.resolveDir(validated)
    // resolveDir may finish out of order during rapid project switches.
    if (watchGenerations.get(senderId) !== generation || event.sender.isDestroyed()) return false
    watcherFor(event.sender).watchProject(validated, dir)
    return true
  })
  safeHandle('projects:stopWatch', (event) => {
    const senderId = event.sender.id
    watchGenerations.set(senderId, (watchGenerations.get(senderId) ?? 0) + 1)
    watchers.get(senderId)?.stopWatching()
    return true
  })

  return () => {
    for (const watcher of watchers.values()) watcher.dispose()
    watchers.clear()
    watchGenerations.clear()
  }
}
