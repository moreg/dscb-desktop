import type { ProjectService } from './project-service'
import type { LlmService, GenerateOptions } from './llm-service'
import { OutlineRepository } from './outline-repository'
import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { ChapterService } from './chapter-service'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { ProseRepo } from './skill-format/prose-repo'
import { CharacterCardMdRepo } from './skill-format/character-card-md-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { StyleProfileRepository } from './style-profile-repository'
import { buildSystemPrompt, buildHumanizerPrompt } from './skill-prompts'
import { auditChapter as runAudit, type AuditOptions } from './chapter-audit'
import { WriteFlowService } from './write-flow-service'
import { MemoryWriter } from './memory-writer'
import { FigureHtmlRepo } from './skill-format/figure-html-repo'
import { parseForeshadowReceipt, isForeshadowMatch } from '../../shared/parsers'
import type {
  AuditReport,
  BatchProgress,
  ChapterFlowResult,
  Character,
  ChapterDetail,
  FigureDraft,
  Foreshadowing,
  MemoryExtraction,
  MemoryApplyResult,
  OutlineDiffReport,
  PrevEndingState,
  RhythmApplyResult,
  RhythmEntry,
  RhythmEvaluation,
  StyleProfile
} from '../../shared/types'
import {
  parseFigureDraftJson,
  parseMemoryExtractionJson,
  parseOutlineDiffJson,
  parseRhythmEvaluationJson
} from '../../shared/parsers'
import { composeWritingRequirements } from '../../shared/writing-requirement-templates'

export interface ChapterPrompt {
  system: string
  user: string
}

/**
 * 上一章正文尾部取用字符数。
 * 平衡上下文需求与 token 成本：太少无法衔接，太多浪费 token。
 */
const PREV_TAIL_CHARS = 1500

/**
 * 每章目标字数。
 * 基于典型网文节奏设定，约 2500 字/章。
 */
const TARGET_WORDS = 2500

