import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { ShortStoryCreateInput, ShortStoryDocument, ShortStorySummary } from '../../shared/short-story'
import { ShortStoryService } from './short-story-service'

export type ShortStoryStore = Pick<ShortStoryService, 'list' | 'create' | 'get' | 'save' | 'export' | 'getDirectory'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function absoluteDirectory(directory: string): string {
  if (typeof directory !== 'string' || !directory || directory.includes('\0') || !isAbsolute(directory)) {
    throw new Error('SHORT_STORY_LOCATION_INVALID: 保存位置必须是完整的绝对目录路径')
  }
  return resolve(directory)
}

function comparable(directory: string): string {
  return process.platform === 'win32' ? directory.toLowerCase() : directory
}

function within(parent: string, child: string): boolean {
  const base = comparable(parent)
  const target = comparable(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

function assertBoundary(root: string, candidate: string): void {
  const resolved = resolve(candidate)
  const remainder = relative(root, resolved)
  if (!within(root, resolved) || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
    throw new Error('SHORT_STORY_LOCATION_INVALID: 复制路径超出了作品目录')
  }
}

/** 检查目标和所有已有祖先，防止通过链接目录绕过父子边界或写入外部位置。 */
async function assertDirectoryPath(directory: string, allowMissing: boolean): Promise<void> {
  let current = directory
  for (;;) {
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`SHORT_STORY_LOCATION_UNSAFE: 保存路径含链接或非目录（${current}）`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function canonicalDirectory(directory: string): Promise<string> {
  const missing: string[] = []
  let current = directory
  for (;;) {
    try { return resolve(await fs.realpath(current), ...missing.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

async function probeWritable(directory: string): Promise<void> {
  const file = join(directory, `.write-check-${randomUUID()}.tmp`)
  assertBoundary(directory, file)
  const handle = await fs.open(file, 'wx')
  try { await handle.writeFile('short-story-storage') }
  finally {
    await handle.close()
    // 只清理本次独占创建的单个文件，没有递归删除或动态目录清理。
    await fs.unlink(file)
  }
}

async function checkedFile(file: string, boundary: string): Promise<Buffer> {
  assertBoundary(boundary, file)
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`SHORT_STORY_LOCATION_UNSAFE: 作品包含链接或特殊文件（${file}）`)
  }
  const handle = await fs.open(file, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('SHORT_STORY_LOCATION_CHANGED: 复制过程中作品文件发生变化，请重试')
    }
    const data = await handle.readFile()
    const after = await handle.stat()
    const current = await fs.lstat(file)
    if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      throw new Error('SHORT_STORY_LOCATION_CHANGED: 复制过程中作品文件发生变化，请重试')
    }
    return data
  } finally {
    await handle.close()
  }
}

async function directoryEntries(directory: string, boundary: string): Promise<string[]> {
  assertBoundary(boundary, directory)
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`SHORT_STORY_LOCATION_UNSAFE: 作品包含链接或非目录（${directory}）`)
  }
  return (await fs.readdir(directory)).sort()
}

async function copyTree(source: string, destination: string, sourceBoundary: string, destinationBoundary: string): Promise<void> {
  const entries = await directoryEntries(source, sourceBoundary)
  assertBoundary(destinationBoundary, destination)
  await fs.mkdir(destination)
  for (const name of entries) {
    const from = join(source, name)
    const to = join(destination, name)
    assertBoundary(sourceBoundary, from)
    assertBoundary(destinationBoundary, to)
    const stat = await fs.lstat(from)
    if (stat.isSymbolicLink()) throw new Error(`SHORT_STORY_LOCATION_UNSAFE: 作品包含链接（${from}）`)
    if (stat.isDirectory()) await copyTree(from, to, sourceBoundary, destinationBoundary)
    else await fs.writeFile(to, await checkedFile(from, sourceBoundary), { flag: 'wx' })
  }
}

/** 包括空目录、全部历史文件和损坏的原始字节，不能仅依据作品 metadata 判定相同。 */
async function treesEqual(left: string, right: string, leftBoundary: string, rightBoundary: string): Promise<boolean> {
  const leftEntries = await directoryEntries(left, leftBoundary)
  const rightEntries = await directoryEntries(right, rightBoundary)
  if (leftEntries.length !== rightEntries.length || leftEntries.some((name, index) => name !== rightEntries[index])) return false
  for (const name of leftEntries) {
    const leftFile = join(left, name)
    const rightFile = join(right, name)
    assertBoundary(leftBoundary, leftFile)
    assertBoundary(rightBoundary, rightFile)
    const [leftStat, rightStat] = await Promise.all([fs.lstat(leftFile), fs.lstat(rightFile)])
    if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
      throw new Error('SHORT_STORY_LOCATION_UNSAFE: 同名作品包含链接，不能合并')
    }
    if (leftStat.isDirectory() !== rightStat.isDirectory()) return false
    if (leftStat.isDirectory()) {
      if (!await treesEqual(leftFile, rightFile, leftBoundary, rightBoundary)) return false
    } else {
      const leftBytes = await checkedFile(leftFile, leftBoundary)
      const rightBytes = await checkedFile(rightFile, rightBoundary)
      if (!leftBytes.equals(rightBytes)) return false
    }
  }
  return true
}

async function treeSignature(directory: string, boundary: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(current: string): Promise<void> {
    const entries = await directoryEntries(current, boundary)
    hash.update(JSON.stringify(['directory', relative(directory, current)]))
    for (const name of entries) {
      const file = join(current, name)
      assertBoundary(boundary, file)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) throw new Error(`SHORT_STORY_LOCATION_UNSAFE: 作品包含链接（${file}）`)
      if (stat.isDirectory()) await walk(file)
      else {
        const bytes = await checkedFile(file, boundary)
        hash.update(JSON.stringify(['file', relative(directory, file), bytes.length]))
        hash.update(bytes)
      }
    }
  }
  await walk(directory)
  return hash.digest('hex')
}

