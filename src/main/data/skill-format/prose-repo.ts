import { join } from 'path'
import { promises as fs } from 'fs'
import { writeTextAtomic } from '../atomic'

const PAD = 3

/**
 * 正文仓储。app 独占，真相源：`正文/第NNN章.md`（NNN = 章号零填充 3 位）。
 * v3.2 技能不含正文，此目录由 app 拥有。
 *
 * Phase 1 约定：文件内为纯正文，不含 H1（章号在文件名，标题在节奏图谱/章节进度）。
 * 保持与旧 chapters/NNN.md 一致，ChapterEditor 无需改动。
 */
export class ProseRepo {
  constructor(private readonly projectDir: string) {}

  private file(n: number): string {
    return join(this.projectDir, '正文', `${String(n).padStart(PAD, '0')}.md`)
  }

  async read(n: number): Promise<string> {
    try {
      return await fs.readFile(this.file(n), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return ''
      throw err
    }
  }

  async write(n: number, content: string): Promise<void> {
    await writeTextAtomic(this.file(n), content)
  }

  async exists(n: number): Promise<boolean> {
    try {
      await fs.access(this.file(n))
      return true
    } catch {
      return false
    }
  }
}
