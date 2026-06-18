import { promises as fs } from 'fs'
import { join } from 'path'
import { readJson, writeJsonAtomic, writeTextAtomic } from './atomic'
import { countWords } from './words'
import type {
  ChapterMeta,
  ChapterContent,
  CreateChapterInput,
  UpdateChapterMetaInput
} from '../../shared/types'

const PAD = 3

function chapterFile(projectDir: string, n: number, ext: string): string {
  return join(projectDir, 'chapters', `${String(n).padStart(PAD, '0')}.${ext}`)
}

export class ChapterRepository {
  constructor(private readonly projectDir: string) {}

  async list(): Promise<ChapterMeta[]> {
    const chaptersDir = join(this.projectDir, 'chapters')
    let files: string[]
    try {
      files = await fs.readdir(chaptersDir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    const metas: ChapterMeta[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.meta.json')) continue
      const meta = await readJson<ChapterMeta | null>(join(chaptersDir, f), null)
      if (meta) metas.push(meta)
    }
    return metas.sort((a, b) => a.chapterNumber - b.chapterNumber)
  }

  async get(n: number): Promise<ChapterContent> {
    const meta = await readJson<ChapterMeta | null>(
      chapterFile(this.projectDir, n, 'meta.json'),
      null
    )
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    let content = ''
    try {
      content = await fs.readFile(chapterFile(this.projectDir, n, 'md'), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
    }
    return { meta, content }
  }

  async create(input: CreateChapterInput): Promise<ChapterMeta> {
    const list = await this.list()
    const nextNumber = list.length === 0 ? 1 : Math.max(...list.map((m) => m.chapterNumber)) + 1
    const now = new Date().toISOString()
    const meta: ChapterMeta = {
      schemaVersion: 1,
      updatedAt: now,
      chapterNumber: nextNumber,
      title: input.title,
      wordCount: 0,
      status: 'outline'
    }
    await writeJsonAtomic(chapterFile(this.projectDir, nextNumber, 'meta.json'), meta)
    await writeTextAtomic(chapterFile(this.projectDir, nextNumber, 'md'), '')
    return meta
  }

  async updateContent(n: number, content: string): Promise<ChapterMeta> {
    const meta = await readJson<ChapterMeta | null>(
      chapterFile(this.projectDir, n, 'meta.json'),
      null
    )
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    await writeTextAtomic(chapterFile(this.projectDir, n, 'md'), content)
    const next: ChapterMeta = {
      ...meta,
      wordCount: countWords(content),
      updatedAt: new Date().toISOString()
    }
    await writeJsonAtomic(chapterFile(this.projectDir, n, 'meta.json'), next)
    return next
  }

  async updateMeta(n: number, patch: UpdateChapterMetaInput): Promise<ChapterMeta> {
    const meta = await readJson<ChapterMeta | null>(
      chapterFile(this.projectDir, n, 'meta.json'),
      null
    )
    if (!meta) throw new Error(`chapter ${n} meta not found`)
    const next: ChapterMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(chapterFile(this.projectDir, n, 'meta.json'), next)
    return next
  }

  async delete(n: number): Promise<void> {
    await fs.unlink(chapterFile(this.projectDir, n, 'md')).catch(() => undefined)
    await fs.unlink(chapterFile(this.projectDir, n, 'meta.json')).catch(() => undefined)
  }
}
