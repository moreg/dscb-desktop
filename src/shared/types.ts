export interface ProjectMeta {
  id: string
  name: string
  path: string
  genre?: string
  createdAt: string
  lastOpenedAt: string
}

export interface Library {
  schemaVersion: number
  projects: ProjectMeta[]
}

export interface CreateProjectInput {
  name: string
  path: string
  genre?: string
}

export interface RendererApi {
  listProjects: () => Promise<ProjectMeta[]>
  createProject: (input: CreateProjectInput) => Promise<ProjectMeta>
}
