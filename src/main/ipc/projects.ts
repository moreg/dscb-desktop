import { z } from 'zod'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema, projectNameSchema } from './validation'
import { ProjectService } from '../data/project-service'
import { ProjectFileWatcher } from '../data/project-file-watcher'
import { BrowserWindow, type WebContents } from 'electron'
import type { CreateProjectDataInput } from '../../shared/types'
import { withFileLock } from '../data/file-lock'

const bookNameItemSchema = z.string().min(1).max(120)
const benchmarkBooksSchema = z.array(bookNameItemSchema).max(20)

const createProjectSchema = z.object({
  name: projectNameSchema,
  genre: z.string().max(100).optional(),
  description: z.string().max(5000).optional(),
  targetChapters: z.number().int().min(1).max(100_000).optional(),
  chapterWordCount: z.number().int().min(100).max(100_000).optional(),
  customPath: z.string().max(1000).optional(),
  ideaDevelopment: z.string().max(200000).optional(),
  openingChapters: z.array(z.object({
    chapter: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    openingEvent: z.string().trim().min(1).max(10000),
    protagonistAction: z.string().trim().min(1).max(10000),
    conflict: z.string().trim().min(1).max(10000),
    payoff: z.string().trim().min(1).max(10000),
    endHook: z.string().trim().min(1).max(10000),
    summaryApplication: z.string().trim().min(1).max(10000)
  })).length(3).refine(items => new Set(items.map(item => item.chapter)).size === 3, '前三章方向必须分别包含第1、2、3章').optional()
})

const updateProjectInfoSchema = z.object({
  projectId: projectIdSchema,
  name: projectNameSchema.optional(),
  description: z.string().max(5000).optional()
}).refine(value => value.name !== undefined || value.description !== undefined, '请提供书名或简介')

const addTitleCandidateSchema = z.object({
  projectId: projectIdSchema,
  name: projectNameSchema,
  description: z.string().max(5000),
  seed: z.string().max(200).optional()
})

export function registerProjectsIpc(service: ProjectService): () => void {
  // A watcher belongs to one renderer window. A single global watcher would
  // cause window B to replace window A's subscription when two books are open.
  const watchers = new Map<number, ProjectFileWatcher>()
  const watchGenerations = new Map<number, number>()
  const watchRequests = new Map<number, { sender: WebContents; projectId: string }>()
  const pausedProjects = new Set<string>()
  let disposed = false

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
      watchRequests.delete(id)
    })
    return watcher
  }

  const refreshWatch = async (senderId: number): Promise<boolean> => {
    const request = watchRequests.get(senderId)
    if (!request || disposed || request.sender.isDestroyed()) return false
    if (pausedProjects.has(request.projectId)) return true
    const generation = watchGenerations.get(senderId)
    const dir = await service.resolveDir(request.projectId)
    if (disposed || watchRequests.get(senderId) !== request ||
      watchGenerations.get(senderId) !== generation || request.sender.isDestroyed()) return false
    if (!pausedProjects.has(request.projectId)) watcherFor(request.sender).watchProject(request.projectId, dir)
    return true
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
    async (_e, payload: { projectId: string; name?: string; description?: string }) => {
      const validated = validateInput(updateProjectInfoSchema, payload)
      const info = {
        ...(validated.name !== undefined ? { name: validated.name.trim() } : {}),
        ...(validated.description !== undefined ? { description: validated.description.trim() } : {})
      }
      return withFileLock(`project-info-watch:${validated.projectId}`, async () => {
        pausedProjects.add(validated.projectId)
        // Invalidate pending subscriptions too: an old resolveDir must not reopen the old path.
        for (const [senderId, request] of watchRequests) {
          if (request.projectId !== validated.projectId) continue
          watchGenerations.set(senderId, (watchGenerations.get(senderId) ?? 0) + 1)
        }
        for (const watcher of watchers.values()) {
          if (watcher.watchingProjectId() === validated.projectId) watcher.stopWatching()
        }
        try { return await service.updateProjectInfo(validated.projectId, info) }
        finally {
          pausedProjects.delete(validated.projectId)
          // A window may have switched books, stopped watching or closed during recovery.
          const restores = [...watchRequests].filter(([, request]) => request.projectId === validated.projectId)
            .map(([senderId]) => refreshWatch(senderId))
          const results = await Promise.allSettled(restores)
          if (results.some(result => result.status === 'rejected')) {
            console.warn('[projects:updateInfo] Some file subscriptions could not be restored.')
          }
        }
      })
    }
  )
  safeHandle(
    'projects:addTitleCandidate',
    async (_e, payload: { projectId: string; name: string; description: string; seed?: string }) => {
      const validated = validateInput(addTitleCandidateSchema, payload)
      return service.addTitleCandidate(validated.projectId, {
        name: validated.name.trim(),
        description: validated.description.trim(),
        seed: validated.seed?.trim() || undefined
      })
    }
  )
  safeHandle(
    'projects:removeTitleCandidate',
    async (_e, payload: { projectId: string; candidateId: string }) => {
      const validated = validateInput(
        z.object({ projectId: projectIdSchema, candidateId: z.string().min(1).max(100) }),
        payload
      )
      return service.removeTitleCandidate(validated.projectId, validated.candidateId)
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
    if (disposed || event.sender.isDestroyed()) return false
    const senderId = event.sender.id
    const generation = (watchGenerations.get(senderId) ?? 0) + 1
    watchGenerations.set(senderId, generation)
    watchRequests.set(senderId, { sender: event.sender, projectId: validated })
    // Release the previous book even if resolving the next path is slow.
    watcherFor(event.sender).stopWatching()
    return refreshWatch(senderId)
  })
  safeHandle('projects:stopWatch', (event) => {
    const senderId = event.sender.id
    watchGenerations.set(senderId, (watchGenerations.get(senderId) ?? 0) + 1)
    watchRequests.delete(senderId)
    watchers.get(senderId)?.stopWatching()
    return true
  })

  return () => {
    disposed = true
    for (const watcher of watchers.values()) watcher.dispose()
    watchers.clear()
    watchGenerations.clear()
    watchRequests.clear()
    pausedProjects.clear()
  }
}
