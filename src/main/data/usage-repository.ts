import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'

export interface UsageRecord {
  at: string
  feature: string
  projectId?: string
  chapterNumber?: number
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

interface UsageLog {
  records: UsageRecord[]
}

const MAX_RECORDS = 5000

export class UsageRepository {
  constructor(private readonly settingsDir: string) {}

  private file(): string {
    return join(this.settingsDir, 'usage.json')
  }

  async list(): Promise<UsageRecord[]> {
    const data = await readJson<UsageLog>(this.file(), { records: [] })
    return data.records
  }

  async add(record: UsageRecord): Promise<void> {
    const file = this.file()
    await withFileLock(file, async () => {
      const data = await readJson<UsageLog>(file, { records: [] })
      const records = [...data.records, record]
      // 保留最近 MAX_RECORDS 条
      const trimmed =
        records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records
      await writeJsonAtomic(file, { records: trimmed })
    })
  }

  async clear(): Promise<void> {
    await writeJsonAtomic(this.file(), { records: [] })
  }
}
