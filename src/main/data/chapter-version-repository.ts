import { join } from 'path'
import { promises as fs } from 'fs'
import { readJson, writeJsonAtomic } from './atomic'
import { countWords } from './words'
import type { ChapterVersion, CreateChapterVersionInput } from '../../shared/types'

interface VersionsFile {
  schemaVersion: number
  updatedAt: string
  versions: ChapterVersion[]
}

const PAD = 3
const EMPTY: VersionsFile = { schemaVersion: 1, updatedAt: '', versions: [] }
export const MAX_CHAPTER_VERSIONS = 5

function primaryVersionsFile(projectDir: string, n: number): string {
  return join(projectDir, '正文', '.versions', `${String(n).padStart(PAD, '0')}.versions.json`)
}

function legacyVersionsFile(projectDir: string, n: number): string {
  return join(projectDir, 'chapters', `${String(n).padStart(PAD, '0')}.versions.json`)
}

export class ChapterVersionRepository {
  constructor(
    private readonly projectDir: string,
    private readonly maxVersions: number = MAX_CHAPTER_VERSIONS
  ) {}

  private async getVersionsFilePath(n: number): Promise<string> {
    const primary = primaryVersionsFile(this.projectDir, n)
    try {
      await fs.access(primary)
      return primary
    } catch {
      const legacy = legacyVersionsFile(this.projectDir, n)
      try {
        await fs.access(legacy)
        return legacy
      } catch {
        return primary
      }
    }
  }

  /**
   * 列出章节版本列表。
   * 默认按版本号/时间倒序排序（最新在最前面），且默认最多保留/返回 5 个版本。
   */
  async list(n: number, limit: number = this.maxVersions): Promise<ChapterVersion[]> {
    const filePath = await this.getVersionsFilePath(n)
    const data = await readJson<VersionsFile>(filePath, EMPTY)
    const sorted = [...(data.versions || [])].sort((a, b) => b.versionNumber - a.versionNumber)
    return sorted.slice(0, limit)
  }

  async get(n: number, vn: number): Promise<ChapterVersion> {
    const filePath = await this.getVersionsFilePath(n)
    const data = await readJson<VersionsFile>(filePath, EMPTY)
    const v = data.versions?.find((x) => x.versionNumber === vn)
    if (!v) throw new Error(`version ${vn} of chapter ${n} not found`)
    return v
  }

  /**
   * 创建新版本，自动计算版本号与字数。
   * 当版本数超出容量（默认 5）时，保留最新的 5 个版本，旧版本自动滚动移出。
   */
  async create(n: number, input: CreateChapterVersionInput): Promise<ChapterVersion> {
    const filePath = await this.getVersionsFilePath(n)
    const data = await readJson<VersionsFile>(filePath, EMPTY)
    const existing = data.versions || []
    const nextNumber =
      existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.versionNumber)) + 1
    const version: ChapterVersion = {
      versionNumber: nextNumber,
      source: input.source,
      content: input.content,
      wordCount: countWords(input.content),
      note: input.note,
      createdAt: new Date().toISOString()
    }
    let nextVersions = [...existing, version]
    if (nextVersions.length > this.maxVersions) {
      nextVersions = nextVersions.slice(-this.maxVersions)
    }
    const next: VersionsFile = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      versions: nextVersions
    }
    const targetPath = primaryVersionsFile(this.projectDir, n)
    await writeJsonAtomic(targetPath, next)
    return version
  }

  async delete(n: number, vn: number): Promise<void> {
    const filePath = await this.getVersionsFilePath(n)
    const data = await readJson<VersionsFile>(filePath, EMPTY)
    const versions = (data.versions || []).filter((v) => v.versionNumber !== vn)
    const targetPath = primaryVersionsFile(this.projectDir, n)
    await writeJsonAtomic(targetPath, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      versions
    })
  }
}