export class ShortStoryStorage implements ShortStoryStore {
  private root: string
  private service: ShortStoryService
  private queue: Promise<void> = Promise.resolve()

  constructor(root: string, private readonly persistRoot: (path: string) => Promise<void>) {
    this.root = absoluteDirectory(root)
    this.service = new ShortStoryService(this.root)
  }

  private enqueue<T>(operation: (service: ShortStoryService) => Promise<T>, checkRoot = true): Promise<T> {
    const pending = this.queue.then(async () => {
      const service = this.service
      if (checkRoot) await assertDirectoryPath(this.root, true)
      return operation(service)
    })
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  list(): Promise<ShortStorySummary[]> { return this.enqueue(service => service.list()) }
  create(input: ShortStoryCreateInput): Promise<ShortStoryDocument> {
    const submitted = structuredClone(input)
    return this.enqueue(service => service.create(submitted))
  }
  get(id: string): Promise<ShortStoryDocument> { return this.enqueue(service => service.get(id)) }
  save(story: ShortStoryDocument): Promise<ShortStoryDocument> {
    const submitted = structuredClone(story)
    return this.enqueue(service => service.save(submitted))
  }
  export(id: string): Promise<string> { return this.enqueue(service => service.export(id)) }
  getDirectory(id: string): Promise<string> { return this.enqueue(service => service.getDirectory(id)) }
  getLocation(): Promise<string> { return this.enqueue(async () => this.root, false) }

  setLocation(directory: string): Promise<{ path: string; copiedCount: number }> {
    return this.enqueue(async () => {
      const requested = absoluteDirectory(directory)
      const source = this.root
      if (comparable(source) === comparable(requested)) return { path: source, copiedCount: 0 }
      if (within(source, requested) || within(requested, source)) {
        throw new Error('SHORT_STORY_LOCATION_NESTED: 新旧保存位置不能互相包含，请选择独立目录')
      }
      await assertDirectoryPath(requested, true)
      const sourceCanonical = await canonicalDirectory(source)
      const destination = await canonicalDirectory(requested)
      if (comparable(sourceCanonical) === comparable(destination)) return { path: source, copiedCount: 0 }
      if (within(sourceCanonical, destination) || within(destination, sourceCanonical)) {
        throw new Error('SHORT_STORY_LOCATION_NESTED: 新旧保存位置不能互相包含，请选择独立目录')
      }
      await fs.mkdir(destination, { recursive: true })
      await assertDirectoryPath(destination, false)
      await probeWritable(destination)
      let entries: string[] = []
      try { entries = await directoryEntries(source, source) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const ids = entries.filter(name => UUID.test(name))
      const signatures = new Map<string, string>()
      const staged = new Map<string, string>()
      const pending: string[] = []
      // 全部预检结束后才开始复制，后面的同编号冲突不能导致前面的作品先被发布。
      for (const id of ids) {
        const from = join(source, id)
        const to = join(destination, id)
        signatures.set(id, await treeSignature(from, source))
        let existing = false
        try { await fs.lstat(to); existing = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (existing) {
          if (!await treesEqual(from, to, source, destination)) {
            throw new Error(`SHORT_STORY_LOCATION_CONFLICT: 目标位置已有不同内容的同编号作品（${id}），原文件和目标文件均未覆盖`)
          }
          continue
        }
        pending.push(id)
      }
      for (const id of pending) {
        const from = join(source, id)
        const staging = join(destination, `.migrating-${randomUUID()}`)
        await copyTree(from, staging, source, destination)
        staged.set(id, staging)
      }
      for (const [id, staging] of staged) {
        const from = join(source, id)
        const expected = signatures.get(id)
        if (await treeSignature(from, source) !== expected || await treeSignature(staging, destination) !== expected) {
          throw new Error('SHORT_STORY_LOCATION_CHANGED: 复制过程中作品发生变化，请重试；原文件仍保留')
        }
      }
      for (const [id, staging] of staged) {
        const target = join(destination, id)
        let appeared = false
        try { await fs.lstat(target); appeared = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (appeared) throw new Error(`SHORT_STORY_LOCATION_CONFLICT: 复制期间目标新增了同编号作品（${id}），文件未覆盖`)
        // 暂存失败时保持原样，避免递归清理错误路径；列表不会将暂存目录当作作品。
        await fs.rename(staging, target)
      }
      const afterEntries = await directoryEntries(source, source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !ids.length) return []
        throw error
      })
      const afterIds = afterEntries.filter(name => UUID.test(name))
      if (ids.length !== afterIds.length || ids.some((id, index) => id !== afterIds[index])) {
        throw new Error('SHORT_STORY_LOCATION_CHANGED: 复制过程中作品列表发生变化，请重试；原文件仍保留')
      }
      // 外部编辑器不参与应用队列，切换前再次核对全部源目录和发布后的实际字节。
      for (const id of ids) {
        const from = join(source, id)
        const copy = join(destination, id)
        if (await treeSignature(from, source) !== signatures.get(id) || !await treesEqual(from, copy, source, destination)) {
          throw new Error('SHORT_STORY_LOCATION_CHANGED: 复制过程中作品发生变化，请重试；原文件仍保留')
        }
      }
      await assertDirectoryPath(destination, false)
      await probeWritable(destination)
      // 设置落盘失败时继续使用旧位置；已验证的副本可供下一次安全重试。
      await this.persistRoot(destination)
      this.root = destination
      this.service = new ShortStoryService(destination)
      return { path: destination, copiedCount: staged.size }
    })
  }
}
