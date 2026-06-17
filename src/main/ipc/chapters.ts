import { ipcMain } from 'electron'
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
  ipcMain.handle('chapters:list', async (_e, id: string) => (await repoFor(id)).list())
  ipcMain.handle('chapters:get', async (_e, id: string, n: number) => (await repoFor(id)).get(n))
  ipcMain.handle('chapters:create', async (_e, id: string, input: CreateChapterInput) =>
    (await repoFor(id)).create(input)
  )
  ipcMain.handle('chapters:updateContent', async (_e, id: string, n: number, content: string) =>
    (await repoFor(id)).updateContent(n, content)
  )
  ipcMain.handle(
    'chapters:updateMeta',
    async (_e, id: string, n: number, patch: UpdateChapterMetaInput) =>
      (await repoFor(id)).updateMeta(n, patch)
  )
  ipcMain.handle('chapters:delete', async (_e, id: string, n: number) =>
    (await repoFor(id)).delete(n)
  )
  const versionRepoFor = async (id: string): Promise<ChapterVersionRepository> => {
    const dir = await service.resolveDir(id)
    return new ChapterVersionRepository(dir)
  }
  ipcMain.handle('chapters:listVersions', async (_e, id: string, n: number) =>
    (await versionRepoFor(id)).list(n)
  )
  ipcMain.handle('chapters:getVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).get(n, vn)
  )
  ipcMain.handle(
    'chapters:createVersion',
    async (_e, id: string, n: number, input: CreateChapterVersionInput) =>
      (await versionRepoFor(id)).create(n, input)
  )
  ipcMain.handle('chapters:deleteVersion', async (_e, id: string, n: number, vn: number) =>
    (await versionRepoFor(id)).delete(n, vn)
  )
  ipcMain.handle('chapters:rollback', async (_e, id: string, n: number, vn: number) => {
    const dir = await service.resolveDir(id)
    const version = await new ChapterVersionRepository(dir).get(n, vn)
    return new ChapterRepository(dir).updateContent(n, version.content)
  })
}
