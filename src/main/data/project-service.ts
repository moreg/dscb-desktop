import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { LibraryRepository } from './library-repository'
import { ProjectRepository } from './project-repository'
import { SettingsRepository } from './settings-repository'
import { writeTextAtomic } from './atomic'
import { readAppProjectIdentity, scanProjectsRoot } from './skill-format/library-scanner'
import { readText } from './skill-format/md-parser'
import {
  ProjectSkillRepo,
  replaceCoreBookName,
  replaceOutlineBookName
} from './skill-format/project-skill-repo'
import type {
  CreateProjectDataInput,
  ListProjectsQuery,
  ProjectData,
  ProjectMeta,
  ProjectTitleCandidate
} from '../../shared/types'
import { isProjectArchived } from '../../shared/types'

const MAX_TITLE_CANDIDATES = 50

export class ProjectService {
  constructor(
    private readonly defaultProjectsRoot: string,
    private readonly library: LibraryRepository,
    private readonly settings: SettingsRepository
  ) {}

  private readonly dirCache = new Map<string, string>()

  async create(input: CreateProjectDataInput): Promise<ProjectMeta> {
    const id = randomUUID()
    const projectsRoot = await this.settings.getProjectsRoot(this.defaultProjectsRoot)
    const dir = input.customPath ? join(input.customPath, id) : join(projectsRoot, id)
    const now = new Date().toISOString()
    // 先保存作品信息与脑洞，正式设定、规划和写作文件由后续操作按需添加。
    await new ProjectRepository(dir).write({
      schemaVersion: 1,
      updatedAt: now,
      id,
      name: input.name,
      genre: input.genre,
      description: input.description,
      targetChapters: input.targetChapters,
      chapterWordCount: input.chapterWordCount,
      createdAt: now
    })
    this.dirCache.set(id, dir)
    return this.library.create({
      id,
      name: input.name,
      description: input.description,
      path: dir,
      genre: input.genre
    })
  }

  async resolveDir(projectId: string): Promise<string> {
    const cached = this.dirCache.get(projectId)
    if (cached) return cached
    const projects = await this.library.list()
    const found = projects.find((item) => item.id === projectId)
    if (!found) throw new Error(`project not found: ${projectId}`)
    this.dirCache.set(projectId, found.path)
    return found.path
  }

  async getProjectData(projectId: string): Promise<ProjectData> {
    const dir = await this.resolveDir(projectId)
    const skillData = await new ProjectSkillRepo(dir).read()
    const persisted = await new ProjectRepository(dir).read()
    const base = persisted ?? skillData
    if (!base || !skillData && !(await readAppProjectIdentity(dir))) {
      throw new Error(`项目信息和大纲文件均不可用：${dir}`)
    }
    return {
      ...(skillData ?? base),
      ...(persisted ?? {}),
      id: projectId
    }
  }

  async updateProjectData(projectId: string, patch: Partial<ProjectData>): Promise<ProjectData> {
    const dir = await this.resolveDir(projectId)
    const current = await this.getProjectData(projectId)
    const next: ProjectData = {
      ...current,
      ...patch,
      id: projectId,
      updatedAt: new Date().toISOString()
    }
    await new ProjectRepository(dir).write(next)
    return next
  }

  /**
   * 保存书名和简介。书名会同步成同级文件夹名，并写回大纲标题与核心设定。
   * 文件夹名不能用的符号换成全角，返回的 name 就是最终文件夹名。
   */
  async updateProjectInfo(
    projectId: string,
    info: { name: string; description?: string }
  ): Promise<ProjectData> {
    const folderName = toFolderName(info.name)
    if (!folderName) throw new Error('这个名称不能用作文件夹名')

    const currentDir = await this.resolveDir(projectId)
    const nextDir = await this.renameProjectFolder(projectId, currentDir, folderName)
    try {
      const next = await this.updateProjectData(projectId, {
        name: folderName,
        description: info.description
      })
      await writeFolderTitle(nextDir, folderName)
      await this.library.update(projectId, {
        name: folderName,
        description: next.description,
        path: nextDir
      })
      return { ...next, name: folderName }
    } catch (err) {
      if (nextDir !== currentDir) {
        try {
          await renameDir(nextDir, currentDir)
          this.dirCache.set(projectId, currentDir)
        } catch {
          // 文件夹已经改名，但书名没写完。保留新路径，避免索引指回不存在的旧目录。
          this.dirCache.set(projectId, nextDir)
        }
      }
      throw err
    }
  }

