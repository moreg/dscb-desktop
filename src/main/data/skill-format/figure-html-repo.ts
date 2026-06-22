import { join } from 'path'
import { promises as fs } from 'fs'
import { writeTextAtomic } from '../atomic'

/**
 * 关键情节图解 repo。
 * 真相源：`图解/[类型]_[主题].html`（Mermaid HTML）。
 */
export class FigureHtmlRepo {
  constructor(private readonly projectDir: string) {}

  private file(fileName: string): string {
    return join(this.projectDir, '图解', fileName)
  }

  async write(fileName: string, html: string): Promise<string> {
    await writeTextAtomic(this.file(fileName), html)
    return fileName
  }

  async exists(fileName: string): Promise<boolean> {
    try {
      await fs.access(this.file(fileName))
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(join(this.projectDir, '图解'))
      return entries.filter((f) => f.endsWith('.html') && f !== '节奏图谱.html')
    } catch {
      return []
    }
  }
}
