import { safeHandle } from './safe-handle'
import { LibraryRepository, type CreateProjectInput } from '../data/library-repository'
import type { ProjectMeta } from '../../shared/types'

export function registerLibraryIpc(repo: LibraryRepository): void {
  safeHandle('library:list', async (): Promise<ProjectMeta[]> => repo.list())
  safeHandle(
    'library:create',
    async (_e, input: CreateProjectInput): Promise<ProjectMeta> => repo.create(input)
  )
}