  /** 把项目目录改成同级下的新文件夹名。名字没变时原地返回。 */
  private async renameProjectFolder(projectId: string, currentDir: string, folderName: string): Promise<string> {
    if (basename(currentDir) === folderName) return currentDir
    const target = join(dirname(currentDir), folderName)
    if (await pathExists(target) && !samePath(currentDir, target)) {
      throw new Error(`已经有同名文件夹：${folderName}`)
    }
    try {
      await renameDir(currentDir, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new Error('文件夹正在被占用，请关掉正在使用这本书的程序后再保存', { cause: err })
      }
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        throw new Error(`已经有同名文件夹：${folderName}`, { cause: err })
      }
      throw err
    }
    this.dirCache.set(projectId, target)
    return target
  }

  /** 追加灵感抽签候选；同名同简介视为重复，最新的排在最前。 */
  async addTitleCandidate(
    projectId: string,
    candidate: { name: string; description: string; seed?: string }
  ): Promise<ProjectTitleCandidate[]> {
    const current = (await this.getProjectData(projectId)).titleCandidates ?? []
    const duplicate = current.some(
      (item) => item.name === candidate.name && item.description === candidate.description
    )
    if (duplicate) return current
    const next: ProjectTitleCandidate[] = [
      { id: randomUUID(), ...candidate, createdAt: new Date().toISOString() },
      ...current
    ].slice(0, MAX_TITLE_CANDIDATES)
    const updated = await this.updateProjectData(projectId, { titleCandidates: next })
    return updated.titleCandidates ?? []
  }

  async removeTitleCandidate(projectId: string, candidateId: string): Promise<ProjectTitleCandidate[]> {
    const current = (await this.getProjectData(projectId)).titleCandidates ?? []
    const next = current.filter((item) => item.id !== candidateId)
    if (next.length === current.length) return current
    const updated = await this.updateProjectData(projectId, { titleCandidates: next })
    return updated.titleCandidates ?? []
  }

  async listProjects(query: ListProjectsQuery = {}): Promise<ProjectMeta[]> {
    const all = await this.library.list()
    const filtered: ProjectMeta[] = []
    for (const project of all) {
      if (!query.includeArchived && isProjectArchived(project)) continue
      if (!(await hasProjectFiles(project.path))) continue
      // project.json 是小说名称/简介的主数据；兼容旧 library.json 没有 description
      // 或名称尚未同步的项目。读取失败时仍保留索引条目。
      const data = await new ProjectRepository(project.path).read().catch(() => null)
      filtered.push({
        ...project,
        ...(data?.name ? { name: data.name } : {}),
        ...(data ? { description: data.description, genre: data.genre } : {})
      })
    }
    return filtered
  }

  async setArchived(projectId: string, archived: boolean): Promise<ProjectMeta> {
    return this.library.setArchived(projectId, archived)
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    const root = await this.settings.getProjectsRoot(this.defaultProjectsRoot)
    const discovered = await scanProjectsRoot(root)
    const existing = [...await this.library.list()]
    for (const item of discovered) {
      const folderName = basename(item.path)
      // 旧目录已不在，说明这本书是改文件夹名之后又被扫到的。文件夹名就是要同步的新书名。
      const renamed =
        isUsableFolderTitle(folderName) && (await folderWasRenamed(existing, item.path, item.name))
      const title = renamed ? folderName : item.name
      let known = existing.find((project) => samePath(project.path, item.path))
      const sameId = item.id ? existing.find(project => project.id === item.id) : undefined
      if (!known && sameId && !(await hasProjectFiles(sameId.path))) {
        // 文件夹移动后仍使用原作品 ID，保留归档状态和脑洞库关联。
        const updated = await this.library.update(sameId.id, { name: title, path: item.path })
        Object.assign(sameId, updated)
        this.dirCache.set(sameId.id, item.path)
        known = sameId
      }
      if (!known) {
        // 复制的目录可能携带原作品 ID；原目录仍在时为副本分配独立 ID。
        const created = await this.library.create({ id: sameId ? undefined : item.id, name: title, path: item.path })
        existing.push(created)
        known = created
      } else if (known.name !== title) {
        await this.library.update(known.id, { name: title })
        known.name = title
      }
      const repo = new ProjectRepository(item.path)
      const data = await repo.read().catch(() => null)
      if (data?.schemaVersion === 1 && typeof data.name === 'string' && data.id !== known.id) {
        await repo.write({ ...data, id: known.id, updatedAt: new Date().toISOString() })
      }
      if (title !== item.name) await writeFolderTitle(item.path, title)
    }
    return this.listProjects()
  }
}

