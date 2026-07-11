import { promises as fs } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return fallback
    throw err
  }
}

/**
 * 原子写入 JSON：写唯一临时文件 → rename 覆盖目标。
 * 用随机后缀避免并发调用写入同一 .tmp 文件导致 write EOF。
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/**
 * 原子写入文本：写唯一临时文件 → rename 覆盖目标。
 * 用随机后缀避免并发调用写入同一 .tmp 文件导致 write EOF。
 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, file)
}
