import { join, dirname } from 'path'
import { promises as fs } from 'fs'
import type { ProjectService } from './project-service'
import type { LlmService, GenerateOptions } from './llm-service'
import { OutlineRepository } from './outline-repository'
import { CharacterRepository } from './character-repository'
import { ForeshadowingRepository } from './foreshadowing-repository'
import { ChapterService } from './chapter-service'
import { DetailedOutlineMdRepo } from './skill-format/detailed-outline-md-repo'
import { RhythmHtmlRepo } from './skill-format/rhythm-html-repo'
import { ProseRepo } from './skill-format/prose-repo'
import { CharacterRepo } from './memory/character-repo'
import { ForeshadowingMdRepo } from './skill-format/foreshadowing-md-repo'
import { StyleProfileRepository } from './style-profile-repository'
import { buildSystemPrompt, buildHumanizerPrompt } from './skill-prompts'
import { recallBenchmark, mergeRecalls } from './teardown/benchmark-recall'
import type { SettingsRepository } from './settings-repository'
import { auditChapter as runAudit, type AuditOptions } from './chapter-audit'
import { buildReviewReport } from './review-report-builder'
import { WriteFlowService } from './write-flow-service'
import { ReviewFlowService } from './review-flow-service'
import { MemoryWriter } from './memory-writer'
import { SettingsWriter, patchesFromWorldLocations } from './settings-writer'
import { FigureHtmlRepo } from './skill-format/figure-html-repo'
import { OutlineMdRepo } from './skill-format/outline-md-repo'
import { TrackingMdRepo, type TrackingContext } from './skill-format/tracking-md-repo'
import { SettingsMdRepo, type SettingsContext } from './skill-format/settings-md-repo'
import { readText, parseDoc } from './skill-format/md-parser'
import { parseForeshadowReceipt, isForeshadowMatch } from '../../shared/parsers'
import { DeslopService } from './deslop/deslop-service'
import type {
  AuditReport,
  AuditViolation,
  BatchProgress,
  ChapterFlowResult,
  ChapterReviewReport,
  SettingsEvolutionEntry,
  Character,
  ChapterDetail,
  FigureDraft,
  Foreshadowing,
  MemoryExtraction,
  MemoryApplyPreview,
  MemoryApplyResult,
  SettingsApplyPreview,
  SettingsApplyResult,
  SettingsEvolutionMode,
  SettingsPatch,
  OutlineDiffReport,
  PrevEndingState,
  ReviewCheckId,
  ReviewRulesConfig,
  CustomReviewCheck,
  RhythmApplyResult,
  RhythmEntry,
  RhythmEvaluation,
  StyleProfile,
  VolumeOutline
} from '../../shared/types'
import {
  parseFigureDraftJson,
  parseMemoryExtractionJson,
  parseOutlineDiffJson,
  parseRhythmEvaluationJson
} from '../../shared/parsers'
import { composeWritingRequirements } from '../../shared/writing-requirement-templates'
import {
  assertNovelProse,
  isEarlyAgentNarration,
  LLM_AGENT_META_ERROR
} from './agent-meta-detect'

