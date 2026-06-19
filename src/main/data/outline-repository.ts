import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import { withFileLock } from './file-lock'
import type { MainOutline, DetailedOutline, DetailedOutlineItem } from '../../shared/types'

const EMPTY_DETAILED: DetailedOutline = { schemaVersion: 1, updatedAt: '', items: [] }

export class OutlineRepository {
  constructor(private readonly projectDir: string) {}

  async readMain(): Promise<MainOutline | null> {
    return readJson<MainOutline | null>(join(this.projectDir, 'outlines', 'main.json'), null)
  }

  async writeMain(data: MainOutline): Promise<void> {
    await writeJsonAtomic(join(this.projectDir, 'outlines', 'main.json'), data)
  }

  async listDetailed(): Promise<DetailedOutlineItem[]> {
    const data = await readJson<DetailedOutline>(
      join(this.projectDir, 'outlines', 'detailed.json'),
      EMPTY_DETAILED
    )
    return data.items
  }

  async upsertDetailed(item: DetailedOutlineItem): Promise<DetailedOutlineItem> {
    const file = join(this.projectDir, 'outlines', 'detailed.json')
    return withFileLock(file, async () => {
      const data = await readJson<DetailedOutline>(file, EMPTY_DETAILED)
      const idx = data.items.findIndex((x) => x.chapterNumber === item.chapterNumber)
      const items = [...data.items]
      if (idx >= 0) items[idx] = item
      else items.push(item)
      items.sort((a, b) => a.chapterNumber - b.chapterNumber)
      await writeJsonAtomic(file, { ...data, updatedAt: new Date().toISOString(), items })
      return item
    })
  }
}