const FOLDER_CHAR: Record<string, string> = {
  '<': '＜',
  '>': '＞',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊'
}

/** 书名转成 Windows 能用的文件夹名。非法符号换成全角，返回值就是要保存的书名。 */
export function toFolderName(name: string): string {
  const replaced = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, (ch) => FOLDER_CHAR[ch] ?? '')
  const cleaned = replaced.replace(/[. ]+$/g, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return ''
  if (isReservedWindowsName(cleaned)) return ''
  return [...cleaned].slice(0, 255).join('')
}

function isReservedWindowsName(name: string): boolean {
  const stem = name.split('.')[0]?.toUpperCase() ?? ''
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => (process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value)
  return norm(a) === norm(b)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function renameDir(from: string, to: string): Promise<void> {
  if (from === to) return
  const caseOnly = process.platform === 'win32' && samePath(from, to)
  if (caseOnly) {
    const temp = join(dirname(from), `.rename-${randomUUID()}`)
    await renameDirOnce(from, temp)
    await renameDirOnce(temp, to)
    return
  }
  await renameDirOnce(from, to)
}

async function renameDirOnce(from: string, to: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      last = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)))
    }
  }
  throw last
}

/** 纯数字、uuid 这类目录名不是书名，扫描时不拿来覆盖大纲标题。 */
function isUsableFolderTitle(name: string): boolean {
  const title = name.trim()
  if (title.length < 2) return false
  if (/^\d+$/.test(title)) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)) return false
  return true
}

/**
 * 书架里还有一条同名记录，但它的目录已经没有有效项目文件。
 * 这是同一本书被改了文件夹名，不是另一本恰好同名的新书。
 */
async function folderWasRenamed(
  existing: ProjectMeta[],
  newPath: string,
  outlineName: string
): Promise<boolean> {
  if (!outlineName) return false
  for (const project of existing) {
    if (project.path === newPath) continue
    if (project.name !== outlineName && basename(project.path) !== outlineName) continue
    if (!(await hasProjectFiles(project.path))) return true
  }
  return false
}

/** 把大纲标题、核心设定和 project.json 里的书名写成文件夹名。 */
async function writeFolderTitle(dir: string, folderName: string): Promise<void> {
  const outlinePath = join(dir, '大纲', '大纲.md')
  const outline = await readText(outlinePath)
  if (outline) {
    const next = replaceOutlineBookName(outline, folderName)
    if (next !== outline) await writeTextAtomic(outlinePath, next)
  }
  const corePath = join(dir, '设定', '核心设定.md')
  const core = await readText(corePath)
  if (core) {
    const next = replaceCoreBookName(core, folderName)
    if (next !== core) await writeTextAtomic(corePath, next)
  }
  const repo = new ProjectRepository(dir)
  const data = await repo.read()
  if (data && data.name !== folderName) {
    await repo.write({ ...data, name: folderName, updatedAt: new Date().toISOString() })
  }
}

async function hasV3Outline(projectDir: string): Promise<boolean> {
  try {
    await fs.access(join(projectDir, '大纲', '大纲.md'))
    return true
  } catch {
    return false
  }
}

async function hasProjectFiles(projectDir: string): Promise<boolean> {
  return !!(await readAppProjectIdentity(projectDir)) || await hasV3Outline(projectDir)
}
