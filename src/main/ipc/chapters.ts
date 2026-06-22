import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'
import { ChapterService } from '../data/chapter-service'
import { promises as fs } from 'fs'
import path from 'path'
import {
  draftPath,
  isDraftDifferent,
  type DraftMeta
} from '../data/draft'
import { summarizeProjectWords } from '../data/word-estimate'
import { RhythmHtmlRepo } from '../data/skill-format/rhythm-html-repo'
import { ChapterProgressMdRepo } from '../data/skill-format/chapter-progress-md-repo'
import type {
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateChapterVersionInput
} from '../../shared/types'
import {
  validateInput,
  projectIdSchema,
  chapterNumberSchema,
  chapterContentSchema
} from './validation'

const NOT_IMPLEMENTED = '该操作需 Phase 3（编辑回写 .md）支持，当前为只读阶段。'

export function registerChaptersIpc(
  service: ProjectService,
  chapters: ChapterService
): void {
  safeHandle('chapters:list', async (_e, id: string) => {
    const projectId = validateInput(projectIdSchema, id)
    return chapters.listChapters(projectId)
  })

  safeHandle('chapters:get', async (_e, id: string, n: number) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    return chapters.getChapter(projectId, chapterNumber)
  })

  // 正文写入：app 独占，Phase 1 即可用
  safeHandle('chapters:updateContent', async (_e, id: string, n: number, content: string) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    const validatedContent = validateInput(chapterContentSchema, content)
    return chapters.updateContent(projectId, chapterNumber, validatedContent)
  })

  // P19-A：自动保存草稿（写 / 读 / 清空）
  safeHandle(
    'chapters:saveDraft',
    async (
      _e,
      projectId: string,
      chapterNumber: number,
      content: string
    ): Promise<{ at: number }> => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          content: chapterContentSchema
        }),
        { projectId, chapterNumber, content }
      )
      const dir = await service.resolveDir(validated.projectId)
      const file = draftPath(dir, validated.chapterNumber)

      // 路径遍历防护：确保文件路径在项目目录内
      const normalizedPath = path.normalize(file)
      const normalizedDir = path.normalize(dir)
      if (!normalizedPath.startsWith(normalizedDir + path.sep)) {
        throw new Error('PATH_TRAVERSAL_DETECTED')
      }

      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, validated.content, 'utf-8')
      return { at: Date.now() }
    }
  )

  safeHandle(
    'chapters:readDraft',
    async (_e, projectId: string, chapterNumber: number): Promise<DraftMeta | null> => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema
        }),
        { projectId, chapterNumber }
      )
      const dir = await service.resolveDir(validated.projectId)
      const file = draftPath(dir, validated.chapterNumber)

      // 路径遍历防护
      const normalizedPath = path.normalize(file)
      const normalizedDir = path.normalize(dir)
      if (!normalizedPath.startsWith(normalizedDir + path.sep)) {
        throw new Error('PATH_TRAVERSAL_DETECTED')
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>
      let content: string
      try {
        stat = await fs.stat(file)
        content = await fs.readFile(file, 'utf-8')
      } catch {
        return null // 无 draft 文件
      }
      // 比对正文（避免"draft 与正文相同"的伪恢复）
      const saved = await chapters
        .getChapter(validated.projectId, validated.chapterNumber)
        .then((c) => c.content)
        .catch(() => '')
      return {
        content,
        at: stat.mtimeMs,
        different: isDraftDifferent(content, saved)
      }
    }
  )

  safeHandle(
    'chapters:discardDraft',
    async (_e, projectId: string, chapterNumber: number): Promise<boolean> => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema
        }),
        { projectId, chapterNumber }
      )
      const dir = await service.resolveDir(validated.projectId)
      const file = draftPath(dir, validated.chapterNumber)

      // 路径遍历防护
      const normalizedPath = path.normalize(file)
      const normalizedDir = path.normalize(dir)
      if (!normalizedPath.startsWith(normalizedDir + path.sep)) {
        throw new Error('PATH_TRAVERSAL_DETECTED')
      }

      try {
        await fs.unlink(file)
        return true
      } catch {
        return false
      }
    }
  )

  // P19-E：字数汇总（基于 rhythmData + 章节进度笔记，纯计算不读正文大文件）
  safeHandle('chapters:wordSummary', async (_e, projectId: string) => {
    const validatedProjectId = validateInput(projectIdSchema, projectId)
    const dir = await service.resolveDir(validatedProjectId)
    const rhythmEntries = (await new RhythmHtmlRepo(dir).read()) ?? []
    const progressMap = await new ChapterProgressMdRepo(dir).read()
    const progressNotes = [...progressMap.values()]
      .filter((p) => typeof p.wordCount === 'number')
      .map((p) => ({
        chapterNumber: p.chapter,
        wordCount: p.wordCount as number
      }))
    return summarizeProjectWords(rhythmEntries, progressNotes)
  })

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
