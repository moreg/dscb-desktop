import { join } from 'path'
import { readJson, writeJsonAtomic } from './atomic'
import type { StyleProfile } from '../../shared/types'

interface StyleProfileFile {
  schemaVersion: 1
  items: StyleProfile[]
}

/**
 * 每次调用返回全新对象。绝不能共用一个模块级常量：文件缺失时 readJson 会把 fallback
 * 原样返回，调用方（StyleProfileService.create 的 items.push）随后就地修改它，
 * 会把已删除/已保存的文风泄漏给之后所有"文件不存在"的读取。
 */
function emptyFile(): StyleProfileFile {
  return { schemaVersion: 1, items: [] }
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
    return readJson(this.filePath, emptyFile())
  }

  async write(data: StyleProfileFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data)
  }
}
