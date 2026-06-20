import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { LibraryRepository } from './library-repository'
import { SettingsRepository } from './settings-repository'
import { writeTextAtomic } from './atomic'
import { ProjectSkillRepo } from './skill-format/project-skill-repo'
import { scanProjectsRoot } from './skill-format/library-scanner'
import type { ProjectData, ProjectMeta, CreateProjectDataInput } from '../../shared/types'

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

  /**
   * 生成 v3.2 干净格式的项目骨架：大纲/ + 细纲/ + 图解/ + 记忆系统/（7 个空 .md） + 正文/。
   * 每个 .md 顶部带版本头，符合技能 v3.2 硬性格式。
   */
  private async writeV3Skeleton(dir: string, input: CreateProjectDataInput): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    const header = `**版本**：v1.0（${today} 创建）\n**修改记录**：\n- v1.0（${today}）：初版\n\n`

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

    await writeTextAtomic(join(dir, '大纲', '大纲.md'), header + outlineBody)
    await writeTextAtomic(join(dir, '大纲', '提示词.md'), header + `# 《${input.name}》创作提示词\n`)

    const memoryFiles = ['角色卡', '世界观设定', '地点档案', '核心情节', '章节进度', '伏笔追踪', '问题记录']
    for (const name of memoryFiles) {
      await writeTextAtomic(join(dir, '记忆系统', `${name}.md`), header + `# ${name}\n`)
    }

    await fs.mkdir(join(dir, '细纲'), { recursive: true })
    await fs.mkdir(join(dir, '图解'), { recursive: true })
    await fs.mkdir(join(dir, '正文'), { recursive: true })
  }

  async resolveDir(projectId: string): Promise<string> {
    const cached = this.dirCache.get(projectId)
    if (cached) return cached
    const projects = await this.library.list()
    const p = projects.find((x) => x.id === projectId)
    if (!p) throw new Error(`project not found: ${projectId}`)
    this.dirCache.set(projectId, p.path)
    return p.path
  }

  async getProjectData(projectId: string): Promise<ProjectData> {
    const dir = await this.resolveDir(projectId)
    const repo = new ProjectSkillRepo(dir)
    const data = await repo.read()
    if (!data) throw new Error(`大纲.md missing in ${dir}`)
    return { ...data, id: projectId }
  }

  /**
   * 列出所有已登记项目，过滤掉非 v3.2 项目（无 大纲/大纲.md）。
   * 解决「不兼容旧格式」——旧 JSON 项目和旧 .learnings/ 目录不会出现。
   */
  async listProjects(): Promise<ProjectMeta[]> {
    const all = await this.library.list()
    const filtered: ProjectMeta[] = []
    for (const p of all) {
      if (await hasV3Outline(p.path)) filtered.push(p)
    }
    return filtered
  }

  /**
   * 扫描 projectsRoot 下含 `大纲/大纲.md` 的子目录，登记进 library.json。
   * 已登记（按 path 去重）的不重复添加。返回过滤后的完整项目列表。
   */
  async scanProjects(): Promise<ProjectMeta[]> {
    const root = await this.settings.getProjectsRoot(this.defaultProjectsRoot)
    const discovered = await scanProjectsRoot(root)
    const existing = await this.library.list()
    const knownPaths = new Set(existing.map((p) => p.path))
    for (const d of discovered) {
      if (!knownPaths.has(d.path)) {
        await this.library.create({ name: d.name, path: d.path })
        knownPaths.add(d.path)
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
