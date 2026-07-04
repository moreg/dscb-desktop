import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { LibraryRepository } from './library-repository'
import { ProjectRepository } from './project-repository'
import { SettingsRepository } from './settings-repository'
import { writeTextAtomic } from './atomic'
import { scanProjectsRoot } from './skill-format/library-scanner'
import { ProjectSkillRepo } from './skill-format/project-skill-repo'
import type { CreateProjectDataInput, ProjectData, ProjectMeta } from '../../shared/types'

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
    return this.library.create({ id, name: input.name, path: dir, genre: input.genre })
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

    await fs.mkdir(join(dir, '设定', '世界观'), { recursive: true })
    await fs.mkdir(join(dir, '设定', '角色'), { recursive: true })
    await fs.mkdir(join(dir, '设定', '势力'), { recursive: true })
    await fs.mkdir(join(dir, '大纲'), { recursive: true })
    await fs.mkdir(join(dir, '细纲'), { recursive: true })
    await fs.mkdir(join(dir, '图解'), { recursive: true })
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.mkdir(join(dir, '追踪'), { recursive: true })
    await fs.mkdir(join(dir, '对标'), { recursive: true })
    await fs.mkdir(join(dir, '参考资料'), { recursive: true })
    await fs.mkdir(join(dir, 'chapters'), { recursive: true })

    await writeTextAtomic(join(dir, '大纲', '大纲.md'), header + outlineBody)
    await writeTextAtomic(join(dir, '设定', '题材定位.md'), header + `# 题材定位\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '背景设定.md'), header + `# 背景设定\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '力量体系.md'), header + `# 力量体系\n`)
    await writeTextAtomic(join(dir, '设定', '世界观', '金手指.md'), header + `# 金手指\n`)
    await writeTextAtomic(join(dir, '设定', '关系.md'), header + `# 角色关系\n`)
    await writeTextAtomic(join(dir, '追踪', '伏笔.md'), header + `# 伏笔追踪\n`)
    await writeTextAtomic(join(dir, '追踪', '时间线.md'), header + `# 时间线\n`)
    await writeTextAtomic(join(dir, '追踪', '角色状态.md'), header + `# 角色状态快照\n`)
    await writeTextAtomic(join(dir, '追踪', '上下文.md'), header + `# 上下文\n`)
    await writeTextAtomic(join(dir, '追踪', '问题记录.md'), header + `# 问题记录\n`)

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

  async listProjects(): Promise<ProjectMeta[]> {
    const all = await this.library.list()
    const filtered: ProjectMeta[] = []
    for (const project of all) {
      if (await hasV3Outline(project.path)) filtered.push(project)
    }
    return filtered
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    const root = await this.settings.getProjectsRoot(this.defaultProjectsRoot)
    const discovered = await scanProjectsRoot(root)
    const existing = await this.library.list()
    const knownPaths = new Set(existing.map((project) => project.path))
    for (const item of discovered) {
      if (!knownPaths.has(item.path)) {
        await this.library.create({ name: item.name, path: item.path })
        knownPaths.add(item.path)
      }
    }
    return this.listProjects()
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
