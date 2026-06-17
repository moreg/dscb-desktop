import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { LibraryRepository } from './library-repository'
import { ProjectRepository } from './project-repository'
import { writeJsonAtomic } from './atomic'
import type { ProjectData, ProjectMeta, CreateProjectDataInput } from '../../shared/types'

export class ProjectService {
  constructor(
    private readonly projectsRoot: string,
    private readonly library: LibraryRepository
  ) {}

  async create(input: CreateProjectDataInput): Promise<ProjectMeta> {
    const id = randomUUID()
    const dir = join(this.projectsRoot, id)
    const now = new Date().toISOString()
    await fs.mkdir(join(dir, 'chapters'), { recursive: true })
    const data: ProjectData = {
      schemaVersion: 1,
      updatedAt: now,
      id,
      name: input.name,
      genre: input.genre,
      description: input.description,
      targetChapters: input.targetChapters,
      chapterWordCount: input.chapterWordCount,
      status: 'outline',
      createdAt: now
    }
    await writeJsonAtomic(join(dir, 'project.json'), data)
    return this.library.create({ name: input.name, path: dir, genre: input.genre })
  }

  async resolveDir(projectId: string): Promise<string> {
    const projects = await this.library.list()
    const p = projects.find((x) => x.id === projectId)
    if (!p) throw new Error(`project not found: ${projectId}`)
    return p.path
  }

  async getProjectData(projectId: string): Promise<ProjectData> {
    const dir = await this.resolveDir(projectId)
    const repo = new ProjectRepository(dir)
    const data = await repo.read()
    if (!data) throw new Error(`project.json missing in ${dir}`)
    return data
  }
}