export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly flow: WriteFlowService = new WriteFlowService(llm),
    private readonly chapterService: ChapterService = new ChapterService(projectService)
  ) {}

  async buildChapterPrompt(
    projectId: string,
    chapterNumber: number,
    styleProfileId?: string | null,
    tempContext?: string
  ): Promise<ChapterPrompt> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)
    const style = await this.loadStyleProfile(
      dir,
      styleProfileId ?? project.defaultStyleProfileId ?? null
    )

    const ctx = await this.loadChapterContext(dir, chapterNumber)

    const system = buildSystemPrompt(project.genre, style)
    const user = renderUserPrompt({
      projectName: project.name,
      genre: project.genre,
      mainSynopsis: ctx.mainSynopsis,
      chapterDetail: ctx.detail,
      prevDetail: ctx.prevDetail,
      prevTail: ctx.prevTail,
      prevEndingState: ctx.prevEndingState,
      rhythmEntry: ctx.rhythmEntry,
      foreshadowings: ctx.foreshadowings,
      characters: ctx.characters,
      chapterNumber,
      tempContext
    })

    return { system, user }
  }

  async generateChapterStream(
    projectId: string,
    chapterNumber: number,
    styleProfileIdOrOpts?: string | null | GenerateOptions,
    maybeOpts: GenerateOptions = {}
  ): Promise<string> {
    const { styleProfileId, opts } = normalizeStyleGenerateArgs(styleProfileIdOrOpts, maybeOpts)
    const prompt = await this.buildChapterPrompt(projectId, chapterNumber, styleProfileId, opts.tempContext)
    return this.llm.generateStream(prompt.user, {
      ...opts,
      systemPrompt: prompt.system,
      meta: { feature: 'chapter', projectId, chapterNumber }
    })
  }

  /**
   * 续写质检。
   * 接受文本（而非章号）——这样既能 audit 还未保存的流式 draft，
   * 也能 audit 已保存正文（由调用方先 getChapter 取 content）。
   * 纯函数转发，主进程层不持有状态。
   * 题材（genre）由调用方提供，缺省时按 urban 兜底。
   */
  async auditChapter(
    projectId: string,
    content: string,
    opts?: AuditOptions
  ): Promise<AuditReport> {
    let genre = opts?.genre
    if (genre === undefined) {
      try {
        const project = await this.projectService.getProjectData(projectId)
        genre = project.genre
      } catch (err) {
        console.warn('[auditChapter] Failed to get project genre, falling back to urban:', err)
        // skip：fallback to urban
      }
    }
    return runAudit(content, { ...opts, genre })
  }

  /**
   * AI 改写命中段：把质检命中的原文片段（带上下文）发给 LLM，
   * 让它按 humanizer 技能改写，返回结构化 { rewritten, reason }。
   * 失败兜底返回空对象。
   */
  async humanizeSegment(
    projectId: string,
    snippet: string,
    violationType: string,
    chapterNumber?: number
  ): Promise<{ rewritten: string; reason: string }> {
    if (!snippet.trim()) return { rewritten: '', reason: '原文片段为空' }
    let genre: string | undefined
    try {
      const project = await this.projectService.getProjectData(projectId)
      genre = project.genre
    } catch (err) {
      console.warn('[humanizeSegment] Failed to get project genre:', err)
      // skip
    }
    const system = buildHumanizerPrompt(genre, violationType, snippet)
    const user = '请按 system 中的规则改写上面那段话。直接输出【改写后】+【改动说明】。'
    try {
      const raw = await this.llm.generateStream(user, {
        systemPrompt: system,
        meta: { feature: 'humanize', projectId, chapterNumber }
      })
      return parseHumanizerOutput(raw)
    } catch (err) {
      return { rewritten: '', reason: `LLM 调用失败：${(err as Error).message}` }
    }
  }

  /**
   * 细纲对照：转发到 WriteFlowService。
   * 若 outline 为空，则自动加载本章细纲文本。
   */
  async checkOutlineStream(
    projectId: string,
    chapterNumber: number,
    outline: string,
    content: string,
    opts: GenerateOptions = {}
  ): Promise<string> {
    let outlineText = outline
    if (!outlineText) {
      try {
        const dir = await this.projectService.resolveDir(projectId)
        const all = await new DetailedOutlineMdRepo(dir).listAll()
        const d = all.find((x) => x.chapterNumber === chapterNumber)
        if (d) {
          const lines: string[] = []
          if (d.title) lines.push(`标题：${d.title}`)
          if (d.plotSummary) lines.push(`核心事件：${d.plotSummary}`)
          if (d.coolPoint) lines.push(`爽点：${d.coolPoint}`)
          if (d.hook) lines.push(`钩子：${d.hook}`)
          if (d.charactersAppearing?.length) lines.push(`角色出场：${d.charactersAppearing.join('、')}`)
          if (d.foreshadowings?.length) lines.push(`伏笔铺设：${d.foreshadowings.join('；')}`)
          outlineText = lines.join('\n')
        }
      } catch {
        // skip
      }
    }
    return this.flow.checkOutlineStream(outlineText, content, chapterNumber, opts)
  }

  /**
   * 记忆提取：转发到 WriteFlowService。
   * 自动加载本章正文 + 已知人物名列表（避免重复提取既有角色）。
   */
  async extractMemoryStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    // 取正文：优先 md 仓储，回退 ChapterRepository
    let content = ''
    try {
      const md = await new ProseRepo(dir).read(chapterNumber)
      if (md) content = md
    } catch (err) {
      console.warn('[extractMemoryStream] Failed to read prose markdown:', err)
      // skip
    }
    if (!content) {
      try {
        const chapter = await this.chapterService.getChapter(projectId, chapterNumber)
        if (chapter.content) content = chapter.content
      } catch (err) {
        console.warn('[extractMemoryStream] Failed to read chapter from repository:', err)
        // skip
      }
    }
    // 取已知人物名
    let knownCharacters: string[] = []
    try {
      const list = await new CharacterCardMdRepo(dir).list()
      if (list.length > 0) knownCharacters = list.map((c) => c.name)
    } catch (err) {
      console.warn('[extractMemoryStream] Failed to list character cards:', err)
      // skip
    }
    if (knownCharacters.length === 0) {
      try {
        knownCharacters = (await new CharacterRepository(dir).list()).map((c) => c.name)
      } catch (err) {
        console.warn('[extractMemoryStream] Failed to list characters from repository:', err)
        // skip
      }
    }
    return this.flow.extractMemoryStream(content, chapterNumber, knownCharacters, opts)
  }

  /**
   * 记忆应用：混合策略。
   * - 自动应用：状态变化 + 情节追加 + 伏笔回收
   * - 新增内容（角色/地点/伏笔）：由 UI 调 applyNewCharacters/Locations/Foreshadowings
   */
  async applyMemory(
    projectId: string,
    extraction: MemoryExtraction
  ): Promise<MemoryApplyResult> {
    const dir = await this.projectService.resolveDir(projectId)
    const writer = new MemoryWriter(dir)
    return writer.applyAutomatic(extraction)
  }

  /** 用户确认后：应用新增角色 */
  async applyNewCharacters(
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).applyNewCharacters(chars)
  }

  /** 用户确认后：应用新增地点 */
  async applyNewLocations(
    projectId: string,
    locs: MemoryExtraction['newLocations']
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).applyNewLocations(locs)
  }

  /** 用户确认后：应用新增伏笔 */
  async applyNewForeshadowings(
    projectId: string,
    fs: MemoryExtraction['newForeshadowings']
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).applyNewForeshadowings(fs)
  }

  /**
   * 应用伏笔回执：把 LLM 在正文末尾写下的【本章伏笔回执】同步到伏笔库。
   * - planted：先去伏笔库里找匹配（content 包含 / 被包含），找不到则新建 pending
   * - collected：按内容匹配现有 planted 伏笔，标记为 collected
   * - 返回实际变更条数，便于 UI 反馈
   */
  async applyForeshadowReceipt(
    projectId: string,
    chapterNumber: number,
    receipt: { planted?: string[]; collected?: string[] }
  ): Promise<{ planted: number; collected: number; skipped: string[] }> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new ForeshadowingMdRepo(dir)
    const result = { planted: 0, collected: 0, skipped: [] as string[] }

    let list = await repo.list()

    // 1. 处理回收：用严格匹配规则（长度比 + 包含关系），调用 collect()
    for (const text of receipt.collected ?? []) {
      const t = text.trim()
      if (!t) continue
      const found = list.find(
        (x) => x.status === 'planted' && isForeshadowMatch(x.content, t)
      )
      if (!found) {
        result.skipped.push(`回收未匹配：${t}`)
        continue
      }
      try {
        await repo.collect(found.id, chapterNumber)
        result.collected++
        list = await repo.list()
      } catch (e) {
        result.skipped.push(`回收失败：${t} (${(e as Error).message})`)
      }
    }

    // 2. 处理埋设：先尝试匹配已有 pending 伏笔（更新 plantChapter），找不到则新建
    for (const text of receipt.planted ?? []) {
      const t = text.trim()
      if (!t) continue
      const found = list.find(
        (x) => x.status === 'pending' && isForeshadowMatch(x.content, t)
      )
      try {
        if (found) {
          await repo.plant(found.id, chapterNumber)
        } else {
          await repo.create({ content: t, expectedCollect: undefined, note: undefined })
        }
        result.planted++
        list = await repo.list()
      } catch (e) {
        result.skipped.push(`埋设失败：${t} (${(e as Error).message})`)
      }
    }

    return result
  }

  /**
   * 节奏评估：转发到 WriteFlowService。
   * 自动加载本章正文 + 节奏图谱中的预期情绪值。
   * 返回 LLM 原始输出（JSON 字符串），由 renderer 解析。
   */
  async evaluateRhythmStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    // 取正文
    let content = ''
    try {
      const md = await new ProseRepo(dir).read(chapterNumber)
      if (md) content = md
    } catch (err) {
      console.warn('[extractMemoryStream] Failed to read prose markdown:', err)
      // skip
    }
    if (!content) {
      try {
        const chapter = await this.chapterService.getChapter(projectId, chapterNumber)
        if (chapter.content) content = chapter.content
      } catch (err) {
        console.warn('[extractMemoryStream] Failed to read chapter from repository:', err)
        // skip
      }
    }
    // 取预期情绪值
    let expectedEmotion = 5
    try {
      const rhythm = await new RhythmHtmlRepo(dir).read()
      const entry = rhythm?.find((r) => r.chapter === chapterNumber)
      if (entry) expectedEmotion = entry.emotion
    } catch (err) {
      console.warn('[evaluateRhythmStream] Failed to read rhythm data, using default:', err)
      // skip：用默认值 5
    }
    return this.flow.evaluateRhythmStream(content, chapterNumber, expectedEmotion, opts)
  }

  /**
   * 节奏回填：把评估的实际情绪值写回节奏图谱.html。
   * 调用方应先检查 evaluation.autoApply；若 false，需用户确认后再调用。
   */
  async applyRhythmEvaluation(
    projectId: string,
    evaluation: RhythmEvaluation
  ): Promise<RhythmApplyResult> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new RhythmHtmlRepo(dir)
    const result = await repo.updateEmotion(evaluation.chapterNumber, evaluation.actualEmotion)
    if (!result) {
      return {
        applied: false,
        previousEmotion: evaluation.expectedEmotion,
        newEmotion: evaluation.expectedEmotion,
        actualized: false
      }
    }
    return {
      applied: true,
      previousEmotion: result.previousEmotion,
      newEmotion: result.newEmotion,
      actualized: true
    }
  }

  /**
   * 图解生成：转发到 WriteFlowService。
   * 自动加载本章正文。
   */
  async generateFigureStream(
    projectId: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    let content = ''
    try {
      const md = await new ProseRepo(dir).read(chapterNumber)
      if (md) content = md
    } catch (err) {
      console.warn('[extractMemoryStream] Failed to read prose markdown:', err)
      // skip
    }
    if (!content) {
      try {
        const chapter = await this.chapterService.getChapter(projectId, chapterNumber)
        if (chapter.content) content = chapter.content
      } catch (err) {
        console.warn('[extractMemoryStream] Failed to read chapter from repository:', err)
        // skip
      }
    }
    return this.flow.generateFigureStream(content, chapterNumber, opts)
  }

  /** 保存图解 HTML 到 图解/ 目录 */
  async saveFigure(projectId: string, fileName: string, html: string): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const repo = new FigureHtmlRepo(dir)
    return repo.write(fileName, html)
  }

  /**
   * 单章完整流程：生成 → 质检 → 细纲对照 → 记忆提取 → 节奏评估 → 图解生成。
   * 不保存正文（由调用方决定）；不自动应用记忆/节奏（由 UI 决定）。
   * onProgress 用于推送当前步骤，UI 可显示进度。
   *
   * 重要：步骤 3-6 直接调用 this.flow.* 并显式传入内存中的 content，
   * 绕过 WriteService 包装方法的磁盘重载逻辑（此时正文尚未落盘）。
   */
  async runFullFlowForChapter(
    projectId: string,
    chapterNumber: number,
    onProgress: (step: string, detail?: string) => void,
    opts: GenerateOptions = {}
  ): Promise<ChapterFlowResult> {
    const dir = await this.projectService.resolveDir(projectId)

    // 1. 生成正文（流式 token 由 opts.onToken 推送）
    onProgress('generating')
    const content = await this.generateChapterStream(projectId, chapterNumber, opts)

    // 2. 质检
    onProgress('audit')
    const audit = await this.auditChapter(projectId, content)

    // 预加载步骤 3-6 所需的支撑数据（只读磁盘一次）
    let outlineText = ''
    let knownCharacters: string[] = []
    let expectedEmotion = 5
    try {
      const all = await new DetailedOutlineMdRepo(dir).listAll()
      const d = all.find((x) => x.chapterNumber === chapterNumber)
      if (d) {
        const lines: string[] = []
        if (d.title) lines.push(`标题：${d.title}`)
        if (d.plotSummary) lines.push(`核心事件：${d.plotSummary}`)
        if (d.coolPoint) lines.push(`爽点：${d.coolPoint}`)
        if (d.hook) lines.push(`钩子：${d.hook}`)
        if (d.charactersAppearing?.length)
          lines.push(`角色出场：${d.charactersAppearing.join('、')}`)
        if (d.foreshadowings?.length)
          lines.push(`伏笔铺设：${d.foreshadowings.join('；')}`)
        outlineText = lines.join('\n')
      }
    } catch {
      // skip：无细纲
    }
    try {
      const list = await new CharacterCardMdRepo(dir).list()
      if (list.length > 0) knownCharacters = list.map((c) => c.name)
      else knownCharacters = (await new CharacterRepository(dir).list()).map((c) => c.name)
    } catch (err) {
      console.warn('[runFullFlowForChapter] Failed to load characters:', err)
      // skip
    }
    try {
      const rhythm = await new RhythmHtmlRepo(dir).read()
      const entry = rhythm?.find((r) => r.chapter === chapterNumber)
      if (entry) expectedEmotion = entry.emotion
    } catch (err) {
      console.warn('[runFullFlowForChapter] Failed to read rhythm data, using default:', err)
      // skip：用默认值 5
    }

    // 3. 细纲对照（直接传 content，不经过磁盘重载）
    onProgress('outlineCheck')
    let outlineDiff: OutlineDiffReport = {
      chapterNumber,
      diffs: [],
      passed: true
    }
    if (outlineText) {
      try {
        const outlineRaw = await this.flow.checkOutlineStream(
          outlineText,
          content,
          chapterNumber,
          { meta: { feature: 'batchOutline', projectId } }
        )
        outlineDiff = parseOutlineDiffJson(outlineRaw, chapterNumber)
      } catch (err) {
        console.warn('[runFullFlowForChapter] Failed to check outline:', err)
        // skip：用空报告
      }
    }

    // 4. 记忆提取（直接传 content）
    onProgress('memoryExtract')
    let memory: MemoryExtraction = {
      chapterNumber,
      newCharacters: [],
      newLocations: [],
      newForeshadowings: [],
      newPlotPoints: [],
      characterStateChanges: [],
      collectedForeshadowings: []
    }
    try {
      const memRaw = await this.flow.extractMemoryStream(
        content,
        chapterNumber,
        knownCharacters,
        { meta: { feature: 'batchMemory', projectId } }
      )
      memory = parseMemoryExtractionJson(memRaw, chapterNumber)
    } catch (err) {
      console.warn('[runFullFlowForChapter] Failed to extract memory:', err)
      // skip
    }

    // 5. 节奏评估（直接传 content）
    onProgress('rhythmEval')
    let rhythm: RhythmEvaluation | null = null
    try {
      const rhythmRaw = await this.flow.evaluateRhythmStream(
        content,
        chapterNumber,
        expectedEmotion,
        { meta: { feature: 'batchRhythm', projectId } }
      )
      rhythm = parseRhythmEvaluationJson(rhythmRaw, chapterNumber, expectedEmotion)
    } catch (err) {
      console.warn('[runFullFlowForChapter] Failed to evaluate rhythm:', err)
      // skip：rhythm 保持 null
    }

    // 6. 图解生成（直接传 content）
    onProgress('figureGen')
    let figure: FigureDraft = {
      chapterNumber,
      shouldGenerate: false,
      type: '',
      topic: '',
      fileName: '',
      html: '',
      reason: '未执行'
    }
    try {
      const figRaw = await this.flow.generateFigureStream(content, chapterNumber, {
        meta: { feature: 'batchFigure', projectId }
      })
      figure = parseFigureDraftJson(figRaw, chapterNumber)
    } catch (err) {
      console.warn('[runFullFlowForChapter] Failed to generate figure:', err)
      // skip
    }

    onProgress('done')
    return { chapterNumber, content, audit, outlineDiff, memory, rhythm, figure }
  }

  /**
   * 批量续写：从 fromChapter 到 toChapter 逐章生成。
   * 每章完成后暂停（status='paused'），等用户确认后由 UI 调 resumeBatch 继续。
   * onChapterComplete 在每章完成时回调（用于推送结果到 UI）。
   */
  async generateChaptersBatch(
    projectId: string,
    fromChapter: number,
    toChapter: number,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    styleProfileIdOrOpts?: string | null | GenerateOptions,
    maybeOpts: GenerateOptions = {}
  ): Promise<BatchProgress> {
    const { styleProfileId, opts } = normalizeStyleGenerateArgs(styleProfileIdOrOpts, maybeOpts)
    const total = toChapter - fromChapter + 1
    const completed: number[] = []
    const dir = await this.projectService.resolveDir(projectId)
    const proseRepo = new ProseRepo(dir)

    for (let ch = fromChapter; ch <= toChapter; ch++) {
      try {
        const result = await this.runFullFlowForChapter(
          projectId,
          ch,
          () => {
            // progress 内部回调，批量场景不细推
          },
          {
            ...opts,
            styleProfileId
          } as GenerateOptions
        )
        // 保存正文
        await proseRepo.write(ch, result.content)
        completed.push(ch)
        onChapterComplete(ch, result)
        // 暂停等用户确认（除非已是最后一章）
        if (ch < toChapter) {
          return {
            total,
            current: ch - fromChapter + 1,
            currentChapter: ch,
            fromChapter,
            toChapter,
            status: 'paused',
            pauseReason: '等待用户确认后继续下一章',
            completed
          }
        }
      } catch (err) {
        return {
          total,
          current: ch - fromChapter + 1,
          currentChapter: ch,
          fromChapter,
          toChapter,
          status: 'failed',
          completed,
          error: (err as Error).message
        }
      }
    }
    return {
      total,
      current: total,
      currentChapter: toChapter,
      fromChapter,
      toChapter,
      status: 'completed',
      completed
    }
  }

  /**
   * 继续批量续写：从 fromChapter 的下一章开始，到 toChapter。
   * 用于用户确认 paused 状态后继续。
   */
  async resumeChaptersBatch(
    projectId: string,
    fromChapter: number,
    toChapter: number,
    onChapterComplete: (chapter: number, result: ChapterFlowResult) => void,
    styleProfileIdOrOpts?: string | null | GenerateOptions,
    maybeOpts: GenerateOptions = {}
  ): Promise<BatchProgress> {
    const { styleProfileId, opts } = normalizeStyleGenerateArgs(styleProfileIdOrOpts, maybeOpts)
    return this.generateChaptersBatch(
      projectId,
      fromChapter + 1,
      toChapter,
      onChapterComplete,
      styleProfileId,
      opts
    )
  }

  async buildReviewPrompt(
    projectId: string,
    chapterNumber: number,
    contentOverride?: string
  ): Promise<string> {
    const content =
      contentOverride !== undefined
        ? contentOverride
        : (await this.chapterService.getChapter(projectId, chapterNumber)).content
    const trimmed = content.length > 8000 ? content.slice(0, 8000) + '\n\n…（后文已省略）' : content
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
    contentOverride?: string,
    opts: GenerateOptions = {}
  ): Promise<string> {
    const prompt = await this.buildReviewPrompt(projectId, chapterNumber, contentOverride)
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
    const chapter = await this.chapterService.getChapter(projectId, chapterNumber)
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
    const chapterMetas = await this.chapterService.listChapters(projectId)
    // 取最近 5 章非空正文片段作为依据
    const recent = [...chapterMetas]
      .filter((c) => c.wordCount > 0)
      .slice(-5)
    const excerpts: string[] = []
    for (const c of recent) {
      const ch = await this.chapterService.getChapter(projectId, c.chapterNumber)
      excerpts.push(`【第 ${c.chapterNumber} 章】${ch.content.slice(0, 600)}`)
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

  private async loadStyleProfile(
    projectDir: string,
    styleProfileId: string | null
  ): Promise<StyleProfile | null> {
    if (!styleProfileId) return null
    const data = await new StyleProfileRepository(projectDir).read()
    return data.items.find((item) => item.id === styleProfileId) ?? null
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
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load detailed outline from md:', err)
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
            climax: item.climax,
            writingRequirements: composeWritingRequirements(
              item.writingRequirementTemplateId,
              item.writingRequirementCustomText,
              item.writingRequirements
            ),
            writingRequirementTemplateId: item.writingRequirementTemplateId,
            writingRequirementCustomText: item.writingRequirementCustomText
          }
        }
      } catch (err) {
        console.warn('[loadChapterContext] Failed to load detailed outline from repository:', err)
        // detail stays undefined
      }
    }

    // 节奏图谱
    let rhythmEntry: RhythmEntry | undefined
    try {
      const rhythm = await new RhythmHtmlRepo(dir).read()
      rhythmEntry = rhythm?.find((r) => r.chapter === chapterNumber)
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load rhythm data:', err)
      // skip
    }

    // 总纲 synopsis（保留旧 OutlineRepository）
    let mainSynopsis = ''
    try {
      const main = await new OutlineRepository(dir).readMain()
      mainSynopsis = main?.synopsis ?? ''
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load main outline synopsis:', err)
      // skip
    }

    // 上一章正文末尾：使用新数据源 ProseRepo；写第 1 章时 chapterNumber-1=0，没有上一章，直接跳过
    let prevTail = ''
    if (chapterNumber > 1) {
      try {
        const md = await new ProseRepo(dir).read(chapterNumber - 1)
        if (md) prevTail = tail(md, PREV_TAIL_CHARS)
      } catch (err) {
        console.warn('[loadChapterContext] Failed to load previous chapter prose:', err)
        // skip
      }
    }

    // 角色卡：先 md，回退 JSON
    let characters: Character[] = []
    try {
      const list = await new CharacterCardMdRepo(dir).list()
      if (list.length > 0) characters = list
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load character cards:', err)
      // skip
    }
    if (characters.length === 0) {
      try {
        characters = await new CharacterRepository(dir).list()
      } catch (err) {
        console.warn('[loadChapterContext] Failed to load characters from repository:', err)
        // skip
      }
    }

    // 伏笔：先 md，回退 JSON
    let foreshadowings: Foreshadowing[] = []
    try {
      const list = await new ForeshadowingMdRepo(dir).list()
      if (list.length > 0) foreshadowings = list
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load foreshadowing cards:', err)
      // skip
    }
    if (foreshadowings.length === 0) {
      try {
        foreshadowings = await new ForeshadowingRepository(dir).list()
      } catch (err) {
        console.warn('[loadChapterContext] Failed to load foreshadowings from repository:', err)
        // skip
      }
    }

    // 上一章结尾状态结构化提取（Phase 12 Task 1）
    let prevEndingState: PrevEndingState | undefined
    if (prevTail) {
      try {
        prevEndingState = await this.flow.extractEndingState(prevTail, chapterNumber - 1)
      } catch (err) {
        console.warn('[loadChapterContext] Failed to extract ending state:', err)
        // skip：用原文尾段兜底
      }
    }

    return {
      mainSynopsis,
      detail,
      prevDetail,
      prevTail,
      prevEndingState,
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
  prevEndingState?: PrevEndingState
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
  prevEndingState?: PrevEndingState
  rhythmEntry?: RhythmEntry
  foreshadowings: Foreshadowing[]
  characters: Character[]
  chapterNumber: number
  tempContext?: string
}

