import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'
import { ChapterRepository } from '../data/chapter-repository'
import { ChapterVersionRepository } from '../data/chapter-version-repository'
import type {
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateChapterVersionInput
} from '../../shared/types'

export function registerChaptersIpc(service: ProjectService): void {
  const repoFor = async (id: string): Promise<ChapterRepository> => {
    const dir = await service.resolveDir(id)
    return new ChapterRepository(dir)
  }
  safeHandle('chapters:list', async (_e, id: string) => (await repoFor(id)).list())
  safeHandle('chapters:get', async (_e, id: string, n: number) => (await repoFor(id)).get(n))
  safeHandle('chapters:create', async (_e, id: string, input: CreateChapterInput) =>
    (await repoFor(id)).create(input)
  )
  safeHandle('chapters:updateContent', async (_e, id: string, n: number, content: string) =>
    (await repoFor(id)).updateContent(n, content)
  )
  safeHandle(
    'chapters:updateMeta',
    async (_e, id: string, n: number, patch: UpdateChapterMetaInput) =>
      (await repoFor(id)).updateMeta(n, patch)
  )
  safeHandle('chapters:delete', async (_e, id: string, n: number) =>
    (await repoFor(id)).delete(n)
  )
  const versionRepoFor = async (id: string): Promise<ChapterVersionRepository> => {
    const dir = await service.resolveDir(id)
    return new ChapterVersionRepository(dir)
  }
  safeHandle('chapters:listVersions', async (_e, id: string, n: number) =>
    (await versionRepoFor(id)).list(n)
  )
  safeHandle('chapters:getVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).get(n, vn)
  )
  safeHandle(
    'chapters:createVersion',
    async (_e, id: string, n: number, input: CreateChapterVersionInput) =>
      (await versionRepoFor(id)).create(n, input)
  )
  safeHandle('chapters:deleteVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).delete(n, vn)
  )
  safeHandle('chapters:rollback', async (_e, id: string, n: number, vn: number) => {
    const dir = await service.resolveDir(id)
    const version = await new ChapterVersionRepository(dir).get(n, vn)
    return new ChapterRepository(dir).updateContent(n, version.content)
  })
}
