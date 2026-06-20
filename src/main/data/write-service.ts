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
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'chapter', projectId }
    })
  }

  async buildReviewPrompt(projectId: string, chapterNumber: number): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const chapterRepo = new ChapterRepository(dir)
    const chapter = await chapterRepo.get(chapterNumber)
    const trimmed = chapter.content.length > 8000
      ? chapter.content.slice(0, 8000) + '\n\n…（后文已省略）'
      : chapter.content
    return [
      `请审阅下面的小说章节正文，针对性地给出 3-5 条具体修改建议。`,
      `要求：每条建议用「原文片段 → 建议 → 理由」三段格式；`,
      `若问题不明显，可少给；不要客套话，不要重写整段。`,
      `直接输出建议，不要标题或前言。`,
      ``,
      `------ 第 ${chapterNumber} 章 正文 ------`,
      trimmed
    ].join('\n')
  }

  async reviewChapterStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = await this.buildReviewPrompt(projectId, chapterNumber)
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'review', projectId }
    })
  }

  /**
   * 识别本章出场人物：返回 JSON 数组，每项 { name, reason, quote? }
   * name 是人物原文中的称呼（可能不是人物库中的规范名）
   */
  async detectCastStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const chapterRepo = new ChapterRepository(dir)
    const chapter = await chapterRepo.get(chapterNumber)
    const characters = await new CharacterRepository(dir).list()
    const known = characters.map((c) => `${c.name}（${c.role ?? ''}）`).join('、')
    const trimmed = chapter.content.length > 6000
      ? chapter.content.slice(0, 6000) + '\n…（后文已省略）'
      : chapter.content
    const prompt = [
      `请识别下面的小说章节正文中所有出场人物，并给出他们在本章做的事情。`,
      ``,
      `已知人物库（可参考但不要局限于此；正文中出现的别名/称呼/外号都要识别）：${known || '（空）'}`,
      ``,
      `输出要求：`,
      `- 严格 JSON 数组，每个元素 { "name": 字符串, "reason": 一句话说明他/她在章中做了什么, "quote": 关键原文 1 句（≤ 30 字，可选） }`,
      `- 不要任何解释、标题、Markdown 代码块。`,
      `- 若某人物只被提及未出场，可不列入。`,
      ``,
      `------ 第 ${chapterNumber} 章 正文 ------`,
      trimmed
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'cast', projectId }
    })
  }

  /**
   * 扫描已写章节，建议人物之间的关系。
   * 返回 JSON 数组：[{ characterA, characterB, relationType, description, strength }]
   * characterA/B 为人物名。
   */
  async detectRelationshipsStream(
    projectId: string,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const characters = await new CharacterRepository(dir).list()
    const chapterRepo = new ChapterRepository(dir)
    const chapters = await chapterRepo.list()
    // 取最近 5 章非空正文片段作为依据
    const recent = [...chapters]
      .filter((c) => c.wordCount > 0)
      .slice(-5)
    const excerpts: string[] = []
    for (const c of recent) {
      const content = await chapterRepo.get(c.chapterNumber)
      excerpts.push(`【第 ${c.chapterNumber} 章】${content.content.slice(0, 600)}`)
    }
    const known = characters.map((c) => c.name).join('、')
    const prompt = [
      `请根据下面的小说章节内容，判断已知人物之间两两存在什么关系。`,
      ``,
      `已知人物：${known || '（空）'}`,
      ``,
      `输出要求：`,
      `- 严格 JSON 数组，每个元素 { "characterA": 人物名, "characterB": 人物名, "relationType": 关系类型（如师徒/恋人/敌对/兄弟/同门）, "description": 一句话说明依据, "strength": 0-100 的整数 }`,
      `- 只输出有明确依据的关系，宁缺毋滥，最多 10 条。`,
      `- 不要任何解释、标题、Markdown 代码块。`,
      ``,
      `------ 近期章节节选 ------`,
      excerpts.join('\n\n') || '（暂无正文）'
    ].join('\n')
    return this.llm.generateStream(prompt, {
      ...opts,
      meta: { feature: 'relationship', projectId }
    })
  }
}
