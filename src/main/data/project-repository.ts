import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { ProjectData } from '../../shared/types'

export class ProjectRepository {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<ProjectData | null> {
    return readJson<ProjectData | null>(join(this.projectDir, 'project.json'), null)
  }

  async write(data: ProjectData): Promise<void> {
    await writeJsonAtomic(join(this.projectDir, 'project.json'), data)
  }
}
