import { LlmService } from '../llm-service'
import { TeardownRepository } from './teardown-repository'
import { splitChapters, extractChapterText } from './teardown-chapter-splitter'
import {
  createLongProgress,
  createShortMeta,
  markStageComplete,
  markStageInProgress,
  markShortStageComplete,
  markShortStageInProgress,
  setPausedAfterStage1,
  setStructureCounts,
  recordFailure,
  routeByWordCount,
  nextStage,
  isPausedAfterStage1,
  buildProgressInfo,
  buildEntryFromLong,
  buildEntryFromShort,
  validateStructureCounts,
  isComplete,
  LONG_STAGES,
  SHORT_STAGES
} from './teardown-state'
import {
  TEARDOWN_SYSTEM_PROMPT,
  stage0Prompt,
  stage1Prompt,
  quickPreviewPrompt,
  stage2ChapterPrompt,
  stage3Prompt,
  stage4Prompt,
  stage5Prompt,
  stage6Prompt,
  fullSummaryPrompt
} from '../skill-prompts/teardown/long-prompts'
import {
  SHORT_TEARDOWN_SYSTEM_PROMPT,
  shortStage2Prompt,
  shortStage3Prompt,
  shortStage4Prompt,
  shortStage5Prompt,
  shortStage6Prompt
} from '../skill-prompts/teardown/short-prompts'
import { countWords } from '../words'
import type {
  TeardownEntry,
  TeardownFileNode,
  TeardownFileContent,
  TeardownLengthKind,
  TeardownLongProgress,
  TeardownProgressInfo,
  TeardownRouteResult,
  TeardownShortMeta,
  StartTeardownInput,
  StructureCounts,
  TeardownStage
} from '../../../shared/types'

/** Stage 2 逐章摘要的并发数（skill 包 batch 5-8，桌面用 5 控 token） */
const CHAPTER_BATCH_SIZE = 5

/** 单章喂给 LLM 的最大字符数（防超长章节爆 token；截断时保留开头） */
const MAX_CHAPTER_CHARS = 8000

/** Stage 0 概要抽样：首章开头/末章结尾的截取字符数 */
const OVERVIEW_SAMPLE_CHARS = 2000

/** Stage 1 黄金三章：取前 3 章 */
const GOLDEN_CHAPTERS = 3

/** Stage 6 文风抽样：每章截取字符数 */
const STYLE_SAMPLE_CHARS = 3000

/** 情节点密度估算：每多少字符一个情节点（密度公式字数÷175~200 的中位） */
const CHARS_PER_PLOT_POINT = 175

/** 拆文 LLM 输出 token 上限（聚合/报告类输出较长） */
const TEARDOWN_MAX_TOKENS = 8192

export interface TeardownRunCallbacks {
  /** 流式进度文本（每个 token） */
  onToken?: (token: string) => void
}

/**
 * 拆文服务：编排长篇 7-Stage 管道（含 Stage 1 停靠点）+ 短篇 6-Stage 管道。
 *
 * 长篇管道：
 *   Stage 0（概要 thin）→ 0.5（章节边界表）→ 1（黄金三章，停靠产快速预览）
 *   → [用户 continue] → 2（逐章摘要，并发）→ 3（聚合：节奏/情绪模块）→ 4（设定+角色+关系）
 *   → 5（汇总报告 + 全书概要覆盖）→ 6（文风）
 *
 * 短篇管道：Stage 2 → 3 → 4 → 5 → 6（串行），Phase 7 校验后落 _meta.json
 *
 * 状态机 crash safety：每 Stage 开始前置 lastStageInProgress，目标文件非空才 append stagesCompleted；
 * 半成品不被信任，resume 整段重跑。
 */
export class TeardownService {
  constructor(
    private readonly repo: TeardownRepository,
    private readonly llm: LlmService
  ) {}

  /* =========================================================
     入口：列出 / 启动 / 路由
     ========================================================= */

