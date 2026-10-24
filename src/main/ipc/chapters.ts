import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'
import { ChapterService } from '../data/chapter-service'
import { ChapterNameService } from '../data/chapter-name-service'
import { promises as fs } from 'fs'
import path from 'path'
import {
  draftPath,
  isDraftDifferent,
  type DraftMeta
} from '../data/draft'
import { summarizeProjectWords } from '../data/word-estimate'
import { RhythmHtmlRepo } from '../data/skill-format/rhythm-html-repo'
import type {
  CreateChapterInput,
  UpdateChapterMetaInput,
  CreateChapterVersionInput
} from '../../shared/types'
import { z } from 'zod'
import { ChapterVersionRepository } from '../data/chapter-version-repository'
import { ProseRepo } from '../data/skill-format/prose-repo'
import {
  validateInput,
  projectIdSchema,
  chapterNumberSchema,
  chapterContentSchema,
  versionNumberSchema,
  createChapterVersionInputSchema
} from './validation'

const NOT_IMPLEMENTED = '该操作需 Phase 3（编辑回写 .md）支持，当前为只读阶段。'

export function registerChaptersIpc(
  service: ProjectService,
  chapters: ChapterService,
  nameService?: ChapterNameService
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

  // P19-E：字数汇总（基于 rhythmData，纯计算不读正文大文件）
  safeHandle('chapters:wordSummary', async (_e, projectId: string) => {
    const validatedProjectId = validateInput(projectIdSchema, projectId)
    const dir = await service.resolveDir(validatedProjectId)
    const rhythmEntries = (await new RhythmHtmlRepo(dir).read()) ?? []
    return summarizeProjectWords(rhythmEntries, [])
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

  /**
   * AI 章名命名（ChapterEditor 正文区）：基于当前未保存草稿生成候选章名。
   * - 只生成候选，绝不直接写盘（候选需用户在前端确认后再走 chapters:updateMeta）。
   * - 失败时返回 ok=false + error 机器可读码（LLM_NOT_CONFIGURED / PARSE_FAILED 等）。
   */
  safeHandle(
    'chapters:suggestName',
    async (
      _e,
      payload: {
        projectId: string
        chapterNumber: number
        currentTitle: string
        draft: string
        genre?: string
      }
    ) => {
      if (!nameService) {
        return { ok: false, title: '', reason: '', error: 'SERVICE_UNAVAILABLE' }
      }
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          chapterNumber: chapterNumberSchema,
          currentTitle: z.string().max(200),
          draft: z.string().max(200_000),
          genre: z.string().max(50).optional()
        }),
        payload
      )
      return nameService.suggest({
        projectId: validated.projectId,
        chapterNumber: validated.chapterNumber,
        currentTitle: validated.currentTitle,
        draft: validated.draft,
        genre: validated.genre
      })
    }
  )

  // 章节版本：保留最新 5 个版本，倒序排序，支持正文恢复
  safeHandle('chapters:listVersions', async (_e, id: string, n: number) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    const dir = await service.resolveDir(projectId)
    const repo = new ChapterVersionRepository(dir)
    let versions = await repo.list(chapterNumber)
    // 若尚未创建过版本文件，但当前正文已有内容，自动初始化版本 1，确保用户随时可回滚
    if (versions.length === 0) {
      const current = await new ProseRepo(dir).read(chapterNumber)
      if (current.trim()) {
        await repo.create(chapterNumber, {
          source: 'manual',
          content: current,
          note: '初始正文'
        })
        versions = await repo.list(chapterNumber)
      }
    }
    return versions
  })

  safeHandle('chapters:getVersion', async (_e, id: string, n: number, vn: number) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    const versionNumber = validateInput(versionNumberSchema, vn)
    const dir = await service.resolveDir(projectId)
    return new ChapterVersionRepository(dir).get(chapterNumber, versionNumber)
  })

  safeHandle(
    'chapters:createVersion',
    async (_e, id: string, n: number, input: CreateChapterVersionInput) => {
      const projectId = validateInput(projectIdSchema, id)
      const chapterNumber = validateInput(chapterNumberSchema, n)
      const validatedInput = validateInput(createChapterVersionInputSchema, input)
      const dir = await service.resolveDir(projectId)
      return new ChapterVersionRepository(dir).create(chapterNumber, validatedInput)
    }
  )

  safeHandle('chapters:deleteVersion', async (_e, id: string, n: number, vn: number) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    const versionNumber = validateInput(versionNumberSchema, vn)
    const dir = await service.resolveDir(projectId)
    await new ChapterVersionRepository(dir).delete(chapterNumber, versionNumber)
  })

  safeHandle('chapters:rollback', async (_e, id: string, n: number, vn: number) => {
    const projectId = validateInput(projectIdSchema, id)
    const chapterNumber = validateInput(chapterNumberSchema, n)
    const versionNumber = validateInput(versionNumberSchema, vn)
    const dir = await service.resolveDir(projectId)
    const repo = new ChapterVersionRepository(dir)
    const targetVersion = await repo.get(chapterNumber, versionNumber)
    return chapters.updateContent(projectId, chapterNumber, targetVersion.content, undefined, {
      source: targetVersion.source,
      note: `恢复到版本 #${versionNumber}${targetVersion.note ? `（${targetVersion.note}）` : ''}`
    })
  })
}
