import type { ProjectService } from './project-service'
import type { LlmService, GenerateOptions } from './llm-service'
import { OutlineRepository } from './outline-repository'
import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { ChapterRepository } from './chapter-repository'

export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  async buildChapterPrompt(projectId: string, chapterNumber: number): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)

    const outline = new OutlineRepository(dir)
    const main = await outline.readMain()
    const detailed = await outline.listDetailed()
    const detail = detailed.find((d) => d.chapterNumber === chapterNumber)

    const characters = await new CharacterRepository(dir).list()
    const foreshadowings = await new ForeshadowingRepository(dir).list()
    const chapterRepo = new ChapterRepository(dir)
    const chapters = await chapterRepo.list()
    const prev = chapters.find((c) => c.chapterNumber === chapterNumber - 1)
    let prevSummary = ''
    if (prev) {
      const prevContent = await chapterRepo.get(prev.chapterNumber)
      prevSummary = prevContent.content.slice(0, 400)
    }

    const pending = foreshadowings.filter(
      (f) =>
        f.status === 'pending' ||
        (f.status === 'planted' && f.expectedCollect === chapterNumber)
    )

    const lines: string[] = []
    lines.push(`小说《${project.name}》（题材：${project.genre ?? '未指定'}）`)
    if (main?.synopsis) lines.push(`总纲：${main.synopsis}`)
    if (detail?.plotSummary) lines.push(`第 ${chapterNumber} 章细纲：${detail.plotSummary}`)
    if (characters.length > 0) {
      lines.push(
        '主要人物：' +
          characters
            .map(
              (c) =>
                `${c.name}（${c.role ?? '角色'}）${c.personality ? '，' + c.personality : ''}`
            )
            .join('；')
      )
    }
    if (pending.length > 0) {
      lines.push('本章相关伏笔：' + pending.map((f) => f.content).join('；'))
    }
    if (prevSummary) lines.push(`前一章内容摘要：${prevSummary}`)
    lines.push(
      `请写第 ${chapterNumber} 章正文，约 2000 字，承接前文、推进剧情。直接输出正文，不要标题或解释。`
    )
    return lines.join('\n\n')
  }

  async generateChapterStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = await this.buildChapterPrompt(projectId, chapterNumber)
    return this.llm.generateStream(prompt, opts)
  }
}
