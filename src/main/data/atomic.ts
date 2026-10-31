import { promises as fs } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { invalidateMemoryFile } from './memory/repository-cache'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await fs.readFile(file, 'utf-8')
      return JSON.parse(raw) as T
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return fallback
      // Windows can briefly report EPERM while a listed file is being deleted or
      // atomically replaced. Retry the read, never disguise permanent denial as empty data.
      if (attempt < 2 && (e.code === 'EPERM' || e.code === 'EBUSY')) {
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
}

/**
 * 原子写入 JSON：写唯一临时文件 → rename 覆盖目标。
 * 用随机后缀避免并发调用写入同一 .tmp 文件导致 write EOF。
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(data, null, 2))
}

/**
 * 原子写入文本：写唯一临时文件 → rename 覆盖目标。
 * 用随机后缀避免并发调用写入同一 .tmp 文件导致 write EOF。
 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, text, 'utf-8')
    await fs.rename(tmp, file)
  } catch (error) {
    // 写入或替换失败时保留正式文件，清掉本次生成的临时文件。
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  invalidateMemoryFile(file)
}
