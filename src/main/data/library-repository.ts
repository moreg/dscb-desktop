import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import type { Library, ProjectMeta, CreateProjectInput } from '../../shared/types'
import { isProjectArchived } from '../../shared/types'

export type { CreateProjectInput }

const EMPTY: Library = { schemaVersion: 1, projects: [] }

function withoutArchivedAt(project: ProjectMeta): ProjectMeta {
  const { archivedAt: _archivedAt, ...rest } = project
  return rest
}

export class LibraryRepository {
  constructor(private readonly libraryFile: string) {}

  async list(): Promise<ProjectMeta[]> {
    const lib = await readJson<Library>(this.libraryFile, EMPTY)
    return lib.projects
  }

  async create(input: CreateProjectInput): Promise<ProjectMeta> {
    return withFileLock(this.libraryFile, async () => {
      const lib = await readJson<Library>(this.libraryFile, EMPTY)
      const now = new Date().toISOString()
      const project: ProjectMeta = {
        id: input.id ?? randomUUID(),
        name: input.name,
        description: input.description,
        path: input.path,
        genre: input.genre,
        createdAt: now,
        lastOpenedAt: now
      }
      const next: Library = { ...lib, projects: [...lib.projects, project] }
      await writeJsonAtomic(this.libraryFile, next)
      return project
    })
  }

  async update(
    projectId: string,
    patch: Partial<Pick<ProjectMeta, 'name' | 'description' | 'genre' | 'path'>>
  ): Promise<ProjectMeta> {
    return withFileLock(this.libraryFile, async () => {
      const lib = await readJson<Library>(this.libraryFile, EMPTY)
      const index = lib.projects.findIndex((project) => project.id === projectId)
      if (index < 0) throw new Error(`project not found: ${projectId}`)
      const updated = { ...lib.projects[index], ...patch }
      const projects = [...lib.projects]
      projects[index] = updated
      await writeJsonAtomic(this.libraryFile, { ...lib, projects })
      return updated
    })
  }

  async setArchived(projectId: string, archived: boolean): Promise<ProjectMeta> {
    return withFileLock(this.libraryFile, async () => {
      const lib = await readJson<Library>(this.libraryFile, EMPTY)
      const index = lib.projects.findIndex((project) => project.id === projectId)
      if (index < 0) throw new Error(`project not found: ${projectId}`)
      const current = lib.projects[index]
      const updated: ProjectMeta = archived
        ? {
            ...current,
            archivedAt: isProjectArchived(current) ? current.archivedAt : new Date().toISOString()
          }
        : withoutArchivedAt(current)
      const projects = [...lib.projects]
      projects[index] = updated
      await writeJsonAtomic(this.libraryFile, { ...lib, projects })
      return updated
    })
  }
}
