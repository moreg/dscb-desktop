import { randomUUID } from 'crypto'
import { readJson, writeJsonAtomic } from './atomic'
import type { Library, ProjectMeta } from '../../shared/types'

const EMPTY: Library = { schemaVersion: 1, projects: [] }

export interface CreateProjectInput {
  name: string
  path: string
  genre?: string
}

export class LibraryRepository {
  constructor(private readonly libraryFile: string) {}

  async list(): Promise<ProjectMeta[]> {
    const lib = await readJson<Library>(this.libraryFile, EMPTY)
    return lib.projects
  }

  async create(input: CreateProjectInput): Promise<ProjectMeta> {
    const lib = await readJson<Library>(this.libraryFile, EMPTY)
    const now = new Date().toISOString()
    const project: ProjectMeta = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      genre: input.genre,
      createdAt: now,
      lastOpenedAt: now
    }
    const next: Library = { ...lib, projects: [...lib.projects, project] }
    await writeJsonAtomic(this.libraryFile, next)
    return project
  }
}
