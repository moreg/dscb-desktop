import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { LibraryRepository } from './library-repository'
import { ProjectRepository } from './project-repository'
import { SettingsRepository } from './settings-repository'
import { writeTextAtomic } from './atomic'
import { scanProjectsRoot } from './skill-format/library-scanner'
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
    await this.writeV3Skeleton(dir, input)
    this.dirCache.set(id, dir)
    return this.library.create({
      id,
      name: input.name,
      description: input.description,
      path: dir,
      genre: input.genre
    })
  }

  private async writeV3Skeleton(dir: string, input: CreateProjectDataInput): Promise<void> {
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const header = `**版本**：v1.0（${today} 创建）\n**修改记录**\n- v1.0（${today}）：初版\n\n`
    const genre = input.genre ?? '未指定'
    const tc = input.targetChapters ?? ''
    const cwc = input.chapterWordCount ?? ''
    const desc = input.description ?? ''
    const outlineBody =
      `# 《${input.name}》大纲\n\n` +
      `## 基本信息\n` +
      `- **题材**：${genre}\n` +
      (tc ? `- **预计章节数**：${tc} 章\n` : '') +
      (cwc ? `- **每章字数**：约 ${cwc} 字\n` : '') +
      (desc ? `- **简介**：${desc}\n` : '') +
      `\n## 主线剧情走向\n\n（待生成）\n`

    // ===== 设定 / 计划 / 写作产物 =====
    await fs.mkdir(join(dir, '设定', '世界观'), { recursive: true })
    await fs.mkdir(join(dir, '设定', '角色'), { recursive: true })
    await fs.mkdir(join(dir, '设定', '势力'), { recursive: true })
    await fs.mkdir(join(dir, '大纲'), { recursive: true })
    await fs.mkdir(join(dir, '细纲'), { recursive: true })
    await fs.mkdir(join(dir, '图解'), { recursive: true })
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.mkdir(join(dir, '追踪'), { recursive: true })
    await fs.mkdir(join(dir, '对标'), { recursive: true })
    await fs.mkdir(join(dir, '资料'), { recursive: true })

    // ===== 记忆/（v4：取代 v3 的 记忆系统/ + chapters/）=====
    await fs.mkdir(join(dir, '记忆', '人物'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '地点'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '世界观'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '时间线'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '剧情点'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '关系'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '伏笔'), { recursive: true })
    await fs.mkdir(join(dir, '记忆', '道具'), { recursive: true })

    // 初始文件（含细纲生成依赖的核心设定 + 追踪表头，便于后续 append 行）
    await writeTextAtomic(join(dir, '大纲', '大纲.md'), header + outlineBody)
    await writeTextAtomic(
      join(dir, '设定', '核心设定.md'),
      header +
        `# 核心设定\n\n` +
        `## 基本信息\n` +
        `- **书名**：${input.name}\n` +
        `- **题材**：${genre}\n` +
        (tc ? `- **预计章节数**：${tc} 章\n` : '') +
        (cwc ? `- **每章字数**：约 ${cwc} 字\n` : '') +
        (desc ? `- **简介**：${desc}\n` : '') +
        `\n## 核心设定\n\n（待完善）\n`
    )
    await writeTextAtomic(join(dir, '设定', '题材定位.md'), header + `# 题材定位\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '背景设定.md'), header + `# 背景设定\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '力量体系.md'), header + `# 力量体系\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '金手指.md'), header + `# 金手指\n`)
    await writeTextAtomic(join(dir, '设定', '关系.md'), header + `# 角色关系\n`)
    await writeTextAtomic(
      join(dir, '追踪', '伏笔.md'),
      header +
        `# 伏笔追踪\n\n` +
        `| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n` +
        `|---|---|---|---|---|---|---|\n`
    )
    await writeTextAtomic(
      join(dir, '追踪', '时间线.md'),
      header +
        `# 时间线\n\n` +
        `| 章节 | 事件名 | 时间跨度 | 涉及角色 | 详细描述 |\n` +
        `|---|---|---|---|---|\n`
    )
    await writeTextAtomic(
      join(dir, '追踪', '角色状态.md'),
      header +
        `# 角色状态快照\n\n` +
        `| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n` +
        `|---|---|---|---|---|---|---|\n`
    )
    await writeTextAtomic(
      join(dir, '追踪', '上下文.md'),
      header +
        `# 上下文（日更进度摘要）\n\n` +
        `| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n` +
        `|---|---|---|---|---|\n`
    )
    await writeTextAtomic(
      join(dir, '追踪', '问题记录.md'),
      header +
        `# 问题记录\n\n` +
        `| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |\n` +
        `|---|---|---|---|---|\n`
    )
    await writeTextAtomic(join(dir, '追踪', '索引.md'), TRACKING_INDEX_TEMPLATE)

    await writeTextAtomic(join(dir, '记忆', '索引.md'), MEMORY_INDEX_TEMPLATE)

    await new ProjectRepository(dir).write({
      schemaVersion: 1,
      updatedAt: now,
      id: '',
      name: input.name,
      genre: input.genre,
      description: input.description,
      targetChapters: input.targetChapters,
      chapterWordCount: input.chapterWordCount,
      createdAt: now
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
    if (!skillData) throw new Error(`大纲.md missing in ${dir}`)
    const persisted = await new ProjectRepository(dir).read()
    return {
      ...skillData,
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
        throw new Error('文件夹正在被占用，请关掉正在使用这本书的程序后再保存')
      }
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        throw new Error(`已经有同名文件夹：${folderName}`)
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
      if (!(await hasV3Outline(project.path))) continue
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
    const existing = await this.library.list()
    for (const item of discovered) {
      const folderName = basename(item.path)
      // 旧目录已不在，说明这本书是改文件夹名之后又被扫到的。文件夹名就是要同步的新书名。
      const renamed =
        isUsableFolderTitle(folderName) && (await folderWasRenamed(existing, item.path, item.name))
      const title = renamed ? folderName : item.name
      const known = existing.find((project) => project.path === item.path)
      if (!known) {
        const created = await this.library.create({ name: title, path: item.path })
        existing.push(created)
      } else if (known.name !== title) {
        await this.library.update(known.id, { name: title })
        known.name = title
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
 * 书架里还有一条同名记录，但它的目录已经没有大纲。
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
    if (!(await hasV3Outline(project.path))) return true
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

const MEMORY_INDEX_TEMPLATE = `# 记忆索引

> 此目录由 app 自动维护，来源于 设定/、追踪/、细纲/。
> 建议在 app「记忆中心」操作；如需手改，编辑后请点 🔄 刷新。

## 人物（0）
## 地点（0）
## 世界观（0）
## 时间线（0）
## 剧情点（0）
## 关系（0）
## 伏笔（0）
## 道具（0）

## 最近更新

- （暂无）
`

const TRACKING_INDEX_TEMPLATE = `# 追踪索引

> 写作过程中的实时状态：伏笔、时间线、角色状态、上下文、问题记录。

| 文件 | 用途 | 最近更新 |
|------|------|----------|
| 伏笔.md | 伏笔埋设与回收表 | — |
| 时间线.md | 历史事件与小说事件对照 | — |
| 角色状态.md | 角色当前实力/立场/关系 | — |
| 上下文.md | 日更进度备注（阻塞/下一章目标；章级记忆见 记忆/剧情点） | — |
| 问题记录.md | 待处理问题 | — |
`
