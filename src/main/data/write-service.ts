import type { ProjectService } from './project-service'
import type { LlmService, GenerateOptions } from './llm-service'
import { OutlineRepository } from './outline-repository'
import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { ChapterRepository } from './chapter-repository'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { ProseRepo } from './skill-format/prose-repo'
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { buildSystemPrompt } from './skill-prompts'
import type {
  Character,
  ChapterDetail,
  Foreshadowing,
  RhythmEntry
} from '../../shared/types'

export interface ChapterPrompt {
  system: string
  user: string
}

const PREV_TAIL_CHARS = 1500
const TARGET_WORDS = 2500

export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService
  ) {}

  async buildChapterPrompt(projectId: string, chapterNumber: number): Promise<ChapterPrompt> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)

    const ctx = await this.loadChapterContext(dir, chapterNumber)

    const system = buildSystemPrompt(project.genre)
    const user = renderUserPrompt({
      projectName: project.name,
      genre: project.genre,
      mainSynopsis: ctx.mainSynopsis,
      chapterDetail: ctx.detail,
      prevDetail: ctx.prevDetail,
      prevTail: ctx.prevTail,
      rhythmEntry: ctx.rhythmEntry,
      foreshadowings: ctx.foreshadowings,
      characters: ctx.characters,
      chapterNumber
    })

    return { system, user }
  }

  async generateChapterStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = await this.buildChapterPrompt(projectId, chapterNumber)
    return this.llm.generateStream(prompt.user, {
      ...opts,
      systemPrompt: prompt.system,
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

  /**
   * 加载续写所需的全部上下文。
   * 优先读 skill-format md 仓储（细纲/节奏图谱/角色卡/伏笔/正文），
   * 失败回退到旧 JSON 仓储（outlines/、chapters/、memory/）。
   */
  private async loadChapterContext(
    dir: string,
    chapterNumber: number
  ): Promise<ChapterContext> {
    // 本章细纲：优先 md，回退 JSON
    let detail: ChapterDetail | undefined
    let prevDetail: ChapterDetail | undefined
    try {
      const all = await new DetailedOutlineMdRepo(dir).listAll()
      detail = all.find((d) => d.chapterNumber === chapterNumber)
      prevDetail = all.find((d) => d.chapterNumber === chapterNumber - 1)
    } catch {
      // fall through to JSON fallback
    }
    if (!detail) {
      try {
        const items = await new OutlineRepository(dir).listDetailed()
        const item = items.find((d) => d.chapterNumber === chapterNumber)
        if (item) {
          detail = {
            chapterNumber,
            title: '',
            plotSummary: item.plotSummary,
            coolPoint: item.coolPoint,
            charactersAppearing: item.charactersAppearing,
            foreshadowings: item.foreshadowings,
            hook: item.hook,
            wordEstimate: item.wordEstimate,
            goldenLine: item.goldenLine,
            volume: item.volume,
            emotion: item.emotion,
            climax: item.climax
          }
        }
      } catch {
        // detail stays undefined
      }
    }

    // 节奏图谱
    let rhythmEntry: RhythmEntry | undefined
    try {
      const rhythm = await new RhythmHtmlRepo(dir).read()
      rhythmEntry = rhythm?.find((r) => r.chapter === chapterNumber)
    } catch {
      // skip
    }

    // 总纲 synopsis（保留旧 OutlineRepository）
    let mainSynopsis = ''
    try {
      const main = await new OutlineRepository(dir).readMain()
      mainSynopsis = main?.synopsis ?? ''
    } catch {
      // skip
    }

    // 上一章正文末尾：先尝试 md 仓储 ProseRepo，回退 ChapterRepository
    let prevTail = ''
    try {
      const md = await new ProseRepo(dir).read(chapterNumber - 1)
      if (md) prevTail = tail(md, PREV_TAIL_CHARS)
    } catch {
      // skip
    }
    if (!prevTail) {
      try {
        const chapterRepo = new ChapterRepository(dir)
        const prev = await chapterRepo.get(chapterNumber - 1)
        if (prev.content) prevTail = tail(prev.content, PREV_TAIL_CHARS)
      } catch {
        // skip
      }
    }

    // 角色卡：先 md，回退 JSON
    let characters: Character[] = []
    try {
      const list = await new CharacterCardMdRepo(dir).list()
      if (list.length > 0) characters = list
    } catch {
      // skip
    }
    if (characters.length === 0) {
      try {
        characters = await new CharacterRepository(dir).list()
      } catch {
        // skip
      }
    }

    // 伏笔：先 md，回退 JSON
    let foreshadowings: Foreshadowing[] = []
    try {
      const list = await new ForeshadowingMdRepo(dir).list()
      if (list.length > 0) foreshadowings = list
    } catch {
      // skip
    }
    if (foreshadowings.length === 0) {
      try {
        foreshadowings = await new ForeshadowingRepository(dir).list()
      } catch {
        // skip
      }
    }

    return {
      mainSynopsis,
      detail,
      prevDetail,
      prevTail,
      rhythmEntry,
      foreshadowings,
      characters
    }
  }
}

interface ChapterContext {
  mainSynopsis: string
  detail?: ChapterDetail
  prevDetail?: ChapterDetail
  prevTail: string
  rhythmEntry?: RhythmEntry
  foreshadowings: Foreshadowing[]
  characters: Character[]
}

/** 取尾部 n 字符（按字符数，不按字节） */
function tail(s: string, n: number): string {
  if (s.length <= n) return s
  return '……（前文略）\n' + s.slice(-n)
}

interface RenderInput {
  projectName: string
  genre?: string
  mainSynopsis: string
  chapterDetail?: ChapterDetail
  prevDetail?: ChapterDetail
  prevTail: string
  rhythmEntry?: RhythmEntry
  foreshadowings: Foreshadowing[]
  characters: Character[]
  chapterNumber: number
}

function renderUserPrompt(input: RenderInput): string {
  const parts: string[] = []

  // 1. 基本信息
  parts.push(
    `小说《${input.projectName}》（题材：${input.genre ?? '未指定'}）`
  )
  if (input.mainSynopsis) parts.push(`总纲：${input.mainSynopsis}`)

  // 2. 本章细纲
  parts.push('---')
  parts.push(`# 第 ${input.chapterNumber} 章 写作任务`)
  if (input.chapterDetail) {
    parts.push(renderChapterDetail(input.chapterDetail, '本章细纲'))
  } else {
    parts.push('（本章无细纲，可参考总纲自由发挥，但仍须遵循三铁律精神：不写下一章剧情。）')
  }

  // 3. 节奏标注（若 rhythm 数据更准确则覆盖细纲）
  if (input.rhythmEntry) {
    const lines: string[] = []
    lines.push(`**节奏图谱对齐**：`)
    lines.push(`- 章节标题：${input.rhythmEntry.title}`)
    lines.push(`- 情绪值目标：${input.rhythmEntry.emotion}（1-10）`)
    lines.push(
      `- 爽点类型：${input.rhythmEntry.climax}（0=无 1=小打脸 2=中打脸 3=大高潮 3.5=卷中决战 4=卷终决战）`
    )
    if (input.rhythmEntry.volume) lines.push(`- 所属卷：第 ${input.rhythmEntry.volume} 卷`)
    parts.push(lines.join('\n'))
  }

  // 4. 上一章细纲 + 正文末尾（衔接原料）
  if (input.prevDetail || input.prevTail) {
    parts.push('---')
    parts.push(`# 第 ${input.chapterNumber - 1} 章 衔接原料`)
    if (input.prevDetail) {
      parts.push(renderChapterDetail(input.prevDetail, '上一章细纲'))
    }
    if (input.prevTail) {
      parts.push('**上一章正文结尾**（用于衔接检查，本章开头必须对接此处状态）：')
      parts.push('```')
      parts.push(input.prevTail)
      parts.push('```')
    }
  }

  // 5. 角色卡
  if (input.characters.length > 0) {
    parts.push('---')
    parts.push('# 角色信息')
    const appearing = (input.chapterDetail?.charactersAppearing ?? []) as string[]
    const appearSet = new Set(appearing.map((n) => normalizeName(n)))
    const appearingList = input.characters.filter((c) => appearSet.has(normalizeName(c.name)))
    const otherList = input.characters.filter((c) => !appearSet.has(normalizeName(c.name)))
    if (appearingList.length > 0) {
      parts.push('**本章出场角色**（完整人设）：')
      for (const c of appearingList) parts.push(renderCharacterDetail(c))
    }
    if (otherList.length > 0) {
      parts.push('**其他已知角色**（参考用，本章不应擅自登场）：')
      parts.push(otherList.map((c) => `- ${c.name}（${c.role ?? '角色'}）`).join('\n'))
    }
  }

  // 6. 伏笔
  if (input.foreshadowings.length > 0) {
    parts.push('---')
    parts.push('# 伏笔追踪')
    const planted = input.foreshadowings.filter((f) => f.status === 'planted')
    const pending = input.foreshadowings.filter((f) => f.status === 'pending')
    const dueNow = planted.filter((f) => f.expectedCollect === input.chapterNumber)
    if (dueNow.length > 0) {
      parts.push('**本章预计回收的伏笔**（必须自然回收）：')
      for (const f of dueNow) parts.push(`- ${f.content}`)
    }
    if (pending.length > 0) {
      parts.push('**等待埋设的伏笔**（如剧情合适可顺势埋下）：')
      for (const f of pending.slice(0, 8)) parts.push(`- ${f.content}`)
    }
    const otherPlanted = planted.filter((f) => !dueNow.includes(f))
    if (otherPlanted.length > 0) {
      parts.push('**已埋设未回收的伏笔**（避免在本章意外暴露或矛盾）：')
      for (const f of otherPlanted.slice(0, 8))
        parts.push(`- ${f.content}（埋设于第 ${f.plantChapter ?? '?'} 章）`)
    }
  }

  // 7. 输出最终指令
  parts.push('---')
  parts.push('# 现在请写第 ' + input.chapterNumber + ' 章正文')
  parts.push(
    `约 ${TARGET_WORDS} 字，按本章细纲剧情点顺序展开，章末必须以"对话"或"事件"结尾。直接输出正文，不要标题、不要解释。`
  )
  return parts.join('\n\n')
}

function renderChapterDetail(d: ChapterDetail, label: string): string {
  const lines: string[] = []
  lines.push(`**${label}**：`)
  if (d.title) lines.push(`- 章节标题：${d.title}`)
  if (d.plotSummary) lines.push(`- 核心事件：${d.plotSummary}`)
  if (d.coolPoint) lines.push(`- 爽点/打脸：${d.coolPoint}`)
  if (d.hook) lines.push(`- 章末钩子：${d.hook}`)
  if (d.goldenLine) lines.push(`- 金句：${d.goldenLine}`)
  if (d.foreshadowings?.length) lines.push(`- 伏笔铺设：${d.foreshadowings.join('；')}`)
  if (d.charactersAppearing?.length)
    lines.push(`- 角色出场：${d.charactersAppearing.join('、')}`)
  if (d.wordEstimate) lines.push(`- 字数预估：${d.wordEstimate}`)
  if (d.climaxTag) lines.push(`- 关键标记：${d.climaxTag}`)
  return lines.join('\n')
}

function renderCharacterDetail(c: Character): string {
  const lines: string[] = []
  lines.push(`### ${c.name}（${c.role ?? '角色'}）`)
  if (c.identity) lines.push(`- 身份：${c.identity}`)
  if (c.personality) lines.push(`- 性格：${c.personality}`)
  if (c.abilities) lines.push(`- 能力：${c.abilities}`)
  if (c.synopsis) lines.push(`- 简介：${c.synopsis}`)
  if (c.rawFields) {
    const skipKeys = new Set(['身份', '性格', '能力', '简介', '姓名', '角色', '类型'])
    for (const [k, v] of Object.entries(c.rawFields)) {
      if (skipKeys.has(k)) continue
      const text = Array.isArray(v) ? v.join('；') : v
      if (text) lines.push(`- ${k}：${text}`)
    }
  }
  return lines.join('\n')
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, '')
}
