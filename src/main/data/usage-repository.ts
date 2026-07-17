import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'

export interface UsageRecord {
  at: string
  feature: string
  projectId?: string
  chapterNumber?: number
  /** 展示用模型名（CLI 可能为「gpt · codex 默认」） */
  model: string
  /** 聚合键：配置里的原始 model 字段 */
  modelId?: string
  protocol?: string
  providerId?: string
  providerLabel?: string
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
    try {
      await withFileLock(file, async () => {
        const data = await readJson<UsageLog>(file, { records: [] })
        const records = [...data.records, record]
        const trimmed =
          records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records
        await writeJsonAtomic(file, { records: trimmed })
      })
    } catch (err) {
      console.error('[usage-repository] Failed to add usage record:', err)
    }
  }

  async clear(): Promise<void> {
    try {
      await writeJsonAtomic(this.file(), { records: [] })
    } catch (err) {
      console.error('[usage-repository] Failed to clear usage:', err)
    }
  }
}