function normalizeStyleGenerateArgs(
  styleProfileIdOrOpts?: string | null | GenerateOptions,
  maybeOpts: GenerateOptions = {}
): { styleProfileId: string | null; opts: GenerateOptions } {
  if (
    styleProfileIdOrOpts &&
    typeof styleProfileIdOrOpts === 'object' &&
    !Array.isArray(styleProfileIdOrOpts)
  ) {
    const styleOpts = styleProfileIdOrOpts as GenerateOptions & { styleProfileId?: string | null }
    return { styleProfileId: styleOpts.styleProfileId ?? null, opts: styleOpts }
  }
  return { styleProfileId: (styleProfileIdOrOpts as string | null | undefined) ?? null, opts: maybeOpts }
}

function renderUserPrompt(input: RenderInput): string {
  const parts: string[] = []
  const chapterRequirements = input.chapterDetail?.writingRequirements?.trim()

  // 1. 基本信息
  parts.push(
    `小说《${input.projectName}》（题材：${input.genre ?? '未指定'}）`
  )
  if (input.mainSynopsis) parts.push(`总纲：${input.mainSynopsis}`)

  // 2. 本章细纲
  parts.push('---')
  parts.push(`# 第 ${input.chapterNumber} 章 写作任务`)
  if (input.tempContext) {
    parts.push(`**【本章临时写作要求（临时上下文）】**：\n${input.tempContext}`)
  }
  if (chapterRequirements) {
    parts.push('**【本章硬性写作要求】**')
    parts.push('以下要求必须全部落实到正文里，不能遗漏、弱化或写偏：')
    parts.push(renderRequirementChecklist(chapterRequirements))
  }
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

  // 4.1 上一章结尾状态结构化提取（Phase 12 Task 1）
  if (
    input.prevEndingState &&
    (input.prevEndingState.characterPositions.length > 0 ||
      input.prevEndingState.suspense ||
      input.prevEndingState.unfinished.length > 0)
  ) {
    parts.push('---')
    parts.push(`# 上一章结尾状态（结构化提取，本章开头必须对接）`)
    const s = input.prevEndingState
    if (s.characterPositions.length > 0) {
      parts.push('**人物位置**：')
      for (const p of s.characterPositions) parts.push(`- ${p.name}：在${p.location}，${p.action}`)
    }
    if (s.characterStates.length > 0) {
      parts.push('**人物状态**：')
      for (const c of s.characterStates)
        parts.push(`- ${c.name}：${c.emotion}，${c.body}，持有${c.items}`)
    }
    if (s.timePoint) parts.push(`**时间点**：${s.timePoint}`)
    if (s.unfinished.length > 0) {
      parts.push('**未完成事项**（本章必须处理）：')
      for (const u of s.unfinished) parts.push(`- ${u}`)
    }
    if (s.suspense) parts.push(`**章末悬念**（本章必须回应）：${s.suspense}`)
    if (s.props.length > 0) parts.push(`**关键道具**：${s.props.join('、')}`)
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
      parts.push(`**【硬性约束 · 本章必须回收的伏笔（${dueNow.length} 条）】**`)
      parts.push('必须在正文中给出明确回收：')
      parts.push('- 对话揭示（角色主动说出）或物品出场 / 场景重现 / 角色回忆 / 旁白点破均可')
      parts.push('- 若主线剧情实在无法回收，也必须在章末用一句"对话"或"事件"明确点破伏笔内容')
      parts.push('禁止把必须回收的伏笔继续留到下一章。')
      for (const f of dueNow) parts.push(`- ${f.content}`)
    }
    if (pending.length > 0) {
      parts.push('**【软约束 · 建议本章铺垫的伏笔】**')
      parts.push('如本章剧情合适，请顺势埋下 1-2 条（不要堆砌，避免生硬）：')
      for (const f of pending.slice(0, 8)) parts.push(`- ${f.content}`)
    }
    const otherPlanted = planted.filter((f) => !dueNow.includes(f))
    if (otherPlanted.length > 0) {
      parts.push('**【硬性约束 · 已埋设但未到本章回收的伏笔】**')
      parts.push('必须避免在本章意外暴露、提前回收或矛盾：')
      for (const f of otherPlanted.slice(0, 8))
        parts.push(`- ${f.content}（埋设于第 ${f.plantChapter ?? '?'} 章，预计第 ${f.expectedCollect ?? '?'} 章回收）`)
    }
  }

  // 7. 输出最终指令 + 伏笔回执格式
  parts.push('---')
  parts.push('# 现在请写第 ' + input.chapterNumber + ' 章正文')
  parts.push(
    `约 ${TARGET_WORDS} 字，按本章细纲剧情点顺序展开，章末必须以"对话"或"事件"结尾。直接输出正文，不要标题、不要解释。`
  )
  if (chapterRequirements) {
    parts.push(`下笔前先自检一次：正文是否已经逐条落实上面的【本章硬性写作要求】。如果没有，先补足再输出。`)
  }
  // 7.1 写完后的自检回执（仅自用，会被前端自动剥离，不会出现在正文中）
  parts.push('---')
  parts.push('**【写完后自检 · 伏笔回执（仅自用，会被自动剥离，不会出现在正文中）】**')
  parts.push('正文写完后，另起一段写一行 JSON 回执（**绝对不要把这行混进正文叙述**）：')
  parts.push('【本章伏笔回执】{"planted":["伏笔原文1","伏笔原文2"],"collected":["伏笔原文3"]}')
  parts.push('要求：')
  parts.push('- planted：你本章新埋下的伏笔（填入伏笔的原文内容，不要改写；如无可不写）')
  parts.push('- collected：你本章回收的伏笔（填入伏笔的原文内容，不要改写；如无可不写）')
  parts.push('若本章无任何伏笔变动，整行可省略。')
  return parts.join('\n\n')
}

