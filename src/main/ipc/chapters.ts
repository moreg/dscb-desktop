import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'
import { ChapterService } from '../data/chapter-service'
import type {
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateChapterVersionInput
} from '../../shared/types'

const NOT_IMPLEMENTED = '该操作需 Phase 3（编辑回写 .md）支持，当前为只读阶段。'

export function registerChaptersIpc(service: ProjectService): void {
  const chapters = new ChapterService(service)

  safeHandle('chapters:list', async (_e, id: string) => chapters.listChapters(id))
  safeHandle('chapters:get', async (_e, id: string, n: number) => chapters.getChapter(id, n))

  // 正文写入：app 独占，Phase 1 即可用
  safeHandle('chapters:updateContent', async (_e, id: string, n: number, content: string) =>
    chapters.updateContent(id, n, content)
  )

  // 结构 mutation 涉及 rhythmData + 大纲表 + 细纲 + 章节进度 + 核心情节多处增删，
  // 留 Phase 3b；meta 编辑（标题）现已通过 ChapterRhythmWriter 三处同步。
  safeHandle('chapters:create', async (_e, _id: string, _input: CreateChapterInput) => {
    throw new Error(NOT_IMPLEMENTED)
  })
  safeHandle(
    'chapters:updateMeta',
    async (_e, id: string, n: number, patch: UpdateChapterMetaInput) =>
      chapters.updateMeta(id, n, patch)
  )
  safeHandle('chapters:delete', async () => {
    throw new Error(NOT_IMPLEMENTED)
  })

  // 章节版本：v3.2 无此概念，Phase 4+ 作为 app 独占扩展重做
  safeHandle('chapters:listVersions', async () => [])
  safeHandle('chapters:getVersion', async () => {
    throw new Error(NOT_IMPLEMENTED)
  })
  safeHandle('chapters:createVersion', async (_e, _id, _n, _input: CreateChapterVersionInput) => {
    throw new Error(NOT_IMPLEMENTED)
  })
  safeHandle('chapters:deleteVersion', async () => {
    throw new Error(NOT_IMPLEMENTED)
  })
  safeHandle('chapters:rollback', async () => {
    throw new Error(NOT_IMPLEMENTED)
  })
}
