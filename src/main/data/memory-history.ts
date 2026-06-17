import { promises as fs } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../../shared/types'

export class MemoryHistory {
  constructor(private readonly projectDir: string) {}

  private file(): string {
    return join(this.projectDir, 'memory', 'history.jsonl')
  }

  async append(entry: HistoryEntry): Promise<void> {
    await fs.mkdir(join(this.projectDir, 'memory'), { recursive: true })
    await fs.appendFile(this.file(), JSON.stringify(entry) + '\n', 'utf-8')
  }

  async list(): Promise<HistoryEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HistoryEntry)
  }
}