export interface ChapterPrompt {
  system: string
  user: string
  /** 本章目标字数（来自细纲「字数预估」，解析失败兜底 TARGET_WORDS）。供调用方反算 maxTokens。 */
  targetWords?: number
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

/**
 * 字数预估的兜底下限/上限，防止用户在细纲里填出极端值（如 0 或 50000）。
 */
const MIN_TARGET_WORDS = 800
const MAX_TARGET_WORDS = 8000

/**
 * 时间线注入 prompt 的最大字符数。
 * 平衡上下文完整性与 token 预算：全书时间线可能很长，截断防止 prompt 膨胀。
 * 2000 字符约 1200 token，足够覆盖民国类项目的时间轴要点。
 */
const TIMELINE_MAX_CHARS = 2000

/**
 * 从细纲「字数预估」文本解析出整数目标字数。
 * 容忍多种写法：「约 2500 字」「2500-3000」「2500~3000」「不少于3000」。
 * 解析失败或无细纲时返回 undefined，由调用方决定兜底值。
 */
function parseWordEstimate(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  // 取第一个出现的数字区间，取其上限（"2500-3000" → 3000，"约 2500" → 2500）
  const range = raw.match(/(\d{3,5})\s*[-~到]\s*(\d{3,5})/)
  if (range) {
    const high = Number(range[2])
    if (Number.isFinite(high)) return clampTargetWords(high)
  }
  const single = raw.match(/(\d{3,5})/)
  if (single) {
    const n = Number(single[1])
    if (Number.isFinite(n)) return clampTargetWords(n)
  }
  return undefined
}

function clampTargetWords(n: number): number {
  return Math.min(MAX_TARGET_WORDS, Math.max(MIN_TARGET_WORDS, n))
}

/**
 * 按目标字数反算生成 token 上限，留出约 30% 余量。
 * 中文 1 字 ≈ 1.7 token（取 1.5~2 的中位偏高，避免临界截断）。
 * 最低不低于 DEFAULT_MAX_TOKENS，保证小目标章节也不被误伤。
 */
function tokensForWords(words: number): number {
  const needed = Math.ceil(words * 1.7 * 1.3)
  return Math.max(needed, 8192)
}

export class WriteService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly llm: LlmService,
    private readonly flow: WriteFlowService = new WriteFlowService(llm),
    private readonly reviewFlow: ReviewFlowService = new ReviewFlowService(llm),
    private readonly chapterService: ChapterService = new ChapterService(projectService),
    private readonly settings?: SettingsRepository,
    private readonly benchmarkResolver?: import('./teardown/benchmark-resolver').BenchmarkResolver,
    /** 去 AI 味服务（供 humanizeSegment 走 deslop pipeline）；缺省时按旧路径降级 */
    private readonly deslopService?: DeslopService
  ) {}

  async buildChapterPrompt(
    projectId: string,
    chapterNumber: number,
    styleProfileId?: string | null,
    tempContext?: string,
    existingText?: string
  ): Promise<{ system: string; user: string; targetWords: number }> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)
    const style = await this.loadStyleProfile(
      dir,
      styleProfileId ?? project.defaultStyleProfileId ?? null
    )

    const ctx = await this.loadChapterContext(dir, chapterNumber)

    const overrides = this.settings
      ? (await this.settings.get()).chapterRuleOverrides ?? {}
      : {}

    // 对标书方法论召回（oh-story-claudecode 闭环：拆文产物 → 写作召回）
    const benchmarkRecall = await this.loadBenchmarkRecall(dir, project.benchmarkBooks)

    const system = buildSystemPrompt(project.genre, style, overrides, benchmarkRecall)
    
    let targetWords = parseWordEstimate(ctx.detail?.wordEstimate) ?? TARGET_WORDS
    if (existingText && existingText.trim()) {
      const existingWordCount = existingText.trim().length
      // Calculate remaining words to write, ensuring a minimum of 500 words for continuation
      targetWords = Math.max(500, targetWords - existingWordCount)
    }

    const user = renderUserPrompt({
      projectName: project.name,
      genre: project.genre,
      mainSynopsis: ctx.mainSynopsis,
      volumeOutline: ctx.volumeOutline,
      settings: ctx.settings,
      settingsEvolution: ctx.settingsEvolution,
      chapterDetail: ctx.detail,
      prevDetail: ctx.prevDetail,
      prevTail: ctx.prevTail,
      prevEndingState: ctx.prevEndingState,
      rhythmEntry: ctx.rhythmEntry,
      foreshadowings: ctx.foreshadowings,
      characters: ctx.characters,
      tracking: ctx.tracking,
      chapterNumber,
      targetWords,
      tempContext,
      existingText
    })

    return { system, user, targetWords }
  }

  async generateChapterStream(
    projectId: string,
    chapterNumber: number,
    styleProfileIdOrOpts?: string | null | GenerateOptions,
    maybeOpts: GenerateOptions = {}
  ): Promise<string> {
    const { styleProfileId, opts } = normalizeStyleGenerateArgs(styleProfileIdOrOpts, maybeOpts)
    const prompt = await this.buildChapterPrompt(
      projectId,
      chapterNumber,
      styleProfileId,
      opts.tempContext,
      opts.existingText
    )
    const targetWords = prompt.targetWords ?? TARGET_WORDS
    const full = await this.generateProseStream(prompt.user, {
      ...opts,
      systemPrompt: prompt.system,
      maxTokens: opts.maxTokens ?? tokensForWords(targetWords),
      meta: { feature: 'chapter', projectId, chapterNumber }
    })
    return full
  }

  /**
   * 构造「按用户追问调整已生成正文」的 prompt。
   *
   * 优先级语义：用户追问要求（instruction）为最高优先级，覆盖细纲、人物、伏笔、长期写作要求等既有约束；
   * 冲突时以用户要求为准。user prompt 的渲染细节见 renderAdjustUserPrompt。
   */
  async buildAdjustChapterPrompt(
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    styleProfileId?: string | null
  ): Promise<{ system: string; user: string }> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)
    const style = await this.loadStyleProfile(
      dir,
      styleProfileId ?? project.defaultStyleProfileId ?? null
    )
    const ctx = await this.loadChapterContext(dir, chapterNumber)
    const overrides = this.settings
      ? (await this.settings.get()).chapterRuleOverrides ?? {}
      : {}
    const benchmarkRecall = await this.loadBenchmarkRecall(dir, project.benchmarkBooks)
    const system = buildSystemPrompt(project.genre, style, overrides, benchmarkRecall)
    const user = renderAdjustUserPrompt({
      projectName: project.name,
      genre: project.genre,
      chapterNumber,
      instruction,
      content,
      chapterRequirements: ctx.detail?.writingRequirements?.trim(),
      chapterDetail: ctx.detail,
      prevTail: ctx.prevTail,
      characters: ctx.characters,
      foreshadowings: ctx.foreshadowings
    })

    return { system, user }
  }

  async adjustChapterStream(
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    styleProfileIdOrOpts?: string | null | GenerateOptions,
    maybeOpts: GenerateOptions = {}
  ): Promise<string> {
    const { styleProfileId, opts } = normalizeStyleGenerateArgs(styleProfileIdOrOpts, maybeOpts)
    const prompt = await this.buildAdjustChapterPrompt(
      projectId,
      chapterNumber,
      content,
      instruction,
      styleProfileId
    )
    const full = await this.generateProseStream(prompt.user, {
      ...opts,
      systemPrompt: prompt.system,
      maxTokens:
        opts.maxTokens ?? tokensForWords(Math.min(MAX_TARGET_WORDS, Math.max(TARGET_WORDS, content.length))),
      meta: { feature: 'chapter-adjust', projectId, chapterNumber }
    })
    return full
  }

  /**
   * 正文类生成：流式早拦旁白 + 结束后 assertNovelProse。
   * 命中旁白时 abort 子进程并抛 LLM_AGENT_META，避免把流程说明刷满编辑器。
   */
  private async generateProseStream(
    userPrompt: string,
    opts: GenerateOptions
  ): Promise<string> {
    const controller = new AbortController()
    const onUserAbort = (): void => {
      if (!controller.signal.aborted) controller.abort()
    }
    if (opts.signal) {
      if (opts.signal.aborted) onUserAbort()
      else opts.signal.addEventListener('abort', onUserAbort, { once: true })
    }

    let accumulated = ''
    let metaHit = false
    const userOnToken = opts.onToken

    try {
      const full = await this.llm.generateStream(userPrompt, {
        ...opts,
        signal: controller.signal,
        onToken: (token) => {
          if (metaHit) return
          accumulated += token
          if (isEarlyAgentNarration(accumulated)) {
            metaHit = true
            // 不把旁白 token 继续喂给 UI；已喂出的由前端失败回滚清掉
            if (!controller.signal.aborted) controller.abort()
            return
          }
          userOnToken?.(token)
        }
      })
      if (metaHit) throw new Error(LLM_AGENT_META_ERROR)
      assertNovelProse(full)
      return full
    } catch (err) {
      if (metaHit) throw new Error(LLM_AGENT_META_ERROR)
      // abort 可能被映射成 LLM_ABORTED；若因旁白触发则统一成 META
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'LLM_ABORTED' && isEarlyAgentNarration(accumulated)) {
        throw new Error(LLM_AGENT_META_ERROR)
      }
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onUserAbort)
    }
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
    // M2：从设置读审稿规则（开关/阈值/词表），透传给检测引擎。
    // 读失败（旧 settings.json 无此字段）兜底为 undefined → 引擎用默认值且不跑新增检查。
    let reviewRules = opts?.reviewRules
    if (!reviewRules && this.settings) {
      try {
        reviewRules = await this.settings.getReviewRules()
      } catch (err) {
        console.warn('[auditChapter] Failed to read reviewRules, skipping review checks:', err)
      }
    }
    return runAudit(content, { ...opts, genre, reviewRules })
  }

  /**
   * 生成结构化审核报告（对齐「正文审核」技能第 6 步）。
   * 聚合 auditChapter 的算法检查 + runDeepReview 的 LLM 检查为 10 节报告。
   */
  async generateReviewReport(
    projectId: string,
    content: string,
    chapterNumber: number
  ): Promise<ChapterReviewReport> {
    // 1. 算法检查
    const audit = await this.auditChapter(projectId, content)

    // 2. 获取审稿规则（步骤 4 提前，复用避免重复读取）
    let reviewRules: ReviewRulesConfig | null = null
    try {
      reviewRules = this.settings ? await this.settings.getReviewRules() : null
    } catch (err) {
      console.warn('[generateReviewReport] Failed to load review rules:', err)
    }

    // 3. LLM 深度检查（如果启用）
    let llmViolations: AuditViolation[] = []
    try {
      if (reviewRules?.enabled && reviewRules.autoDeepReview) {
        llmViolations = await this.runDeepReview(projectId, content, chapterNumber)
      }
    } catch (err) {
      console.warn('[generateReviewReport] LLM deep review failed, skipping:', err)
    }

    // 4. 获取题材
    let genre: string | undefined
    try {
      const project = await this.projectService.getProjectData(projectId)
      genre = project.genre
    } catch (err) {
      console.warn('[generateReviewReport] Failed to load project genre:', err)
    }

    // 5. 构建报告
    return buildReviewReport(chapterNumber, audit, llmViolations, {
      genre,
      reviewRules: reviewRules ?? undefined
    })
  }

  /**
   * LLM 深度审稿（M3）：跑角色崩坏/逻辑漏洞等语义检查项。
   * 启用项由 settings.reviewRules.checks 决定（llm 类 checkId）；为空 = 全部 llm 项都跑。
   * 失败兜底为空数组，永不 reject。角色卡/细纲从磁盘读取（用于语义对照）。
   */
  async runDeepReview(
    projectId: string,
    content: string,
    chapterNumber: number,
    opts: GenerateOptions = {}
  ): Promise<AuditViolation[]> {
    let genre: string | undefined
    let enabledChecks: ReviewCheckId[] | undefined
    let characterCards = ''
    let outline = ''
    let customLlmChecks: CustomReviewCheck[] | undefined
    const dir = await this.projectService.resolveDir(projectId).catch(() => null)

    try {
      genre = (await this.projectService.getProjectData(projectId)).genre
    } catch (err) {
      console.warn('[runDeepReview] Failed to get project genre:', err)
    }
    // 启用项：只跑 settings 里未关闭的 LLM 类检查
    if (this.settings) {
      try {
        const rules = await this.settings.getReviewRules()
        if (rules.enabled) {
          enabledChecks = (
            [
              'character_breakdown',
              'logic_hole',
              'low_iq_plot',
              'emotion_cliff',
              'hook_grade',
              'style_match',
              'cool_point',
              'quote_contradiction'
            ] as ReviewCheckId[]
          ).filter((c) => rules.checks[c] !== false)
          // 自定义 LLM 项：只取 enabled 且开关未关的
          customLlmChecks = (rules.customChecks ?? []).filter(
            (c) => c.type === 'llm' && c.enabled && rules.checks[c.id] !== false
          )
        } else {
          // 审稿总开关关 → 不跑
          return []
        }
      } catch (err) {
        console.warn('[runDeepReview] Failed to read reviewRules:', err)
      }
    }
    // 预加载角色卡 / 细纲（用于语义对照）
    if (dir) {
      try {
        const cards = await new CharacterRepo(dir).list()
        if (cards.length > 0) {
          characterCards = cards
            .map((c) => `- ${c.name}${c.role ? `（${c.role}）` : ''}：${c.personality ?? ''}`.trim())
            .join('\n')
            .slice(0, 2000)
        }
      } catch {
        // skip
      }
      try {
        const all = await new DetailedOutlineMdRepo(dir).listAll()
        const d = all.find((x) => x.chapterNumber === chapterNumber)
        if (d) {
          const lines: string[] = []
          if (d.title) lines.push(`标题：${d.title}`)
          if (d.plotSummary) lines.push(`核心事件：${d.plotSummary}`)
          if (d.coolPoint) lines.push(`爽点：${d.coolPoint}`)
          if (d.hook) lines.push(`钩子：${d.hook}`)
          outline = lines.join('\n')
        }
      } catch {
        // skip
      }
    }

    return this.reviewFlow.runDeepReview(
      content,
      { chapterNumber, genre, enabledChecks, characterCards, outline, customLlmChecks },
      { ...opts, meta: { feature: 'deepReview', projectId, ...opts.meta } }
    )
  }

  /**
   * AI 改写命中段：把质检命中的原文片段发给去 AI 味 pipeline 改写，
   * 返回结构化 { rewritten, reason }。失败兜底返回空对象。
   *
   * 优先走 DeslopService.deslop（mild 级别，7 Gate 方法论），
   * 让单条改写与编辑器「去 AI 味」按钮行为一致。
   * deslopService 未注入时降级走旧 humanizer 路径（buildHumanizerPrompt）。
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
    }

    // 优先走 deslop pipeline（与编辑器「去 AI 味」按钮共用同一套 7 Gate 方法论）
    if (this.deslopService) {
      try {
        const styleContext = genre ? { genre } : undefined
        const result = await this.deslopService.deslop(snippet, {
          levelOverride: 'mild',
          styleContext,
          meta: { projectId, chapterNumber }
        })
        // deslop 扫描到了问题并改写了 -> 返回改写结果
        if (result.changeSummary.length > 0) {
          return { rewritten: result.rewritten, reason: result.changeSummary.join('；') }
        }
        // deslop 没扫描到问题（snippet 可能不含 deslop 检测器命中的词）
        // -> 降级走旧路径，用 violationType 驱动改写（质检说有问题但 deslop 扫描器没覆盖到）
      } catch (err) {
        return { rewritten: '', reason: `LLM 调用失败：${(err as Error).message}` }
      }
    }

    // 降级：旧 humanizer 路径（deslopService 未注入，或 deslop 未扫描到问题时）
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
    // 取正文：优先 ProseRepo，回退 ChapterService
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
      const list = await new CharacterRepo(dir).list()
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

  /**
   * 续写完成后自动同步记忆与设定。
   * extract → applyMemory（自动部分）→ applySettingsPatches(onlyAuto)。
   * autoMemorySync=false 时返回 null；失败只记 log/errors，不抛。
   */
  async syncChapterAfterWrite(
    projectId: string,
    chapterNumber: number,
    content: string,
    opts?: { skipIfDisabled?: boolean }
  ): Promise<{
    memory: MemoryApplyResult
    settings: SettingsApplyResult
    extraction: MemoryExtraction
  } | null> {
    const skipIfDisabled = opts?.skipIfDisabled !== false
    try {
      if (skipIfDisabled && !(await this.isAutoMemorySyncEnabled())) {
        return null
      }
    } catch (err) {
      console.warn('[syncChapterAfterWrite] Failed to read autoMemorySync:', err)
      // 读设置失败时仍尝试同步（默认开启）
    }

    const emptyMemory: MemoryApplyResult = {
      applied: {
        characters: 0,
        locations: 0,
        items: 0,
        foreshadowings: 0,
        plotPoints: 0,
        stateChanges: 0,
        collected: 0
      },
      errors: []
    }
    const emptySettings: SettingsApplyResult = {
      applied: 0,
      skipped: 0,
      errors: [],
      appliedDiffs: []
    }
    const emptyExtraction: MemoryExtraction = {
      chapterNumber,
      newCharacters: [],
      newLocations: [],
      newItems: [],
      newForeshadowings: [],
      newPlotPoints: [],
      characterStateChanges: [],
      collectedForeshadowings: [],
      settingsPatches: [],
      settingsSuggestions: []
    }

    if (!content?.trim()) {
      return {
        memory: { ...emptyMemory, errors: ['正文为空，跳过同步'] },
        settings: emptySettings,
        extraction: emptyExtraction
      }
    }

    try {
      const dir = await this.projectService.resolveDir(projectId)
      let knownCharacters: string[] = []
      try {
        const list = await new CharacterRepo(dir).list()
        if (list.length > 0) knownCharacters = list.map((c) => c.name)
      } catch (err) {
        console.warn('[syncChapterAfterWrite] Failed to list character cards:', err)
      }
      if (knownCharacters.length === 0) {
        try {
          knownCharacters = (await new CharacterRepository(dir).list()).map((c) => c.name)
        } catch (err) {
          console.warn('[syncChapterAfterWrite] Failed to list characters:', err)
        }
      }

      const memRaw = await this.flow.extractMemoryStream(
        content,
        chapterNumber,
        knownCharacters,
        { meta: { feature: 'autoMemorySync', projectId, chapterNumber } }
      )
      const extraction = parseMemoryExtractionJson(memRaw, chapterNumber)

      let memory = emptyMemory
      try {
        memory = await this.applyMemory(projectId, extraction)
      } catch (err) {
        const msg = (err as Error).message
        console.warn('[syncChapterAfterWrite] applyMemory failed:', err)
        memory = { ...emptyMemory, errors: [msg] }
      }

      let settings = emptySettings
      try {
        settings = await this.applySettingsPatches(projectId, extraction, {
          onlyAuto: true
        })
      } catch (err) {
        const msg = (err as Error).message
        console.warn('[syncChapterAfterWrite] applySettingsPatches failed:', err)
        settings = { ...emptySettings, errors: [msg] }
      }

      return { memory, settings, extraction }
    } catch (err) {
      const msg = (err as Error).message
      console.warn('[syncChapterAfterWrite] failed:', err)
      return {
        memory: { ...emptyMemory, errors: [msg] },
        settings: emptySettings,
        extraction: emptyExtraction
      }
    }
  }

  private async isAutoMemorySyncEnabled(): Promise<boolean> {
    if (!this.settings) return true
    try {
      const s = await this.settings.get()
      return s.autoMemorySync !== false
    } catch {
      return true
    }
  }

  /** 记忆自动部分应用前的 diff 预览 */
  async previewMemoryApply(
    projectId: string,
    extraction: MemoryExtraction
  ): Promise<MemoryApplyPreview> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).previewAutomatic(extraction)
  }

  /** 设定补丁预览 */
  async previewSettingsApply(
    projectId: string,
    extraction: MemoryExtraction
  ): Promise<SettingsApplyPreview> {
    const dir = await this.projectService.resolveDir(projectId)
    const patches = collectSettingsPatches(extraction)
    return new SettingsWriter(dir).preview(
      patches,
      extraction.settingsSuggestions ?? []
    )
  }

  /**
   * 应用设定补丁。
   * onlyAuto=true：仅 high 置信；false：应用全部可写补丁。
   */
  async applySettingsPatches(
    projectId: string,
    extraction: MemoryExtraction,
    opts: { onlyAuto?: boolean } = {}
  ): Promise<SettingsApplyResult> {
    const dir = await this.projectService.resolveDir(projectId)
    const mode = await this.getSettingsEvolutionMode()
    if (mode === 'off') {
      return { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }
    }
    // confirm_all：跳过提取后的自动路径（onlyAuto=true），仅用户点「应用设定补丁」时写入
    if (mode === 'confirm_all' && opts.onlyAuto === true) {
      return { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }
    }
    const patches = collectSettingsPatches(extraction)
    return new SettingsWriter(dir).applyPatches(extraction.chapterNumber, patches, {
      onlyAuto: opts.onlyAuto === true
    })
  }

  private async getSettingsEvolutionMode(): Promise<SettingsEvolutionMode> {
    if (!this.settings) return 'auto_high'
    try {
      const s = await this.settings.get()
      const m = s.settingsEvolution
      if (m === 'off' || m === 'confirm_all' || m === 'auto_high') return m
    } catch {
      /* default */
    }
    return 'auto_high'
  }

  /** 用户确认后：应用新增角色 */
  async applyNewCharacters(
    projectId: string,
    chars: MemoryExtraction['newCharacters']
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).applyNewCharacters(chars)
  }

  /** 用户确认后：应用新增地点；world 级在设定进化开启时双写地理（尊重 off 开关） */
  async applyNewLocations(
    projectId: string,
    locs: MemoryExtraction['newLocations'],
    chapterNumber = 0
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    const n = await new MemoryWriter(dir).applyNewLocations(locs)
    const geo = patchesFromWorldLocations(locs)
    if (geo.length > 0) {
      const mode = await this.getSettingsEvolutionMode()
      if (mode !== 'off') {
        await new SettingsWriter(dir).applyPatches(chapterNumber || 1, geo, {
          onlyAuto: false
        })
      }
    }
    return n
  }

  /** 用户确认后：应用新增道具 */
  async applyNewItems(
    projectId: string,
    items: MemoryExtraction['newItems']
  ): Promise<number> {
    const dir = await this.projectService.resolveDir(projectId)
    return new MemoryWriter(dir).applyNewItems(items)
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
      const list = await new CharacterRepo(dir).list()
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
      newItems: [],
      newForeshadowings: [],
      newPlotPoints: [],
      characterStateChanges: [],
      collectedForeshadowings: [],
      settingsPatches: [],
      settingsSuggestions: []
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

    // 4.5 自动落盘记忆与设定（与单章 syncChapterAfterWrite 一致；受 autoMemorySync 控制）
    if (await this.isAutoMemorySyncEnabled()) {
      onProgress('memoryApply')
      try {
        await this.applyMemory(projectId, memory)
      } catch (err) {
        console.warn('[runFullFlowForChapter] Failed to apply memory:', err)
      }
      onProgress('settingsApply')
      try {
        await this.applySettingsPatches(projectId, memory, { onlyAuto: true })
      } catch (err) {
        console.warn('[runFullFlowForChapter] Failed to apply settings patches:', err)
      }
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

    // 7. LLM 深度审稿（仅当 settings.autoDeepReview=true 时自动跑，省 token）
    // 默认关：用户在面板手动点「AI 深度审稿」按钮触发（见 runDeepReview IPC）。
    let deepReview: AuditViolation[] = []
    if (this.settings) {
      try {
        const rules = await this.settings.getReviewRules()
        if (rules.enabled && rules.autoDeepReview) {
          onProgress('deepReview')
          deepReview = await this.runDeepReview(projectId, content, chapterNumber, {
            meta: { feature: 'batchDeepReview', projectId }
          })
        }
      } catch (err) {
        console.warn('[runFullFlowForChapter] Failed to run deep review:', err)
        // skip
      }
    }

    onProgress('done')
    return { chapterNumber, content, audit, outlineDiff, memory, rhythm, figure, deepReview }
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
      `你是资深网文/小说编辑，请以专业编辑视角审阅下面这一章正文，找出影响阅读体验最关键的问题，并给出可以直接落地的修改建议。`,
      ``,
      `**优先排查的维度**（不必全覆盖，按本章短板挑最值得改的；最多 8 条，问题不明显时少于 5 条也行，宁可不写也不要凑数）：`,
      `1. **节奏与张力**：开篇是否有钩子；信息密度是否平均（动作/对白/描写/内心戏的占比是否失衡）；高潮前的铺垫是否到位；有没有该慢的地方一笔带过、该快的地方写拖了。`,
      `2. **人物塑造**：人物的反应/动作/语言是否符合其性格与处境；有没有"工具人式"的应声虫对白；情绪转折是否有支点，还是凭空跳跃；内心活动是否过载，挤掉了外部行动。`,
      `3. **场景与画面感**：感官细节（视/听/嗅/触/味）是否单一或缺失；环境描写是否服务于情绪，还是为写而写；动作描写是否清晰可视化，还是模糊的形容词堆砌。`,
      `4. **用词精准度**：动词是否有力（避免大量"是/有/变得/十分"等弱动词）；形容词/副词是否冗余；有没有套路化的"网文腔"（嘴角勾起、眼神一凛、轰然作响 等）；同义重复或啰嗦表达。`,
      `5. **对白质感**：对白是否推动情节或揭示性格，还是只在交换信息；语气是否符合人物身份；"说"字句和动作提示词是否单调。`,
      `6. **逻辑与连贯**：时间线、空间感、因果链有无跳跃或自相矛盾；人物动机是否成立；伏笔和回收是否自然。`,
      `7. **视角与文风一致性**：视角是否稳定（有无无意识的全知滑入）；叙述距离是否合适；风格是否前后统一。`,
      ``,
      `**输出格式**（每条严格按下面四行，标签不能省，条目之间空一行）：`,
      `原文：从正文里逐字摘录的原句（含标点空格，便于定位）`,
      `改写：可以直接替换"原文"的成品写法（必须是改后的成品文本本身）`,
      `理由：用 1-2 句指出问题属于上述哪个维度，并解释这样改为什么更好（要具体，不要泛泛而谈）`,
      ``,
      `**硬性要求**：`,
      `- "原文"必须与正文逐字一致（含标点空格），用于程序自动定位。`,
      `- "改写"必须是改后的成品本身，能整句替换"原文"，禁止写成"把…改成…/应该…/可以…/拆到…/不要…"这种说明性句式。`,
      `- 若问题属于结构调整、跨段落删改，无法用单句替换，则"改写"一行写"（此为结构调整，请参考理由手动改）"，并在"理由"里讲清结构怎么调。`,
      `- 单条建议聚焦一个问题，不要一条里塞两件事。"改写"应当明显优于"原文"（不是同义改写）。`,
      `- **"改写"成品必须自身去 AI 味**，禁止出现以下高频 AI 套路表达（你正在批评的词，自己改写时也不许用）：`,
      `  · 情态比喻：仿佛 / 犹如 / 宛若 / 如同 / 一丝 / 一抹 / 些许 / 几分`,
      `  · 程度副词堆叠：缓缓 / 微微 / 轻轻 / 淡淡 / 不禁 / 不由得`,
      `  · 表情套路：眼中闪过一丝X / 嘴角勾起一抹X / 眉头微皱 / 瞳孔微缩`,
      `  · 心理外露：心中涌起/一动 / 心头一震 / 心下暗道 / 深吸一口气`,
      `  · 句式套路："不是A，而是B" / "，带着一丝X" / "声音不大，却带着X的力量" / "他/她知道……"`,
      `  · 判断/升华：不容置疑 / 显而易见 / 这一刻，他终于明白 / 他不知道的是，更大的风暴即将来临`,
      `  替换思路：用具体动作、身体反应、可见细节、短句断句代替；与其写"她微微一笑，眼中闪过一丝失落"，不如写"她扯了下嘴角，没说话"。改写后若仍含上述表达，视为不合格。`,
      `- 不要客套话、不要总评/前言/标题、不要打分、不要 Markdown 标记。`,
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
   * 「追问」：基于本章正文 + 设定（细纲/人物/伏笔/上一章结尾）回答用户的写作疑问，
   * 不修改正文。支持多轮（history 累积），feature 复用 review 路由（分析类任务）。
   */
  async answerChapterQuestionStream(
    projectId: string,
    chapterNumber: number,
    content: string,
    question: string,
    history: { role: 'user' | 'assistant'; text: string }[] = [],
    opts: GenerateOptions = {}
  ): Promise<string> {
    const dir = await this.projectService.resolveDir(projectId)
    const project = await this.projectService.getProjectData(projectId)
    const ctx = await this.loadChapterContext(dir, chapterNumber)
    const style = await this.loadStyleProfile(
      dir,
      project.defaultStyleProfileId ?? null
    )
    const overrides = this.settings
      ? (await this.settings.get()).chapterRuleOverrides ?? {}
      : {}
    const benchmarkRecall = await this.loadBenchmarkRecall(dir, project.benchmarkBooks)
    const system = buildSystemPrompt(project.genre, style, overrides, benchmarkRecall)
    const user = renderAskQuestionPrompt({
      projectName: project.name,
      genre: project.genre,
      chapterNumber,
      content,
      question,
      history,
      chapterRequirements: ctx.detail?.writingRequirements?.trim(),
      chapterDetail: ctx.detail,
      prevTail: ctx.prevTail,
      characters: ctx.characters,
      foreshadowings: ctx.foreshadowings
    })
    return this.llm.generateStream(user, {
      ...opts,
      systemPrompt: system,
      maxTokens: 4096,
      meta: { feature: 'ask', projectId, chapterNumber }
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
    const globalStylesFile = this.settings
      ? join(dirname(this.settings.getSettingsFile()), 'styles.json')
      : join(projectDir, 'styles.json')
    const data = await new StyleProfileRepository(globalStylesFile).read()
    return data.items.find((item) => item.id === styleProfileId) ?? null
  }

  /**
   * 加载对标书方法论召回（oh-story-claudecode 闭环核心）。
   * 按回退链（项目 对标/ → 全局 拆文库/）解析对标书拆文产物，
   * 召回情绪模块/节奏/文风/写法技巧，注入 system prompt。
   * 无对标书或解析失败时返回 null（降级为无对标写作，不报错）。
   */
  private async loadBenchmarkRecall(
    projectDir: string,
    benchmarkBooks: string[] | undefined
  ): Promise<import('./skill-prompts').BenchmarkRecallPrompt | null> {
    if (!this.benchmarkResolver || !benchmarkBooks || benchmarkBooks.length === 0) {
      return null
    }
    try {
      const artifacts = await this.benchmarkResolver.resolveAll(projectDir, benchmarkBooks)
      if (artifacts.length === 0) return null
      const recalls = artifacts.map((a) => recallBenchmark(a))
      const merged = mergeRecalls(recalls)
      if (!merged.emotion && !merged.rhythm && !merged.style && !merged.technique) {
        return null
      }
      return {
        bookNames: merged.bookNames,
        emotion: merged.emotion,
        rhythm: merged.rhythm,
        style: merged.style,
        technique: merged.technique
      }
    } catch (err) {
      console.warn('[loadBenchmarkRecall] 召回失败，降级无对标写作:', err)
      return null
    }
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

    // 总纲 synopsis + 卷结构：优先 OutlineMdRepo（大纲/大纲.md），回退旧 OutlineRepository（outlines/main.json）
    let mainSynopsis = ''
    let volumeOutline: VolumeOutline | undefined
    try {
      const outlineRead = await new OutlineMdRepo(dir).read()
      if (outlineRead) {
        mainSynopsis = outlineRead.main.synopsis ?? ''
        // 找本章所属卷，加载卷纲文件
        const vol = outlineRead.volumes.find(
          (v) => chapterNumber >= v.chapterStart && chapterNumber <= v.chapterEnd
        )
        if (vol) volumeOutline = await this.loadVolumeOutline(dir, vol.number)
      }
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load outline from md:', err)
      // skip
    }
    // 大纲.md 的 synopsis 为空或「（待生成）」占位时，回退读 outlines/main.json（老项目兼容）
    if (!mainSynopsis || mainSynopsis === '（待生成）') {
      try {
        const main = await new OutlineRepository(dir).readMain()
        const fallback = main?.synopsis ?? ''
        if (fallback && fallback !== '（待生成）') mainSynopsis = fallback
      } catch (err) {
        console.warn('[loadChapterContext] Failed to load main outline synopsis:', err)
        // skip
      }
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
      const list = await new CharacterRepo(dir).list()
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

    // 追踪目录（角色状态/时间线/进度摘要/问题记录）
    let tracking: TrackingContext | null = null
    try {
      tracking = await new TrackingMdRepo(dir).read(chapterNumber)
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load tracking:', err)
      // skip
    }

    // 设定目录（题材定位/世界观/势力/规则）
    let settings: SettingsContext | null = null
    try {
      settings = await new SettingsMdRepo(dir).read()
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load settings:', err)
      // skip
    }

    // 近期设定演进（正文已揭晓补丁，优先于旧底稿冲突项）
    let settingsEvolution: SettingsEvolutionEntry[] = []
    try {
      settingsEvolution = await new SettingsWriter(dir).readRecentEvolution(5)
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load settings evolution:', err)
    }

    return {
      mainSynopsis,
      volumeOutline,
      settings,
      settingsEvolution,
      detail,
      prevDetail,
      prevTail,
      prevEndingState,
      rhythmEntry,
      foreshadowings,
      characters,
      tracking
    }
  }

  /**
   * 加载卷纲文件（大纲/第N卷_卷名.md），返回 H2 节列表。
   * 用于注入卷级情绪弧线、爽点节奏、伏笔规划等强约束素材。
   */
  private async loadVolumeOutline(dir: string, volumeNumber: number): Promise<VolumeOutline | undefined> {
    try {
      const outlineDir = join(dir, '大纲')
      const files = await fs.readdir(outlineDir)
      const target = files.find((f) => {
        const m = f.match(/^第(\d+)卷/)
        return m && parseInt(m[1], 10) === volumeNumber
      })
      if (!target) return undefined
      const text = await readText(join(outlineDir, target))
      if (!text) return undefined
      const doc = parseDoc(text)
      return {
        number: volumeNumber,
        name: target.replace(/^第\d+卷[_\s]*/, '').replace(/\.md$/, ''),
        h1Title: doc.h1Title,
        fileName: target,
        sections: doc.sections.map((s) => ({ title: s.title, body: s.body }))
      }
    } catch (err) {
      console.warn('[loadChapterContext] Failed to load volume outline:', err)
      return undefined
    }
  }
}

interface ChapterContext {
  mainSynopsis: string
  volumeOutline?: VolumeOutline
  settings: SettingsContext | null
  settingsEvolution: SettingsEvolutionEntry[]
  detail?: ChapterDetail
  prevDetail?: ChapterDetail
  prevTail: string
  prevEndingState?: PrevEndingState
  rhythmEntry?: RhythmEntry
  foreshadowings: Foreshadowing[]
  characters: Character[]
  tracking: TrackingContext | null
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
  volumeOutline?: VolumeOutline
  settings?: SettingsContext | null
  settingsEvolution?: SettingsEvolutionEntry[]
  chapterDetail?: ChapterDetail
  prevDetail?: ChapterDetail
  prevTail: string
  prevEndingState?: PrevEndingState
  rhythmEntry?: RhythmEntry
  foreshadowings: Foreshadowing[]
  characters: Character[]
  tracking?: TrackingContext | null
  chapterNumber: number
  /** 本章目标字数（用于强约束 LLM 写够）。 */
  targetWords: number
  tempContext?: string
  existingText?: string
}

interface AdjustRenderInput {
  projectName: string
  genre?: string
  chapterNumber: number
  /** 用户追问要求：最高优先级，覆盖细纲/人物/伏笔等既有约束。 */
  instruction: string
  /** 本章已生成的待调整正文。 */
  content: string
  chapterRequirements?: string
  chapterDetail?: ChapterDetail
  prevTail: string
  characters: Character[]
  foreshadowings: Foreshadowing[]
}

interface AskQuestionRenderInput {
  projectName: string
  genre?: string
  chapterNumber: number
  /** 本章当前正文（问答只读，不修改）。 */
  content: string
  /** 用户本轮提出的问题。 */
  question: string
  /** 多轮对话历史（不含本轮）。 */
  history: { role: 'user' | 'assistant'; text: string }[]
  chapterRequirements?: string
  chapterDetail?: ChapterDetail
  prevTail: string
  characters: Character[]
  foreshadowings: Foreshadowing[]
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

  // 1.1 项目设定（题材定位/世界观/势力/规则文档）
  if (input.settings) {
    parts.push(...renderSettingsSection(input.settings, input.characters))
  }
  // 1.1b 近期设定演进（正文已揭晓；与旧底稿冲突时以演进为准）
  if (input.settingsEvolution && input.settingsEvolution.length > 0) {
    parts.push('## 近期设定演进（以正文已揭晓为准，优先于旧底稿冲突项）')
    for (const e of input.settingsEvolution) {
      parts.push(`- ${e.chapter} · ${e.file}：${e.summary}`)
    }
  }

  // 1.2 卷级定位（卷核心/情绪弧线/爽点节奏/伏笔规划）
  if (input.volumeOutline) {
    parts.push(...renderVolumeSection(input.volumeOutline))
  }

  // 2. 本章细纲
  parts.push('---')
  parts.push(`# 第 ${input.chapterNumber} 章 写作任务`)
  if (input.tempContext) {
    parts.push(`**【本章临时写作要求（临时上下文）】**（最高优先级，覆盖本章细纲、硬性写作要求、节奏标注等一切既有约束；冲突时以此为准）：`)
    parts.push(input.tempContext)
    parts.push('（下笔时必须逐条落实上面的临时要求；输出前自检是否全部满足，遗漏则补齐再输出。）')
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

  // 5.1 角色状态追踪（当前实力/立场/目标 + 近期变更 + 进度摘要 + 待处理问题）
  if (input.tracking) {
    parts.push(...renderTrackingSection(input.tracking, input.chapterNumber))
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

  // 6.1 本章已写正文前部（用于续写衔接）
  if (input.existingText && input.existingText.trim()) {
    parts.push('---')
    parts.push('**【本章已写正文前部】**（这部分是你已经写出来的正文内容）：')
    parts.push('```')
    parts.push(input.existingText.trim())
    parts.push('```')
  }

  // 7. 输出最终指令 + 伏笔回执格式
  parts.push('---')
  parts.push('# 现在请写第 ' + input.chapterNumber + ' 章正文')
  if (input.existingText && input.existingText.trim()) {
    parts.push(
      `**请接续上面的【本章已写正文前部】继续续写本章后续正文，预计继续写不少于 ${input.targetWords} 字**（这是硬性下限）。请保持文风、人称视角（如第一人称或第三人称）、语气风格及叙事逻辑与前部完全一致，承接前文的情节向下发展，不要重复前部已有的内容或情节，直接输出后续正文内容，开头不需要任何问候或承接词。`
    )
  } else {
    parts.push(
      `**正文不少于 ${input.targetWords} 字**（这是硬性下限，不是"约"，写不够视为未完成）。按本章细纲剧情点顺序展开，每个剧情点都要充分展开，禁止为了凑数而流水账带过。章末必须以"对话"或"事件"结尾。直接输出正文，不要标题、不要解释、不要流程说明、不要提及任何技能名。`
    )
  }
  // 7.1 临时写作要求复述（最高优先级，紧贴输出指令强化注意力）
  if (input.tempContext) {
    parts.push(`**【再次强调 · 本章临时写作要求（最高优先级，必须逐条落实，覆盖细纲与硬性写作要求）】**：`)
    parts.push(input.tempContext)
    parts.push('若与本章细纲冲突，以本临时要求为准；写完后逐条自检是否已落实，遗漏则补齐。')
  }
  if (chapterRequirements) {
    parts.push(`下笔前先自检一次：正文是否已经逐条落实上面的【本章硬性写作要求】（在不违背临时写作要求的前提下）。如果没有，先补足再输出。`)
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

/**
 * 渲染「追问调整正文」的 user prompt。
 *
 * 优先级语义：用户追问要求为最高优先级，覆盖细纲、人物、伏笔、长期写作要求等一切既有约束；
 * 冲突时以用户要求为准。结构上把用户要求放在当前正文之后、紧贴输出指令，使其处于 LLM 注意力最靠后处。
 */
function renderAdjustUserPrompt(input: AdjustRenderInput): string {
  const trimmedContent =
    input.content.length > 30_000 ? input.content.slice(0, 30_000) + '\n\n（后文因长度限制省略）' : input.content
  const charactersSection =
    input.characters.length > 0
      ? `## 主要人物参考\n${input.characters
          .slice(0, 20)
          .map((c) => `- ${c.name}${c.role ? `：${c.role}` : ''}${c.personality ? `，${c.personality}` : ''}`)
          .join('\n')}`
      : ''
  const foreshadowingsSection =
    input.foreshadowings.length > 0
      ? `## 相关伏笔参考\n${input.foreshadowings
          .slice(0, 20)
          .map((f) => `- ${f.content}`)
          .join('\n')}`
      : ''

  return [
    `## 任务：按用户追问调整第 ${input.chapterNumber} 章已生成正文`,
    '',
    '你将收到一章已经生成好的小说正文，以及用户这次提出的修改要求。',
    '请直接输出调整后的完整正文，不要输出解释、标题、修改清单、Markdown 代码块或前后缀。',
    '',
    '## 优先级（务必严格遵守）',
    '1. **用户追问要求是最高优先级，覆盖一切既有约束。** 凡用户明确要求改的（剧情走向、人物行为、场景、写法、节奏、删减、增写等），必须改到位；若用户要求与细纲、人物卡、伏笔、长期写作要求冲突，以用户要求为准，并在调整后让正文自洽。',
    '2. 用户**没有**提及的部分尽量保持原貌（人物名、未被要求改的剧情节点、伏笔、关键线索不要无故变动），但若它们与用户要求直接冲突，无条件让位于用户要求。',
    '3. 输出必须是可直接替换编辑器当前正文的成品正文，篇幅与原正文相当，除非用户要求明确涉及增减篇幅。',
    '4. 不要把修改要求、分析过程、对照清单或免责声明写进正文。',
    '5. 避免引入新的 AI 味套话，保持动作、对话、细节和因果推进。',
    '',
    '## 执行方式',
    '- 先逐条拆解用户的追问要求，明确每一条要落到正文的哪个段落/情节。',
    '- 改写时逐一落实，不要遗漏任何一条；与原意冲突处，按用户要求重写而非折中。',
    '- 输出前自检：用户提出的每一条要求是否都已体现在正文中；若有遗漏，回头补齐再输出。',
    '',
    `## 小说信息`,
    `- 书名：${input.projectName}`,
    `- 题材：${input.genre ?? '未指定'}`,
    '',
    input.chapterRequirements
      ? `## 本章长期写作要求（仅作参考，被用户追问要求覆盖时以用户为准）\n${renderRequirementChecklist(input.chapterRequirements)}`
      : '',
    input.chapterDetail
      ? `## 本章细纲（仅作参考，被用户追问要求覆盖时以用户为准）\n${renderChapterDetail(input.chapterDetail, '本章细纲')}`
      : '',
    input.prevTail ? `## 上一章结尾参考\n${input.prevTail}` : '',
    charactersSection,
    foreshadowingsSection,
    '',
    `------ 第 ${input.chapterNumber} 章当前正文 ------`,
    trimmedContent,
    '',
    `## 用户追问要求（最高优先级，必须逐条落实到上方正文）`,
    input.instruction.trim(),
    '',
    '请基于上述追问要求，直接输出调整后的完整正文：'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 渲染「追问」的 user prompt。
 *
 * 与「追问调整正文」不同：本方法只让 AI 回答用户关于本章写作的疑问，
 * 不输出修订稿、不重写正文。上下文（细纲/人物/伏笔/上一章结尾）作为作答依据。
 */
function renderAskQuestionPrompt(input: AskQuestionRenderInput): string {
  const trimmedContent =
    input.content.length > 30_000
      ? input.content.slice(0, 30_000) + '\n\n（后文因长度限制省略）'
      : input.content
  const charactersSection =
    input.characters.length > 0
      ? `## 主要人物参考\n${input.characters
          .slice(0, 20)
          .map((c) => `- ${c.name}${c.role ? `：${c.role}` : ''}${c.personality ? `，${c.personality}` : ''}`)
          .join('\n')}`
      : ''
  const foreshadowingsSection =
    input.foreshadowings.length > 0
      ? `## 相关伏笔参考\n${input.foreshadowings
          .slice(0, 20)
          .map((f) => `- ${f.content}`)
          .join('\n')}`
      : ''
  // 多轮对话历史（不含本轮）：user/assistant 交替，便于 LLM 把握上下文
  const historySection =
    input.history.length > 0
      ? [
          '## 前几轮对话（用于理解追问上下文，正文以上面提供的为准）',
          ...input.history.map(
            (m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`
          ),
          ''
        ].join('\n')
      : ''

  return [
    `## 任务：就第 ${input.chapterNumber} 章正文回答用户的写作疑问`,
    '',
    '你已读完下方这一章正文及相关设定（细纲、人物、伏笔、上一章结尾）。',
    '用户会针对本章的写法提问，请以「本书写作助手兼资深编辑」的身份作答。',
    '',
    '## 作答要求',
    '1. **只回答问题，不要重写正文，不要输出修订稿或成品文本。**',
    '2. 回答要具体、落到正文原文：必要时逐字引用本章原句作为佐证（用「」或引文格式标注），',
    '   让用户能一眼定位到是哪一段、哪一句。',
    '3. 先给结论，再给依据；若用户的判断有道理就明确认可，若不成立也直说并解释为什么。',
    '4. 可以涉及：人物动机/性格一致性、剧情逻辑/伏笔回收、节奏与张力、视角与文风、',
    '   细纲对照、与上一章衔接、AI 味/套路表达等。按问题类型挑重点，不必面面俱到。',
    '5. 若问题本身（如「为什么这样写」）是在问设计意图，结合细纲、爽点、伏笔、节奏图谱等设定作答；',
    '   设定里没有的，合理推断并说明「这是基于正文表现的分析，非设定明文」。',
    '6. 不要泛泛而谈、不要套话、不要打分；可以用分点说明，但每点都要有正文依据。',
    '7. 正文以「下方提供的第 N 章正文」为准，不要臆造正文中没有的情节。',
    '',
    '## 小说信息',
    `- 书名：${input.projectName}`,
    `- 题材：${input.genre ?? '未指定'}`,
    '',
    input.chapterRequirements
      ? `## 本章长期写作要求\n${renderRequirementChecklist(input.chapterRequirements)}`
      : '',
    input.chapterDetail
      ? `## 本章细纲\n${renderChapterDetail(input.chapterDetail, '细纲')}`
      : '',
    input.prevTail ? `## 上一章结尾参考\n${input.prevTail}` : '',
    charactersSection,
    foreshadowingsSection,
    historySection,
    `------ 第 ${input.chapterNumber} 章正文（仅作答依据，请勿修改） ------`,
    trimmedContent,
    '',
    '## 用户本轮提问',
    input.question.trim(),
    '',
    '请基于上述正文与设定回答：'
  ]
    .filter(Boolean)
    .join('\n')
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

  if (d.rawFields) {
    const skipKeys = new Set([
      '章节标题', '核心事件', '爽点/打脸', '爽点', '章末钩子', 
      '金句', '伏笔铺设', '角色出场', '字数预估', '关键标记', 
      '本章写作要求', '写作要求', '写作要求模板', '自定义补充要求',
      'title', 'plotSummary', 'coolPoint', 'hook', 'goldenLine', 
      'foreshadowings', 'charactersAppearing', 'wordEstimate', 
      'climaxTag', 'writingRequirements', 'writingRequirementTemplateId', 
      'writingRequirementCustomText', 'volume', 'chapterNumber', 'emotion', 'climax'
    ])
    for (const [k, v] of Object.entries(d.rawFields)) {
      if (skipKeys.has(k)) continue
      const text = Array.isArray(v) ? v.join('；') : v
      if (text) lines.push(`- ${k}：${text}`)
    }
  }

  return lines.join('\n')
}

function renderCharacterDetail(c: Character): string {
  const lines: string[] = []
  lines.push(`### ${c.name}（${c.role ?? '角色'}）`)
  if (c.identity) lines.push(`- 身份：${c.identity}`)
  if (c.personality) lines.push(`- 性格：${c.personality}`)
  if (c.abilities) lines.push(`- 能力：${c.abilities}`)
  if (c.synopsis) lines.push(`- 简介：${c.synopsis}`)
  // v4：CharacterRepo 填 customFields（旧 CharacterCardMdRepo 填 rawFields），两者结构相同
  const extra = c.rawFields ?? c.customFields
  if (extra) {
    const skipKeys = new Set(['身份', '性格', '能力', '简介', '姓名', '角色', '类型'])
    for (const [k, v] of Object.entries(extra)) {
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
 * 渲染项目设定段（题材定位/世界观/势力/规则文档）。
 * 势力档案按本章出场角色筛选——若本章出场角色能匹配到势力文件名，只注入匹配的；
 * 无匹配则全部注入（兜底），避免遗漏关键势力信息。
 */
/** 汇总记忆提取中的设定补丁（含 world 级地点） */
function collectSettingsPatches(extraction: MemoryExtraction): SettingsPatch[] {
  const fromExtract = extraction.settingsPatches ?? []
  const fromLocs = patchesFromWorldLocations(extraction.newLocations ?? [])
  return [...fromExtract, ...fromLocs]
}

function renderSettingsSection(settings: SettingsContext, characters: Character[]): string[] {
  const parts: string[] = []
  const hasContent =
    settings.genrePositioning ||
    settings.worldview.length > 0 ||
    settings.factions.length > 0 ||
    settings.customRules.length > 0
  if (!hasContent) return parts

  parts.push('---')
  parts.push('# 项目设定')

  if (settings.genrePositioning) {
    parts.push('## 题材定位（核心梗/卖点/主角人设/节奏规划，强约束）')
    parts.push(settings.genrePositioning)
  }

  if (settings.worldview.length > 0) {
    parts.push('## 世界观（金手指规则/力量体系/背景设定，强约束）')
    for (const w of settings.worldview) {
      parts.push(`### ${w.name}`)
      parts.push(w.body)
    }
  }

  if (settings.factions.length > 0) {
    // 按本章出场角色筛选势力：角色名出现在势力文件名中才注入
    // 只检查 factionName.includes(n)（势力名包含角色名）方向，
    // 避免 n.includes(factionName) 导致单字角色名误匹配（如"陈四"匹配所有含"四"的文件名）
    const appearNames = new Set(characters.map((c) => normalizeName(c.name)))
    const matched = settings.factions.filter((f) => {
      const factionName = normalizeName(f.name)
      for (const n of appearNames) {
        if (factionName.includes(n)) return true
      }
      return false
    })
    const list = matched.length > 0 ? matched : settings.factions
    parts.push('## 势力档案')
    for (const f of list) {
      parts.push(`### ${f.name}`)
      parts.push(f.body)
    }
  }

  if (settings.customRules.length > 0) {
    parts.push('## 规则文档（项目自创机制，强约束）')
    for (const r of settings.customRules) {
      parts.push(`### ${r.name}`)
      parts.push(r.body)
    }
  }

  return parts
}

/**
 * 渲染卷级定位段（卷核心/情绪弧线/爽点节奏/伏笔规划）。
 * 从卷纲文件的 H2 节中提取关键约束素材。
 */
function renderVolumeSection(vol: VolumeOutline): string[] {
  const parts: string[] = []
  // 只注入有价值的节：卷核心/情绪弧线/爽点节奏/伏笔/反转
  const usefulTitles = ['卷核心', '情绪弧线', '爽点节奏', '伏笔', '反转', '核心冲突', '人物弧线']
  const sections = vol.sections.filter((s) =>
    usefulTitles.some((t) => s.title.includes(t))
  )
  if (sections.length === 0) return parts

  parts.push('---')
  parts.push(`# 卷级定位：第 ${vol.number} 卷 ${vol.name}`)
  for (const s of sections) {
    parts.push(`## ${s.title}`)
    parts.push(s.body.trim())
  }
  return parts
}

/**
 * 渲染角色状态追踪段（当前实力/立场/目标 + 近期变更 + 进度摘要 + 待处理问题）。
 * 仅注入本章出场角色的状态快照，避免 token 浪费。
 */
function renderTrackingSection(tracking: TrackingContext, chapterNumber: number): string[] {
  const parts: string[] = []
  const hasContent =
    tracking.characterStates.length > 0 ||
    tracking.stateChanges.length > 0 ||
    tracking.timeline ||
    tracking.recentProgress.length > 0 ||
    tracking.openIssues.length > 0
  if (!hasContent) return parts

  parts.push('---')
  parts.push('# 角色状态追踪')

  // 当前状态快照（全部角色，让 LLM 知道谁在什么状态）
  if (tracking.characterStates.length > 0) {
    parts.push('## 当前状态快照')
    parts.push('| 角色 | 实力 | 立场 | 目标 | 道具 | 关系 |')
    parts.push('|------|------|------|------|------|------|')
    for (const s of tracking.characterStates) {
      parts.push(
        `| ${s.name} | ${s.power || '-'} | ${s.stance || '-'} | ${s.goal || '-'} | ${s.items || '-'} | ${s.relations || '-'} |`
      )
    }
  }

  // 近期状态变更（截到本章为止）
  if (tracking.stateChanges.length > 0) {
    parts.push(`## 近期状态变更（第 ${chapterNumber} 章及之前）`)
    for (const c of tracking.stateChanges.slice(-15)) {
      parts.push(`- 第 ${c.chapter} 章 · ${c.name}：${c.change}`)
    }
  }

  // 时间线（全书时间轴，截断防 token 爆炸）
  if (tracking.timeline) {
    parts.push('## 时间线')
    parts.push(tracking.timeline.slice(0, TIMELINE_MAX_CHARS))
  }

  // 日更进度摘要（最后 3 条，含下一章目标/阻塞点）
  if (tracking.recentProgress.length > 0) {
    parts.push('## 近期写作进度')
    for (const p of tracking.recentProgress) {
      parts.push(`- ${p.date}（${p.chapter}）：${p.summary}`)
      if (p.nextGoal && p.nextGoal !== '—') parts.push(`  · 下一章目标：${p.nextGoal}`)
      if (p.blocker && p.blocker !== '—' && p.blocker !== '无') parts.push(`  · ⚠️ 阻塞点：${p.blocker}`)
    }
  }

  // 待处理问题
  if (tracking.openIssues.length > 0) {
    parts.push('## ⚠️ 待处理问题（写作时需注意）')
    for (const i of tracking.openIssues) {
      parts.push(`- ${i.problem}（${i.status}）`)
      if (i.fix) parts.push(`  · 修正方案：${i.fix}`)
    }
  }

  return parts
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