function renderRequirementChecklist(text: string): string {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (normalized.length === 0) return '- 无'

  return normalized
    .map((line) => {
      const cleaned = line.replace(/^[\-\*\d\.\)\s、]+/, '').trim()
      return `- ${cleaned || line}`
    })
    .join('\n')
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
  if (d.writingRequirements) lines.push(`- 本章写作要求：${d.writingRequirements}`)
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

/**
 * 解析 LLM 返回的 humanizer 输出。
 * 格式：先【改写后】+ 段落，再【改动说明】+ 列表。
 * 容错：没标签时整段作为 rewritten。
 */
export function parseHumanizerOutput(raw: string): { rewritten: string; reason: string } {
  const empty: { rewritten: string; reason: string } = { rewritten: '', reason: '' }
  if (!raw.trim()) return empty
  // 1. 截取【改写后】到【改动说明】之间的内容
  const reRewrite = /【改写后】\s*([\s\S]*?)(?=【改动说明】|$)/
  const reReason = /【改动说明】\s*([\s\S]*?)$/
  const m1 = raw.match(reRewrite)
  const m2 = raw.match(reReason)
  let rewritten = m1 ? m1[1].trim() : ''
  let reason = m2 ? m2[1].trim() : ''
  // 2. 去掉前后的 markdown 围栏
  rewritten = rewritten.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  // 3. 容错：完全没标签时整段作为 rewritten
  if (!rewritten && !reason) {
    rewritten = raw.trim()
    reason = '（LLM 未按预期格式输出，已取整段）'
  }
  // 4. 兜底：reason 为空时给默认说明
  if (rewritten && !reason) reason = '（未提供改动说明）'
  return { rewritten, reason }
}

