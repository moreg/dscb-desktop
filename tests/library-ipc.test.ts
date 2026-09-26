import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ProjectMeta } from '../src/shared/types'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  }
}))

const { LibraryRepository } = await import('../src/main/data/library-repository')
const { ProjectService } = await import('../src/main/data/project-service')
const { registerLibraryIpc } = await import('../src/main/ipc/library')

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

describe('library archive IPC', () => {
  let projectService: InstanceType<typeof ProjectService>
  let active: ProjectMeta
  let archived: ProjectMeta

  beforeEach(async () => {
    handlers.clear()
    const root = await mkdtemp(path.join(tmpdir(), 'aw-lib-ipc-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    active = await projectService.create({ name: '在写的书' })
    archived = await projectService.create({ name: '归档的书' })
    registerLibraryIpc(projectService)
  })

  it('lists only active projects by default, including when payload is omitted', async () => {
    await handlers.get('library:setArchived')!(null, { projectId: archived.id, archived: true })
    const listed = (await handlers.get('library:list')!(null)) as ProjectMeta[]
    expect(listed.map((p) => p.id)).toEqual([active.id])
  })

  it('returns archived projects when includeArchived is true', async () => {
    await handlers.get('library:setArchived')!(null, { projectId: archived.id, archived: true })
    const listed = (await handlers.get('library:list')!(null, { includeArchived: true })) as ProjectMeta[]
    expect(listed.map((p) => p.id).sort()).toEqual([active.id, archived.id].sort())
    expect(listed.find((p) => p.id === archived.id)?.archivedAt).toBeTruthy()
  })

  it('unarchives through IPC and shows the book on the default list', async () => {
    await handlers.get('library:setArchived')!(null, { projectId: archived.id, archived: true })
    await handlers.get('library:setArchived')!(null, { projectId: archived.id, archived: false })
    const listed = (await handlers.get('library:list')!(null, {})) as ProjectMeta[]
    expect(listed.map((p) => p.id).sort()).toEqual([active.id, archived.id].sort())
  })
})
