import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import {
  shortStoryConfigError,
  shortStoryFullText,
  shortStorySummary,
  type ShortStoryCreateInput,
  type ShortStoryDocument,
  type ShortStorySummary
} from '../../shared/short-story'
import { writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import { shortStoryCreateSchema, shortStoryDocumentSchema } from './short-story-validation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONFIG_FIELDS = ['title', 'kind', 'genre', 'brief', 'requirements', 'targetWords', 'sectionCount'] as const

interface StoryMetadata extends ShortStoryCreateInput {
  schemaVersion: 1
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  reviewBasis: string
  sections: { number: number; title: string }[]
}

interface CommitPointer {
  schemaVersion: 1
  snapshotId: string
  revision: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new Error('SHORT_STORY_INVALID_ID: 中短篇作品编号无效')
  }
}

function assertConfig(value: unknown): asserts value is ShortStoryCreateInput {
  if (!isRecord(value) || !['short', 'medium'].includes(String(value.kind)) ||
    ['title', 'genre', 'brief', 'requirements'].some(key => typeof value[key] !== 'string')) {
    throw new Error('SHORT_STORY_INVALID: 中短篇作品配置无效')
  }
  const error = shortStoryConfigError(value as unknown as ShortStoryCreateInput)
  if (error) throw new Error(`SHORT_STORY_INVALID: ${error}`)
  const checked = shortStoryCreateSchema.safeParse(value)
  if (!checked.success) throw new Error(`SHORT_STORY_INVALID: ${checked.error.issues[0].message}`)
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function assertDocument(value: unknown): asserts value is ShortStoryDocument {
  assertConfig(value)
  const document = value as unknown as Record<string, unknown>
  assertId(document.id)
  if (!Number.isSafeInteger(document.revision) || Number(document.revision) < 1 ||
    !validDate(document.createdAt) || !validDate(document.updatedAt) ||
    typeof document.outline !== 'string' || typeof document.review !== 'string') {
    throw new Error('SHORT_STORY_INVALID: 中短篇作品数据无效')
  }
  if (!Array.isArray(document.sections) || document.sections.length !== document.sectionCount ||
    document.sections.some((section, index) => !isRecord(section) || section.number !== index + 1 ||
      typeof section.title !== 'string' || typeof section.content !== 'string')) {
    throw new Error('SHORT_STORY_INVALID: 分节数与正文节数必须一致，节序号必须连续')
  }
  const checked = shortStoryDocumentSchema.safeParse(value)
  if (!checked.success) throw new Error(`SHORT_STORY_INVALID: ${checked.error.issues[0].message}`)
}

function manuscriptFingerprint(story: ShortStoryDocument): string {
  return createHash('sha256').update(JSON.stringify([
    CONFIG_FIELDS.map(field => story[field]), story.outline,
    story.sections.map(section => [section.number, section.title, section.content])
  ])).digest('hex')
}

function sourceFingerprint(story: ShortStoryDocument): string {
  return createHash('sha256').update(JSON.stringify([
    CONFIG_FIELDS.map(field => story[field]), story.outline,
    story.sections.map(section => [section.number, section.title, section.content]), story.review
  ])).digest('hex')
}

function manuscriptChanged(current: ShortStoryDocument, next: ShortStoryDocument): boolean {
  return CONFIG_FIELDS.some(field => current[field] !== next[field]) || current.outline !== next.outline ||
    current.sections.length !== next.sections.length || current.sections.some((section, index) => {
      const incoming = next.sections[index]
      return section.title !== incoming.title || section.content !== incoming.content
    })
}

/**
 * 正文、大纲与审核以 Markdown 为真源。每次保存写入不可变快照，再原子切换提交指针；
 * 读取中的旧版本和历史稿件始终完整，不会出现半次保存的混合内容。
 */
export class ShortStoryService {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private directory(id: string): string {
    assertId(id)
    return join(this.root, id)
  }

  private async assertDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('作品目录无效，不能使用链接目录')
    }
  }

  private async readFile(file: string): Promise<string> {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('作品文件无效，不能使用链接文件')
    return fs.readFile(file, 'utf-8')
  }

  async list(): Promise<ShortStorySummary[]> {
    try {
      await this.assertDirectory(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const summaries = await Promise.all(entries.filter(entry => UUID.test(entry.name)).map(async entry => {
      try {
        return shortStorySummary(await this.get(entry.name))
      } catch (error) {
        let updatedAt = new Date(0).toISOString()
        try {
          updatedAt = (await fs.lstat(join(this.root, entry.name))).mtime.toISOString()
        } catch {
          // 列出后目录可能被外部移动，仍保留可见条目和原始读取错误。
        }
        const summary: ShortStorySummary = {
          id: entry.name, title: '作品文件待检查', kind: 'short', genre: '',
          targetWords: 0, sectionCount: 0, writtenWords: 0, completedSections: 0, updatedAt,
          loadError: error instanceof Error ? error.message : '中短篇作品不可读取，请检查作品文件夹'
        }
        return summary
      }
    }))
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async create(input: ShortStoryCreateInput): Promise<ShortStoryDocument> {
    assertConfig(input)
    const now = new Date().toISOString()
    const story: ShortStoryDocument = {
      title: input.title.trim(), kind: input.kind, genre: input.genre, brief: input.brief,
      requirements: input.requirements, targetWords: input.targetWords, sectionCount: input.sectionCount,
      id: randomUUID(), revision: 1, sourceFingerprint: '', createdAt: now, updatedAt: now, outline: '', review: '',
      sections: Array.from({ length: input.sectionCount }, (_, index) => ({ number: index + 1, title: '', content: '' }))
    }
    story.sourceFingerprint = sourceFingerprint(story)
    await fs.mkdir(this.root, { recursive: true })
    await this.assertDirectory(this.root)
    // 未提交的新作品不占用正式 UUID 目录，创建失败或进程中断也不会污染作品列表。
    const staging = join(this.root, `.creating-${story.id}`)
    await fs.mkdir(staging)
    await this.commit(story, staging)
    await fs.rename(staging, this.directory(story.id))
    return story
  }

  async get(id: string): Promise<ShortStoryDocument> {
    const directory = await this.getDirectory(id)
    try {
      const pointer: unknown = JSON.parse(await this.readFile(join(directory, 'current.json')))
      if (!isRecord(pointer) || pointer.schemaVersion !== 1 || typeof pointer.snapshotId !== 'string' ||
        !UUID.test(pointer.snapshotId) || !Number.isSafeInteger(pointer.revision) || Number(pointer.revision) < 1) {
        throw new Error('提交指针无效')
      }
      const revisions = join(directory, 'revisions')
      const snapshot = join(revisions, pointer.snapshotId)
      await this.assertDirectory(revisions)
      await this.assertDirectory(snapshot)
      const metadata: unknown = JSON.parse(await this.readFile(join(snapshot, 'metadata.json')))
      assertConfig(metadata)
      const record = metadata as unknown as Record<string, unknown>
      if (record.schemaVersion !== 1 || record.id !== id || record.revision !== pointer.revision ||
        typeof record.reviewBasis !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(record.reviewBasis) ||
        !Array.isArray(record.sections) || record.sections.length !== record.sectionCount ||
        record.sections.some((section, index) => !isRecord(section) || section.number !== index + 1 ||
          typeof section.title !== 'string')) {
        throw new Error('快照元数据无效')
      }
      await this.assertDirectory(join(snapshot, '正文'))
      const stored = metadata as unknown as StoryMetadata
      const [outline, review, sections] = await Promise.all([
        this.readFile(join(snapshot, '大纲.md')),
        this.readFile(join(snapshot, '审核.md')),
        Promise.all(stored.sections.map(async section => ({
          number: section.number, title: section.title,
          content: await this.readFile(join(snapshot, '正文', `${String(section.number).padStart(2, '0')}.md`))
        })))
      ])
      const story: ShortStoryDocument = {
        title: stored.title, kind: stored.kind, genre: stored.genre, brief: stored.brief,
        requirements: stored.requirements, targetWords: stored.targetWords, sectionCount: stored.sectionCount,
        id: stored.id, revision: stored.revision, sourceFingerprint: '', createdAt: stored.createdAt, updatedAt: stored.updatedAt,
        outline, review, sections
      }
      // 指纹绑定实际读取的源文件，包括因稿件变化即将隐藏的旧审核。
      story.sourceFingerprint = sourceFingerprint(story)
      assertDocument(story)
      // 用户直接改动 Markdown 后，旧审核也不能继续显示为当前稿件的结论。
      if (story.review && stored.reviewBasis !== manuscriptFingerprint(story)) story.review = ''
      return story
    } catch (error) {
      throw new Error(`SHORT_STORY_CORRUPT: 中短篇作品数据损坏或缺失（${id}），请检查作品文件夹`, { cause: error })
    }
  }

  async save(story: ShortStoryDocument): Promise<ShortStoryDocument> {
    assertDocument(story)
    // 调用时捕获数据，避免排队期间调用方继续编辑同一个对象。
    const incoming = structuredClone(story)
    const directory = this.directory(incoming.id)
    return withFileLock(directory, async () => {
      const current = await this.get(incoming.id)
      if (incoming.revision !== current.revision) {
        throw new Error('SHORT_STORY_REVISION_CONFLICT: 作品已被其他操作更新，请重新载入后再保存')
      }
      if (incoming.sourceFingerprint !== current.sourceFingerprint) {
        throw new Error('SHORT_STORY_SOURCE_CONFLICT: 作品文件已在外部修改，请重新载入后再保存')
      }
      if (incoming.sectionCount < current.sectionCount &&
        current.sections.slice(incoming.sectionCount).some(section => section.content.trim())) {
        throw new Error('SHORT_STORY_MANUSCRIPT_PROTECTED: 减少分节数会丢失已写正文，请先另存稿件')
      }
      const next: ShortStoryDocument = {
        ...incoming, title: incoming.title.trim(), revision: current.revision + 1,
        createdAt: current.createdAt, updatedAt: new Date().toISOString()
      }
      if (manuscriptChanged(current, next)) next.review = ''
      next.sourceFingerprint = sourceFingerprint(next)
      await this.commit(next)
      return next
    })
  }

  private async commit(story: ShortStoryDocument, directory = this.directory(story.id)): Promise<void> {
    const revisions = join(directory, 'revisions')
    await fs.mkdir(revisions, { recursive: true })
    await this.assertDirectory(revisions)
    const snapshotId = randomUUID()
    const snapshot = join(revisions, snapshotId)
    await fs.mkdir(snapshot)
    await fs.mkdir(join(snapshot, '正文'))
    const metadata: StoryMetadata = {
      schemaVersion: 1, id: story.id, revision: story.revision,
      createdAt: story.createdAt, updatedAt: story.updatedAt, title: story.title, kind: story.kind,
      reviewBasis: story.review ? manuscriptFingerprint(story) : '',
      genre: story.genre, brief: story.brief, requirements: story.requirements,
      targetWords: story.targetWords, sectionCount: story.sectionCount,
      sections: story.sections.map(section => ({ number: section.number, title: section.title }))
    }
    await Promise.all([
      fs.writeFile(join(snapshot, '大纲.md'), story.outline, { encoding: 'utf-8', flag: 'wx' }),
      fs.writeFile(join(snapshot, '审核.md'), story.review, { encoding: 'utf-8', flag: 'wx' }),
      ...story.sections.map(section => fs.writeFile(
        join(snapshot, '正文', `${String(section.number).padStart(2, '0')}.md`), section.content,
        { encoding: 'utf-8', flag: 'wx' }
      ))
    ])
    await fs.writeFile(join(snapshot, 'metadata.json'), JSON.stringify(metadata, null, 2), { encoding: 'utf-8', flag: 'wx' })
    const pointer: CommitPointer = { schemaVersion: 1, snapshotId, revision: story.revision }
    await writeJsonAtomic(join(directory, 'current.json'), pointer)
  }

  async export(id: string): Promise<string> {
    return shortStoryFullText(await this.get(id))
  }

  async getDirectory(id: string): Promise<string> {
    const directory = this.directory(id)
    try {
      await this.assertDirectory(this.root)
      await this.assertDirectory(directory)
      return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`SHORT_STORY_NOT_FOUND: 未找到中短篇作品（${id}）`, { cause: error })
      }
      throw new Error(`SHORT_STORY_CORRUPT: 中短篇作品目录不可读取（${id}）`, { cause: error })
    }
  }
}
