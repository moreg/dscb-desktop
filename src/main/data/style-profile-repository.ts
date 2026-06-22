import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { StyleProfile } from '../../shared/types'

interface StyleProfileFile {
  schemaVersion: 1
  items: StyleProfile[]
}

const EMPTY_FILE: StyleProfileFile = {
  schemaVersion: 1,
  items: []
}

export class StyleProfileRepository {
  constructor(private readonly projectDir: string) {}

  async read(): Promise<StyleProfileFile> {
    return readJson(join(this.projectDir, 'styles.json'), EMPTY_FILE)
  }

  async write(data: StyleProfileFile): Promise<void> {
    await writeJsonAtomic(join(this.projectDir, 'styles.json'), data)
  }
}
