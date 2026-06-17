import { ipcMain } from 'electron'
import { ProjectService } from '../data/project-service'
import { ChapterRepository } from '../data/chapter-repository'
import type { CreateChapterInput, UpdateChapterMetaInput } from '../../shared/types'

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
}
