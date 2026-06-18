import { join } from 'path'
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

function versionsFile(projectDir: string, n: number): string {
  return join(projectDir, 'chapters', `${String(n).padStart(PAD, '0')}.versions.json`)
}

export class ChapterVersionRepository {
  constructor(private readonly projectDir: string) {}

  async list(n: number): Promise<ChapterVersion[]> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    return data.versions
  }

  async get(n: number, vn: number): Promise<ChapterVersion> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const v = data.versions.find((x) => x.versionNumber === vn)
    if (!v) throw new Error(`version ${vn} of chapter ${n} not found`)
    return v
  }

  async create(n: number, input: CreateChapterVersionInput): Promise<ChapterVersion> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const nextNumber =
      data.versions.length === 0 ? 1 : Math.max(...data.versions.map((v) => v.versionNumber)) + 1
    const version: ChapterVersion = {
      versionNumber: nextNumber,
      source: input.source,
      content: input.content,
      wordCount: countWords(input.content),
      note: input.note,
      createdAt: new Date().toISOString()
    }
    const next: VersionsFile = {
      ...data,
      updatedAt: new Date().toISOString(),
      versions: [...data.versions, version]
    }
    await writeJsonAtomic(versionsFile(this.projectDir, n), next)
    return version
  }

  async delete(n: number, vn: number): Promise<void> {
    const data = await readJson<VersionsFile>(versionsFile(this.projectDir, n), EMPTY)
    const versions = data.versions.filter((v) => v.versionNumber !== vn)
    await writeJsonAtomic(versionsFile(this.projectDir, n), {
      ...data,
      updatedAt: new Date().toISOString(),
      versions
    })
  }
}
