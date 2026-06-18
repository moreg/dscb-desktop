import { OutlineRepository } from './outline-repository'
import type { ProjectService } from './project-service'
import type { LlmService } from './llm-service'
import type { MainOutline, DetailedOutlineItem } from '../../shared/types'

export class OutlineService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  private async repo(projectId: string): Promise<OutlineRepository> {
    const dir = await this.projectService.resolveDir(projectId)
    return new OutlineRepository(dir)
  }

  async getMain(projectId: string): Promise<MainOutline | null> {
    return (await this.repo(projectId)).readMain()
  }

  async generateMain(projectId: string): Promise<MainOutline> {
    const data = await this.projectService.getProjectData(projectId)
    const repo = await this.repo(projectId)
    const prompt = `请为小说《${data.name}》（题材：${data.genre ?? '未指定'}）写一段约 300 字的故事总纲，包含主线和核心冲突。直接输出总纲正文，不要标题或解释。`
    const synopsis = await this.llm.generateStream(prompt)
    const main: MainOutline = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      synopsis
    }
    await repo.writeMain(main)
    return main
  }

  async listDetailed(projectId: string): Promise<DetailedOutlineItem[]> {
    return (await this.repo(projectId)).listDetailed()
  }

  async generateDetailed(
    projectId: string,
    chapterNumber: number
  ): Promise<DetailedOutlineItem> {
    const repo = await this.repo(projectId)
    const main = await repo.readMain()
    const synopsis = main?.synopsis ?? '（无总纲）'
    const prompt = `小说总纲：${synopsis}\n\n请为第 ${chapterNumber} 章写一段细纲（约 200 字），包含剧情概要、情绪点、爽点和章末钩子。直接输出细纲正文。`
    const plotSummary = await this.llm.generateStream(prompt)
    const item: DetailedOutlineItem = { chapterNumber, plotSummary }
    await repo.upsertDetailed(item)
    return item
  }
}
