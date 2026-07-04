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
  private readonly filePath: string

  constructor(pathOrDir: string) {
    if (pathOrDir.endsWith('.json')) {
      this.filePath = pathOrDir
    } else {
      this.filePath = join(pathOrDir, 'styles.json')
    }
  }

  async read(): Promise<StyleProfileFile> {
    return readJson(this.filePath, EMPTY_FILE)
  }

  async write(data: StyleProfileFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data)
  }
}