  async list(): Promise<TeardownEntry[]> {
    const names = await this.repo.listBookNames()
    const entries: TeardownEntry[] = []
    for (const name of names) {
      const createdAt = await this.guessCreatedAt(name)
      const longProgress = await this.repo.readLongProgress(name)
      if (longProgress) {
        const wordCount = await this.computeWordCount(name)
        entries.push({ ...buildEntryFromLong(name, longProgress, createdAt), wordCount })
        continue
      }
      const shortMeta = await this.repo.readShortMeta(name)
      if (shortMeta) {
        entries.push(buildEntryFromShort(shortMeta, createdAt))
        continue
      }
      // 仅有原文未启动：归类未知，按字数猜
      const wc = await this.computeWordCount(name)
      const { lengthKind } = routeByWordCount(wc)
      entries.push({
        bookName: name,
        lengthKind,
        stagesCompleted: [],
        wordCount: wc,
        createdAt,
        updatedAt: createdAt
      })
    }
    // 按更新时间倒序
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 启动拆文：落盘原文 + 字数路由。返回篇幅判定（灰区需前端确认） */
  async start(input: StartTeardownInput): Promise<TeardownRouteResult> {
    const bookName = input.bookName.trim()
    if (!bookName) throw new Error('书名不能为空')
    if (!input.rawText.trim()) throw new Error('原文不能为空')

    const wordCount = countWords(input.rawText)
    let route = input.lengthKindOverride
      ? { lengthKind: input.lengthKindOverride, isGrayZone: false }
      : routeByWordCount(wordCount)

    // 落盘原文 + 初始化骨架
    await this.repo.initBook(bookName, input.rawText, route.lengthKind)

    // 初始化状态机
    if (route.lengthKind === 'long') {
      const progress = createLongProgress(bookName, [])
      await this.repo.writeLongProgress(progress)
    } else {
      const meta = createShortMeta(bookName, wordCount)
      await this.repo.writeShortMeta(meta)
    }
    return { lengthKind: route.lengthKind, wordCount, isGrayZone: route.isGrayZone }
  }

  /* =========================================================
     长篇管道：run（Stage 0→1 停靠）/ continue（Stage 2→6）
     ========================================================= */

  /**
   * 运行长篇管道到 Stage 1 停靠点（产快速预览后返回）。
   * 若已过 Stage 1（resume 场景），直接走 continue。
   */
  async runLong(
    bookName: string,
    cb: TeardownRunCallbacks = {}
  ): Promise<void> {
    let progress = await this.requireLongProgress(bookName)
    const rawText = await this.repo.readRawText(bookName)

    // resume：若已完成 Stage 1 但未停靠（用户重跑），或已完成更靠后阶段，直接进 continue
    const doneSet = new Set(progress.stagesCompleted)
    if (doneSet.has(1) && !isPausedAfterStage1(progress)) {
      return this.continueLong(bookName, cb)
    }

    // Stage 0：概要
    if (!doneSet.has(0)) {
      progress = await this.runStage0(progress, rawText, cb)
    }
    // Stage 0.5：章节边界表
    if (!doneSet.has(0.5)) {
      progress = await this.runStage05(progress, rawText)
    }
    // Stage 1：黄金三章
    if (!doneSet.has(1)) {
      progress = await this.runStage1(progress, rawText, cb)
      // 产快速预览（停靠交付物）
      progress = await this.runQuickPreview(progress, rawText, cb)
      // 标记停靠
      progress = setPausedAfterStage1(progress, true)
      await this.repo.writeLongProgress(progress)
      this.emit(cb, '\n\n✅ 黄金三章拆解完成，已生成快速预览。请确认后继续全量拆解。\n')
      return
    }
    // Stage 1 已完成且在停靠点 → 直接 continue
    return this.continueLong(bookName, cb)
  }

  /** 从 Stage 2 继续长篇管道到 Stage 6 */
  async continueLong(
    bookName: string,
    cb: TeardownRunCallbacks = {}
  ): Promise<void> {
    let progress = await this.requireLongProgress(bookName)
    const rawText = await this.repo.readRawText(bookName)
    const doneSet = new Set(progress.stagesCompleted)

    // 解除停靠
    if (isPausedAfterStage1(progress)) {
      progress = setPausedAfterStage1(progress, false)
      await this.repo.writeLongProgress(progress)
    }

    // Stage 2：逐章摘要（并发）
    if (!doneSet.has(2)) {
      progress = await this.runStage2(progress, rawText, cb)
    }
    // Stage 3：聚合
    if (!doneSet.has(3)) {
      progress = await this.runStage3(progress, cb)
    }
    // Stage 4：设定+角色+关系
    if (!doneSet.has(4)) {
      progress = await this.runStage4(progress, cb)
    }
    // Stage 5：汇总报告 + 全书概要覆盖
    if (!doneSet.has(5)) {
      progress = await this.runStage5(progress, cb)
    }
    // Stage 6：文风
    if (!doneSet.has(6)) {
      progress = await this.runStage6(progress, rawText, cb)
    }
    this.emit(cb, '\n\n🎉 长篇全量拆解完成。\n')
  }

  /* =========================================================
     长篇各 Stage 实现
     ========================================================= */

  private async runStage0(
    progress: TeardownLongProgress,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n📖 Stage 0：概要提取...\n')
    progress = markStageInProgress(progress, 0)
    await this.repo.writeLongProgress(progress)

    const bookName = progress.bookName
    // 临时切章节边界（Stage 0 尚无边界表，用 splitter 现切一次做索引）
    const boundaries = splitChapters(rawText)
    const chapterIndex = this.buildChapterIndex(boundaries)
    const firstChapter = boundaries[0]
      ? extractChapterText(rawText, boundaries[0]).slice(0, OVERVIEW_SAMPLE_CHARS)
      : rawText.slice(0, OVERVIEW_SAMPLE_CHARS)
    const lastChapter = boundaries.length > 0
      ? extractChapterText(rawText, boundaries[boundaries.length - 1]).slice(-OVERVIEW_SAMPLE_CHARS)
      : rawText.slice(-OVERVIEW_SAMPLE_CHARS)
    const sample = `【第1章开头】\n${firstChapter}\n\n【末章结尾】\n${lastChapter}`

    const md = await this.callLlm(
      stage0Prompt(bookName, chapterIndex, sample),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(bookName, '概要.md', md)
    progress = markStageComplete(progress, 0)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 概要.md 已生成\n')
    return progress
  }

  private async runStage05(
    progress: TeardownLongProgress,
    rawText: string
  ): Promise<TeardownLongProgress> {
    this.emitStage(progress.bookName, '\n✂️ Stage 0.5：章节边界表...\n')
    progress = markStageInProgress(progress, 0.5)
    await this.repo.writeLongProgress(progress)

    // 确定性切片（全管道唯一切片来源）
    const boundaries = splitChapters(rawText)
    progress = { ...progress, chapterBoundaries: boundaries }
    progress = markStageComplete(progress, 0.5)
    await this.repo.writeLongProgress(progress)
    this.emitStage(progress.bookName, `  ✓ 识别 ${boundaries.length} 章\n`)
    return progress
  }

  private async runStage1(
    progress: TeardownLongProgress,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n⭐ Stage 1：黄金三章深度拆解...\n')
    progress = markStageInProgress(progress, 1)
    await this.repo.writeLongProgress(progress)

    const boundaries = progress.chapterBoundaries
    const golden = boundaries.slice(0, GOLDEN_CHAPTERS)
    const goldenText = golden
      .map((b) => `\n\n--- 第${b.chapter}章：${b.title} ---\n${extractChapterText(rawText, b)}`)
      .join('')
    const md = await this.callLlm(
      stage1Prompt(progress.bookName, goldenText),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(progress.bookName, '章节/第1-3章_深度拆解.md', md)
    progress = markStageComplete(progress, 1)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 黄金三章拆解完成\n')
    return progress
  }

  private async runQuickPreview(
    progress: TeardownLongProgress,
    _rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n👁 快速预览报告...\n')
    const summaryMd = (await this.repo.readMarkdown(progress.bookName, '概要.md')) ?? ''
    const goldenMd =
      (await this.repo.readMarkdown(progress.bookName, '章节/第1-3章_深度拆解.md')) ?? ''
    const md = await this.callLlm(
      quickPreviewPrompt(progress.bookName, summaryMd, goldenMd),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(progress.bookName, '快速预览.md', md)
    this.emit(cb, '  ✓ 快速预览.md 已生成\n')
    return progress
  }

  private async runStage2(
    progress: TeardownLongProgress,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    const boundaries = progress.chapterBoundaries
    this.emit(cb, `\n📚 Stage 2：逐章摘要（共 ${boundaries.length} 章，${CHAPTER_BATCH_SIZE} 并发）...\n`)
    progress = markStageInProgress(progress, 2)
    await this.repo.writeLongProgress(progress)

    // 跳过前 3 章（黄金三章已拆）；从第 4 章起逐章摘要
    const todo = boundaries.slice(3)
    const failedChapters: number[] = [] // 收集失败章节，写入 failures 供 resume 重跑
    let done = 3
    for (let i = 0; i < todo.length; i += CHAPTER_BATCH_SIZE) {
      const batch = todo.slice(i, i + CHAPTER_BATCH_SIZE)
      // 批内收集失败，避免并发回调对 progress 的读-改-写竞态
      const batchFailures: Array<{ chapter: number; message: string }> = []
      await Promise.allSettled(
        batch.map(async (b) => {
          const text = extractChapterText(rawText, b).slice(0, MAX_CHAPTER_CHARS)
          const maxPoints = Math.max(10, Math.min(40, Math.round(text.length / CHARS_PER_PLOT_POINT)))
          try {
            const md = await this.callLlm(
              stage2ChapterPrompt(progress.bookName, b.chapter, text, maxPoints),
              TEARDOWN_SYSTEM_PROMPT,
              undefined,
              { feature: 'teardown' }
            )
            const fileName = `章节/第${b.chapter}章_摘要.md`
            await this.repo.writeMarkdown(progress.bookName, fileName, md)
          } catch (err) {
            const message = (err as Error).message
            failedChapters.push(b.chapter)
            batchFailures.push({ chapter: b.chapter, message })
            this.emit(cb, `  ⚠ 第${b.chapter}章摘要失败：${message}\n`)
          }
        })
      )
      // 批结束后统一应用到 progress（串行，无竞态）
      for (const f of batchFailures) {
        progress = recordFailure(progress, 2, f.message, f.chapter)
      }
      done += batch.length
      this.emit(cb, `  ✓ 进度 ${done}/${boundaries.length}\n`)
    }
    progress = markStageComplete(progress, 2)
    await this.repo.writeLongProgress(progress)
    if (failedChapters.length > 0) {
      this.emit(cb, `  ⚠ Stage 2 完成，但 ${failedChapters.length} 章摘要失败（已记录，可重新运行尝试补齐）\n`)
    } else {
      this.emit(cb, '  ✓ 逐章摘要完成\n')
    }
    return progress
  }

  private async runStage3(
    progress: TeardownLongProgress,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n🧩 Stage 3：聚合分析（节奏/情绪模块）...\n')
    progress = markStageInProgress(progress, 3)
    await this.repo.writeLongProgress(progress)

    const summaries = await this.collectAllSummaries(progress.bookName)
    const md = await this.callLlm(
      stage3Prompt(progress.bookName, summaries),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.writeMultiFile(progress.bookName, md, [
      '剧情/README.md',
      '剧情/故事线.md',
      '剧情/节奏.md',
      '剧情/情绪模块.md'
    ])
    progress = markStageComplete(progress, 3)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 节奏.md / 情绪模块.md 已生成\n')
    return progress
  }

  private async runStage4(
    progress: TeardownLongProgress,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n🎭 Stage 4：设定 + 角色档案 + 关系...\n')
    progress = markStageInProgress(progress, 4)
    await this.repo.writeLongProgress(progress)

    const summaries = await this.collectAllSummaries(progress.bookName)
    const md = await this.callLlm(
      stage4Prompt(progress.bookName, summaries),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.writeMultiFile(progress.bookName, md, [
      '设定',
      '角色'
    ])
    progress = markStageComplete(progress, 4)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 设定/角色/关系已生成\n')
    return progress
  }

  private async runStage5(
    progress: TeardownLongProgress,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n📊 Stage 5：汇总报告...\n')
    progress = markStageInProgress(progress, 5)
    await this.repo.writeLongProgress(progress)

    const bookName = progress.bookName
    const summaryMd = (await this.repo.readMarkdown(bookName, '概要.md')) ?? ''
    const goldenMd = (await this.repo.readMarkdown(bookName, '章节/第1-3章_深度拆解.md')) ?? ''
    const rhythmMd = (await this.repo.readMarkdown(bookName, '剧情/节奏.md')) ?? ''
    const emotionMd = (await this.repo.readMarkdown(bookName, '剧情/情绪模块.md')) ?? ''
    const reportMd = await this.callLlm(
      stage5Prompt(bookName, summaryMd, goldenMd, rhythmMd, emotionMd),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(bookName, '拆文报告.md', reportMd)

    // 全书概要覆盖（Stage 0 thin → Stage 5 plot-aware）
    const summaries = await this.collectAllSummaries(bookName)
    const fullSummary = await this.callLlm(
      fullSummaryPrompt(bookName, summaries, summaryMd),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(bookName, '概要.md', fullSummary)

    progress = markStageComplete(progress, 5)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 拆文报告.md + 概要覆盖完成\n')
    return progress
  }

  private async runStage6(
    progress: TeardownLongProgress,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownLongProgress> {
    this.emit(cb, '\n✍️ Stage 6：文风分析...\n')
    progress = markStageInProgress(progress, 6)
    await this.repo.writeLongProgress(progress)

    const bookName = progress.bookName
    const boundaries = progress.chapterBoundaries
    // 抽样：首章 + 中间章 + 末章
    const samples = [
      boundaries[0],
      boundaries[Math.floor(boundaries.length / 2)],
      boundaries[boundaries.length - 1]
    ]
      .filter(Boolean)
      .map((b) => `--- 第${b.chapter}章：${b.title} ---\n${extractChapterText(rawText, b).slice(0, STYLE_SAMPLE_CHARS)}`)
      .join('\n\n')
    const reportMd = (await this.repo.readMarkdown(bookName, '拆文报告.md')) ?? ''
    const md = await this.callLlm(
      stage6Prompt(bookName, samples, reportMd),
      TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.writeMarkdown(bookName, '文风.md', md)
    progress = markStageComplete(progress, 6)
    await this.repo.writeLongProgress(progress)
    this.emit(cb, '  ✓ 文风.md 已生成\n')
    return progress
  }

  /* =========================================================
     短篇管道：Stage 2 → 3 → 4 → 5 → 6 + Phase 7
     ========================================================= */

  async runShort(
    bookName: string,
    cb: TeardownRunCallbacks = {}
  ): Promise<void> {
    let meta = await this.requireShortMeta(bookName)
    const rawText = await this.repo.readRawText(bookName)
    const doneSet = new Set(meta.stagesCompleted)

    // Stage 2
    if (!doneSet.has(2)) {
      meta = await this.runShortStage2(meta, rawText, cb)
    }
    // Stage 3
    if (!doneSet.has(3)) {
      meta = await this.runShortStage3(meta, rawText, cb)
    }
    // Stage 4
    if (!doneSet.has(4)) {
      meta = await this.runShortStage4(meta, rawText, cb)
    }
    // Stage 5
    if (!doneSet.has(5)) {
      meta = await this.runShortStage5(meta, rawText, cb)
    }
    // Stage 6
    if (!doneSet.has(6)) {
      meta = await this.runShortStage6(meta, cb)
    }
    this.emit(cb, '\n\n🎉 短篇拆解完成。\n')
  }

  private async runShortStage2(
    meta: TeardownShortMeta,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownShortMeta> {
    this.emit(cb, '\n📖 Stage 2：结构 + 情节节点...\n')
    meta = markShortStageInProgress(meta, 2)
    await this.repo.writeShortMeta(meta)
    const md = await this.callLlm(
      shortStage2Prompt(meta.bookName, rawText, meta.wordCount),
      SHORT_TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    // 解析两段：拆文报告 + 情节节点
    const { reportPart, nodesPart } = splitShortStage2(md)
    await this.repo.writeMarkdown(meta.bookName, '拆文报告.md', reportPart)
    await this.repo.writeMarkdown(meta.bookName, '情节节点.md', nodesPart)
    meta = markShortStageComplete(meta, 2)
    await this.repo.writeShortMeta(meta)
    this.emit(cb, '  ✓ 拆文报告.md / 情节节点.md 已生成\n')
    return meta
  }

  private async runShortStage3(
    meta: TeardownShortMeta,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownShortMeta> {
    this.emit(cb, '\n💔 Stage 3：情感线 + 爆点...\n')
    meta = markShortStageInProgress(meta, 3)
    await this.repo.writeShortMeta(meta)
    const nodes = (await this.repo.readMarkdown(meta.bookName, '情节节点.md')) ?? ''
    const md = await this.callLlm(
      shortStage3Prompt(meta.bookName, rawText, nodes),
      SHORT_TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.appendMarkdown(meta.bookName, '拆文报告.md', '\n\n' + md)
    meta = markShortStageComplete(meta, 3)
    await this.repo.writeShortMeta(meta)
    this.emit(cb, '  ✓ 情感线/爆点已追加\n')
    return meta
  }

  private async runShortStage4(
    meta: TeardownShortMeta,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownShortMeta> {
    this.emit(cb, '\n🔄 Stage 4：反转 + 写作手法...\n')
    meta = markShortStageInProgress(meta, 4)
    await this.repo.writeShortMeta(meta)
    const md = await this.callLlm(
      shortStage4Prompt(meta.bookName, rawText),
      SHORT_TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    const { reportPart, methodsPart } = splitShortStage4(md)
    await this.repo.appendMarkdown(meta.bookName, '拆文报告.md', '\n\n' + reportPart)
    await this.repo.writeMarkdown(meta.bookName, '写作手法.md', methodsPart)
    meta = markShortStageComplete(meta, 4)
    await this.repo.writeShortMeta(meta)
    this.emit(cb, '  ✓ 反转分析/写作手法.md 已生成\n')
    return meta
  }

  private async runShortStage5(
    meta: TeardownShortMeta,
    rawText: string,
    cb: TeardownRunCallbacks
  ): Promise<TeardownShortMeta> {
    this.emit(cb, '\n👥 Stage 5：人物 + 开头结尾...\n')
    meta = markShortStageInProgress(meta, 5)
    await this.repo.writeShortMeta(meta)
    const md = await this.callLlm(
      shortStage5Prompt(meta.bookName, rawText),
      SHORT_TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    await this.repo.appendMarkdown(meta.bookName, '拆文报告.md', '\n\n' + md)
    meta = markShortStageComplete(meta, 5)
    await this.repo.writeShortMeta(meta)
    this.emit(cb, '  ✓ 人物/开头结尾已追加\n')
    return meta
  }

  private async runShortStage6(
    meta: TeardownShortMeta,
    cb: TeardownRunCallbacks
  ): Promise<TeardownShortMeta> {
    this.emit(cb, '\n🏆 Stage 6：综合评估 + Phase 7 校验...\n')
    meta = markShortStageInProgress(meta, 6)
    await this.repo.writeShortMeta(meta)
    const reportSoFar = (await this.repo.readMarkdown(meta.bookName, '拆文报告.md')) ?? ''
    const md = await this.callLlm(
      shortStage6Prompt(meta.bookName, reportSoFar),
      SHORT_TEARDOWN_SYSTEM_PROMPT,
      cb,
      { feature: 'teardown' }
    )
    const { reportPart, countsJson } = splitShortStage6(md)

    // Phase 7：结构计数校验
    const counts = parseStructureCounts(countsJson)
    const validation = validateStructureCounts(counts)
    if (!validation.ok) {
      this.emit(cb, `  ⚠ Phase 7 结构计数未达标：\n${validation.errors.map((e) => '    - ' + e).join('\n')}\n`)
      this.emit(cb, '  （仍写入报告，计数标在 _meta.json 供人工复核）\n')
    }

    await this.repo.appendMarkdown(meta.bookName, '拆文报告.md', '\n\n' + reportPart)
    meta = setStructureCounts(meta, counts)
    meta = markShortStageComplete(meta, 6)
    await this.repo.writeShortMeta(meta)
    this.emit(cb, '  ✓ 综合评估已追加，_meta.json 已更新\n')
    return meta
  }

  /* =========================================================
     查询：进度 / 文件树 / 读文件 / 删除
     ========================================================= */

  async getProgress(bookName: string): Promise<TeardownProgressInfo> {
    const longProgress = await this.repo.readLongProgress(bookName)
    if (longProgress) {
      return buildProgressInfo(
        bookName,
        'long',
        longProgress.stagesCompleted,
        longProgress.lastStageInProgress,
        await this.computeChapterProgress(longProgress)
      )
    }
    const shortMeta = await this.repo.readShortMeta(bookName)
    if (shortMeta) {
      return buildProgressInfo(
        bookName,
        'short',
        shortMeta.stagesCompleted,
        shortMeta.lastStageInProgress
      )
    }
    // 未启动
    return buildProgressInfo(bookName, 'short', [])
  }

  async getFiles(bookName: string): Promise<TeardownFileNode[]> {
    return this.repo.listFiles(bookName)
  }

  async readFile(bookName: string, relPath: string): Promise<TeardownFileContent | null> {
    const content = await this.repo.readFile(bookName, relPath)
    if (content === null) return null
    return { path: relPath, content }
  }

  async delete(bookName: string): Promise<void> {
    await this.repo.deleteBook(bookName)
  }

  /* =========================================================
     私有辅助
     ========================================================= */

  private async requireLongProgress(bookName: string): Promise<TeardownLongProgress> {
    const p = await this.repo.readLongProgress(bookName)
    if (!p) throw new Error(`未找到长篇拆文进度：${bookName}（请先 startTeardown）`)
    return p
  }

  private async requireShortMeta(bookName: string): Promise<TeardownShortMeta> {
    const m = await this.repo.readShortMeta(bookName)
    if (!m) throw new Error(`未找到短篇拆文进度：${bookName}（请先 startTeardown）`)
    return m
  }

  /** 统一 LLM 调用封装（注入 feature 用量归属 + maxTokens 按内容估算） */
  private async callLlm(
    prompt: string,
    systemPrompt: string,
    cb: TeardownRunCallbacks | undefined,
    opts: { feature: string }
  ): Promise<string> {
    // 拆文输出普遍较长（聚合/报告 3000-6000 字），给足 token 上限
    const maxTokens = TEARDOWN_MAX_TOKENS
    return this.llm.generateStream(prompt, {
      systemPrompt,
      maxTokens,
      meta: { feature: opts.feature },
      onToken: cb?.onToken
    })
  }

  private emit(cb: TeardownRunCallbacks | undefined, text: string): void {
    cb?.onToken?.(text)
  }

  /** 无 cb 的进度推送（写入进度文件后无法直接推前端，这里 no-op 兜底） */
  private emitStage(_bookName: string, _text: string): void {
    // Stage 0.5 是确定性切片，无流式 token；进度通过 getTeardownProgress 轮询
  }

  /** 构建章节索引表（供 Stage 0） */
  private buildChapterIndex(
    boundaries: { chapter: number; title: string; start: number; end: number }[]
  ): string {
    if (boundaries.length === 0) return '（未识别到章节标题，整本作为单章处理）'
    const lines = boundaries.map(
      (b) => `| 第${b.chapter}章 | ${b.title} | ${b.end - b.start}字 |`
    )
    return `| 章节 | 标题 | 字数 |\n|------|------|------|\n${lines.join('\n')}`
  }

  /** 收集全部章节摘要（Stage 3/4 输入） */
  private async collectAllSummaries(bookName: string): Promise<string> {
    const files = await this.repo.listFiles(bookName)
    const summaryFiles = files.filter(
      (f) => !f.isDir && f.path.startsWith('章节/') && f.path.endsWith('.md')
    )
    const parts: string[] = []
    for (const f of summaryFiles) {
      const content = await this.repo.readFile(bookName, f.path)
      if (content) parts.push(`\n### ${f.path}\n${content}`)
    }
    return parts.join('\n') || '（无章节摘要）'
  }

  /** 计算长篇 Stage 2 逐章进度：已落盘的章节摘要数 / 总章数 */
  private async computeChapterProgress(
    progress: TeardownLongProgress
  ): Promise<{ done: number; total: number } | undefined> {
    if (progress.lastStageInProgress !== 2) return undefined
    const total = progress.chapterBoundaries.length
    // 统计 章节/ 目录下已落盘的「第N章_摘要.md」（排除黄金三章深度拆解）
    try {
      const files = await this.repo.listFiles(progress.bookName)
      const done = files.filter(
        (f) => !f.isDir && /章节\/第\d+章_摘要\.md$/.test(f.path)
      ).length
      return { done, total }
    } catch {
      return { done: 0, total }
    }
  }

  /** 多文件输出解析：LLM 用 `=== 文件：{path} ===` 分隔，逐个落盘 */
  /**
   * 解析 LLM 多文件输出（`=== 文件：{path} ===` 分隔）并落盘。
   * 安全校验：路径必须以已知前缀开头（章节/角色/设定/剧情/拆文报告/文风/概要/快速预览），
   * 拒绝 `..`、绝对路径、盘符——防止 prompt injection 让 LLM 输出恶意路径写到书目录外。
   * @param allowedPrefixes 允许的相对路径前缀白名单
   */
  private async writeMultiFile(
    bookName: string,
    md: string,
    allowedPrefixes: string[]
  ): Promise<void> {
    const sections = splitByFileMarker(md)
    for (const { path: relPath, content } of sections) {
      if (!relPath || !content.trim()) continue
      // 白名单校验：路径必须以允许的前缀开头，且不含 .. / 绝对路径 / 盘符
      if (!isAllowedProductPath(relPath, allowedPrefixes)) {
        console.warn(`[writeMultiFile] 拒绝越界产物路径：${relPath}`)
        continue
      }
      await this.repo.writeMarkdown(bookName, relPath, content.trim())
    }
  }

  private async computeWordCount(bookName: string): Promise<number> {
    try {
      const text = await this.repo.readRawText(bookName)
      return countWords(text)
    } catch {
      return 0
    }
  }

  private async guessCreatedAt(bookName: string): Promise<string> {
    // 用原文文件的 mtime 作为创建时间兜底
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      for (const ext of ['txt', 'md']) {
        try {
          const stat = await fs.stat(
            path.join(this.repo.bookDir(bookName), '原文', `原文.${ext}`)
          )
          return stat.birthtime.toISOString()
        } catch {
          // try next
        }
      }
    } catch {
      // ignore
    }
    return new Date().toISOString()
  }
}

/* =========================================================
   纯函数辅助：输出解析
   ========================================================= */

/** 按 `=== 文件：{path} ===` 分隔多文件输出 */
export function splitByFileMarker(md: string): { path: string; content: string }[] {
  const re = /={2,}\s*文件[：:]\s*([^\n=]+?)\s*={2,}/g
  const result: { path: string; content: string }[] = []
  let lastIndex = 0
  let currentPath: string | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(md)) !== null) {
    if (currentPath !== null) {
      result.push({ path: currentPath, content: md.slice(lastIndex, match.index) })
    }
    currentPath = match[1].trim()
    lastIndex = re.lastIndex
  }
  if (currentPath !== null) {
    result.push({ path: currentPath, content: md.slice(lastIndex) })
  }
  return result
}

/**
 * 校验 LLM 输出的产物相对路径是否安全。
 * - 路径第一段必须在白名单内（如 章节/、剧情/、或根级 拆文报告.md）
 * - 禁止 `..` 分量（防逃逸）
 * - 禁止绝对路径 / 盘符 / 分隔符开头
 */
export function isAllowedProductPath(relPath: string, allowedPrefixes: string[]): boolean {
  const p = relPath.trim()
  if (!p) return false
  // 禁止绝对路径 / 盘符 / 分隔符开头
  if (/^[/\\]/.test(p) || /^[A-Za-z]:[\\/]/.test(p)) return false
  // 禁止 .. 分量（任何层级的目录穿越）
  const segments = p.split(/[/\\]/)
  if (segments.some((s) => s === '..')) return false
  // 第一段必须在白名单内：精确匹配 或 「白名单项.扩展名」（如 拆文报告.md）
  const firstSeg = segments[0]
  return allowedPrefixes.some(
    (prefix) => firstSeg === prefix || firstSeg.startsWith(prefix + '.')
  )
}

/** 短篇 Stage 2 输出拆为「拆文报告」+「情节节点」两段 */
function splitShortStage2(md: string): { reportPart: string; nodesPart: string } {
  const segs = splitBySegmentRaw(md)
  let report = ''
  let nodes = ''
  for (const seg of segs) {
    if (seg.includes('情节节点清单') || /^N\d/m.test(seg.trim())) {
      nodes += (nodes ? '\n\n' : '') + seg
    } else {
      report += (report ? '\n\n' : '') + seg
    }
  }
  if (!report && !nodes) report = md
  return { reportPart: report, nodesPart: nodes }
}

/** 短篇 Stage 4 输出拆为「拆文报告（反转）」+「写作手法」两段 */
function splitShortStage4(md: string): { reportPart: string; methodsPart: string } {
  const segs = splitBySegmentRaw(md)
  let report = ''
  let methods = ''
  for (const seg of segs) {
    if (seg.includes('POV') || seg.includes('对话手法') || seg.includes('意象')) {
      methods += (methods ? '\n\n' : '') + seg
    } else {
      report += (report ? '\n\n' : '') + seg
    }
  }
  if (!report && !methods) report = md
  return { reportPart: report, methodsPart: methods }
}

/** 短篇 Stage 6 输出拆为「综合评估」+「_meta_counts JSON」 */
function splitShortStage6(md: string): { reportPart: string; countsJson: string } {
  const parts = splitBySegmentRaw(md)
  return {
    reportPart: parts[0] ?? md,
    countsJson: parts[1] ?? ''
  }
}

/** 通用：按 `=== 段：{label} ===` 分隔，返回所有段（去标记） */
function splitBySegmentRaw(md: string): string[] {
  const re = /={2,}\s*段[：:]\s*[^\n=]+?\s*={2,}/g
  const segments: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let found = false
  while ((match = re.exec(md)) !== null) {
    if (found) {
      segments.push(md.slice(lastIndex, match.index))
    }
    found = true
    lastIndex = re.lastIndex
  }
  if (found) segments.push(md.slice(lastIndex))
  return segments
}

/** 解析 Stage 6 的 _meta_counts JSON（容错；兼容 camelCase 与 snake_case） */
export function parseStructureCounts(jsonStr: string): StructureCounts {
  const fallback: StructureCounts = {
    beats: 0,
    hooks: 0,
    setupClues: 0,
    characterArchetypes: 0,
    reusableStructures: 0
  }
  if (!jsonStr.trim()) return fallback
  // 提取第一个 JSON 对象
  const match = jsonStr.match(/\{[\s\S]*\}/)
  if (!match) return fallback
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>
    return {
      beats: toCount(obj.beats),
      hooks: toCount(obj.hooks),
      setupClues: toCount(obj.setupClues ?? obj.setup_clues),
      characterArchetypes: toCount(obj.characterArchetypes ?? obj.character_archetypes),
      reusableStructures: toCount(obj.reusableStructures ?? obj.reusable_structures),
      reversalType:
        typeof obj.reversalType === 'string'
          ? obj.reversalType
          : typeof obj.reversal_type === 'string'
            ? obj.reversal_type
            : undefined
    }
  } catch {
    return fallback
  }
}

function toCount(v: unknown): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

// re-export 部分状态机常量供 IPC 层用
export { LONG_STAGES, SHORT_STAGES, nextStage, isComplete }
export type { TeardownStage }
