import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import type { Library, ProjectMeta, CreateProjectInput } from '../../shared/types'

export type { CreateProjectInput }

const EMPTY: Library = { schemaVersion: 1, projects: [] }

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
}
