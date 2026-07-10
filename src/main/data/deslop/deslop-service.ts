import { promises as fs } from 'fs'
import { join } from 'path'
import { LlmService } from '../llm-service'
import { scanAiPatterns } from './check-ai-patterns'
import { scanDegeneration } from './check-degeneration'
import { normalizePunctuation, countPunctuationIssues } from './normalize-punctuation'
import { ALL_BANNED_WORDS, PSYCH_WORDS, PARALLELISM_PATTERNS } from './banned-words'
import {
  DESLOP_SYSTEM_PROMPT,
  buildDeslopPrompt,
  buildCleanupPrompt,
  gatesForLevel,
  extractRewritten,
  extractChangeSummary
} from '../skill-prompts/deslop/anti-ai-methods'
import { countWords } from '../words'
import type {
  DeslopFinding,
  DeslopLevel,
  DeslopMetrics,
  DeslopResult,
  DeslopScanReport,
  DeslopStyleContext
} from '../../../shared/types'

export interface DeslopCallbacks {
  onToken?: (token: string) => void
}

/**
 * 去 AI 味润色服务（编排 Phase 1-4）。
 *
 * Phase 1：扫描（确定性脚本，不调 LLM）→ DeslopScanReport
 * Phase 2：诊断分级（6 项量化指标 → mild/moderate/severe）
 * Phase 3：逐项清除（按命中的 Gate 调 LLM 改写）
 * Phase 3.5：确定性收尾（normalize-punctuation 兜底 + 复扫）
 * Phase 4：润色报告（DeslopResult）
 *
 * 文件模式：IPC 层读章节 → deslop(text) → 写回正文
 * 文本模式：直接 deslop(text)，返回润色后文本不落盘
 */
export class DeslopService {
  constructor(private readonly llm: LlmService) {}

  /* =========================================================
     Phase 1：扫描（确定性，不调 LLM）
     ========================================================= */

  /** @param whitelist 项目级豁免词（IPC 层按 projectId 解析后传入） */
  async scan(
    text: string,
    opts: { whitelist?: Set<string>; bannedWords?: string[] } = {}
  ): Promise<DeslopScanReport> {
    const aiFindings = scanAiPatterns(text, { whitelist: opts.whitelist, bannedWords: opts.bannedWords })
    const degenFindings = scanDegeneration(text)
    const findings = [...aiFindings, ...degenFindings]
    const counts = {
      blocking: findings.filter((f) => f.severity === 'blocking').length,
      advisory: findings.filter((f) => f.severity === 'advisory').length
    }
    const wordCount = countWords(text)
    const metrics = this.computeMetrics(text, findings, wordCount)
    return { findings, counts, metrics, wordCount }
  }

  /* =========================================================
     Phase 2：诊断分级（6 项指标 → level）
     ========================================================= */

  classify(metrics: DeslopMetrics, counts: { blocking: number; advisory: number }): DeslopLevel {
    // 分级标准（对齐 skill 包）：
    // - 轻度：禁用词 ≤5 处/千字，无连续 3+ 句式套路
    // - 中度：禁用词 6-15 处/千字，或有连续 3+ 句式套路
    // - 重度：禁用词 >15 处/千字，或多类问题叠加
    const density = metrics.bannedWordDensity
    const parallel = metrics.parallelismCount
    const blocking = counts.blocking

    if (density > 15 || blocking > 20 || (density > 10 && parallel >= 2)) return 'severe'
    if (density > 5 || parallel >= 1 || blocking > 5) return 'moderate'
    return 'mild'
  }

  /* =========================================================
     Phase 3 + 3.5 + 4：润色（编排）
     ========================================================= */

  async deslop(
    text: string,
    opts: {
      onToken?: (token: string) => void
      levelOverride?: DeslopLevel
      whitelist?: Set<string>
      /** 用户配置的禁用词表（覆盖内置默认）；缺省 = 用内置默认 */
      bannedWords?: string[]
      /** 用户配置的文本规则覆盖（系统铁律 + Gate 方法），缺省 = 用内置默认 */
      textOverrides?: {
        systemPrompt?: string
        gates?: Partial<Record<string, string>>
      }
      /** 项目题材 + 文风档案摘要（IPC 层解析后注入），让改写语感对齐项目 */
      styleContext?: DeslopStyleContext
    } = {}
  ): Promise<DeslopResult> {
    const beforeWords = countWords(text)

    // Phase 1 扫描（用户配置的禁用词表优先，否则内置默认）
    const report = await this.scan(text, {
      whitelist: opts.whitelist,
      bannedWords: opts.bannedWords
    })

    // Phase 2 分级
    const level = opts.levelOverride ?? this.classify(report.metrics, report.counts)
    const gates = gatesForLevel(level)
    const emit = (t: string): void => opts.onToken?.(t)
    emit(`\n🔍 Phase 1-2：扫描完成，诊断为${levelName(level)}（blocking ${report.counts.blocking} / advisory ${report.counts.advisory}）\n`)
    emit(`   处理 Gate：${gates.join(' ')}\n`)
    if (opts.styleContext?.genre || opts.styleContext?.style) {
      const bits: string[] = []
      if (opts.styleContext.genre) bits.push(`题材=${opts.styleContext.genre}`)
      if (opts.styleContext.style?.identifiedStyle) bits.push(`文风=${opts.styleContext.style.identifiedStyle}`)
      emit(`   风格语境：${bits.join(' ')}\n`)
    }

    // Phase 3：逐项清除（调 LLM 改写命中的 Gate）
    let rewritten = text
    let changeSummary: string[] = []
    const effectiveSystemPrompt = opts.textOverrides?.systemPrompt ?? DESLOP_SYSTEM_PROMPT
    if (report.counts.blocking > 0 || report.counts.advisory > 0) {
      emit(`\n✍️ Phase 3：按 Gate 改写（${levelName(level)}，删除比例上限 ${deleteLimitPct(level)}%）...\n`)
      const relevantFindings = report.findings.filter((f) => gates.includes(f.gate))
      const prompt = buildDeslopPrompt(text, level, relevantFindings, gates, opts.styleContext, {
        textOverrides: opts.textOverrides?.gates,
        bannedWords: opts.bannedWords
      })
      const llmOutput = await this.llm.generateStream(prompt, {
        systemPrompt: effectiveSystemPrompt,
        maxTokens: 12288, // 改写输出可能比原文长，给足空间
        meta: { feature: 'deslop' },
        onToken: emit
      })
      rewritten = extractRewritten(llmOutput)
      changeSummary = extractChangeSummary(llmOutput)
      emit(`\n   改写完成：${changeSummary.length} 处改动\n`)
      // 逐条 emit 改动说明，让用户在日志里看到具体改了什么、为什么
      if (changeSummary.length > 0) {
        emit('\n   改动明细：\n')
        for (const c of changeSummary) emit(`   ${c}\n`)
      }
    } else {
      emit('\n✅ 无 AI 味问题，跳过改写。\n')
    }

    // Phase 3.5：确定性收尾（标点兜底 + 复扫）
    emit('\n🧹 Phase 3.5：标点兜底 + 复扫...\n')
    const normalized = normalizePunctuation(rewritten)
    const totalNormChanges =
      normalized.changes.emDash +
      normalized.changes.dash +
      normalized.changes.doubleHyphen +
      normalized.changes.ellipsis +
      normalized.changes.singleEllipsis
    if (totalNormChanges > 0) {
      emit(`   标点兜底：修正 ${totalNormChanges} 处（破折号 ${normalized.changes.emDash + normalized.changes.dash} / 省略号 ${normalized.changes.ellipsis + normalized.changes.singleEllipsis}）\n`)
    }
    let finalText = normalized.text

    // Phase 3.6：二次清理循环（复扫后对剩余 blocking finding 再改一轮，直到干净或达到上限）
    const MAX_CLEANUP_ROUNDS = 2
    let cleanupRound = 0
    let cleanupReport = await this.scan(finalText, { bannedWords: opts.bannedWords })
    let remainingBlocking = cleanupReport.findings.filter((f) => f.severity === 'blocking')
    const allChangeSummary = [...changeSummary]

    if (remainingBlocking.length === 0) {
      emit('   ✅ 复扫无 blocking 残留，跳过二次清理。\n')
    } else {
      while (remainingBlocking.length > 0 && cleanupRound < MAX_CLEANUP_ROUNDS) {
        cleanupRound += 1
        emit(`\n🔄 Phase 3.6：二次清理第 ${cleanupRound}/${MAX_CLEANUP_ROUNDS} 轮（剩余 ${remainingBlocking.length} 处 blocking）...\n`)
        const cleanupPrompt = buildCleanupPrompt(
          finalText,
          level,
          remainingBlocking,
          cleanupRound,
          opts.styleContext,
          { textOverrides: opts.textOverrides?.gates, bannedWords: opts.bannedWords }
        )
        const cleanupOutput = await this.llm.generateStream(cleanupPrompt, {
          systemPrompt: effectiveSystemPrompt,
          maxTokens: 12288,
          meta: { feature: `deslop:cleanup:${cleanupRound}` },
          onToken: emit
        })
        const cleanupRewritten = extractRewritten(cleanupOutput)
        const cleanupChanges = extractChangeSummary(cleanupOutput)
        if (cleanupChanges.length > 0) {
          allChangeSummary.push(...cleanupChanges)
          emit(`   第 ${cleanupRound} 轮清理改动：${cleanupChanges.length} 处\n`)
        }
        // 标点兜底（清理轮改写后可能再引入破折号/省略号）
        const reNorm = normalizePunctuation(cleanupRewritten)
        if (
          reNorm.changes.emDash + reNorm.changes.dash + reNorm.changes.doubleHyphen +
          reNorm.changes.ellipsis + reNorm.changes.singleEllipsis > 0
        ) {
          finalText = reNorm.text
        } else {
          finalText = cleanupRewritten
        }
        // 复扫判断是否还需要下一轮
        cleanupReport = await this.scan(finalText, { bannedWords: opts.bannedWords })
        remainingBlocking = cleanupReport.findings.filter((f) => f.severity === 'blocking')
      }

      if (remainingBlocking.length > 0) {
        emit(`\n⚠️ 二次清理后仍剩 ${remainingBlocking.length} 处 blocking（建议人工复核）：\n`)
        remainingBlocking.slice(0, 5).forEach((f) => emit(`   - 第${f.line}行 [${f.type}]: ${f.excerpt}\n`))
      } else {
        emit(`\n✅ 二次清理完成，blocking 已清零（共 ${cleanupRound} 轮）。\n`)
      }
    }
    changeSummary = allChangeSummary

    // Phase 4：报告
    const afterWords = countWords(finalText)
    const deleteRatio = beforeWords > 0 ? 1 - afterWords / beforeWords : 0
    emit(`\n📊 Phase 4：润色完成（${beforeWords} → ${afterWords} 字，删除比例 ${(deleteRatio * 100).toFixed(1)}%）\n`)

    return {
      rewritten: finalText,
      processedGates: gates as DeslopResult['processedGates'],
      beforeWords,
      afterWords,
      deleteRatio,
      remainingFindings: cleanupReport.findings,
      changeSummary
    }
  }

  /* =========================================================
     私有：指标计算 + 白名单
     ========================================================= */

  private computeMetrics(
    text: string,
    findings: DeslopFinding[],
    wordCount: number
  ): DeslopMetrics {
    const perKilo = (n: number): number => (wordCount > 0 ? (n / wordCount) * 1000 : 0)

    // 禁用词密度（banned-word 类 finding 数 / 千字）
    const bannedHits = findings.filter((f) => f.type === 'banned-word').length
    // 排比命中数
    const parallelismCount = findings.filter((f) => f.type === 'parallelism').length
    // 心理词密度
    const psychHits = this.countOccurrences(text, PSYCH_WORDS)
    // 重复描写密度（repetition 类）
    const repHits = findings.filter((f) => f.type === 'repetition').length
    // 对话标签密度（"道/说" 占比）
    const dialogueTagDensity = this.computeDialogueTagDensity(text)
    // 平均段落句数
    const avgSentencesPerParagraph = this.computeAvgSentencesPerParagraph(text)

    return {
      bannedWordDensity: perKilo(bannedHits),
      parallelismCount,
      psychWordDensity: perKilo(psychHits),
      dialogueTagDensity,
      avgSentencesPerParagraph,
      repetitionDensity: perKilo(repHits)
    }
  }

  private countOccurrences(text: string, words: string[]): number {
    let n = 0
    for (const w of words) {
      let idx = text.indexOf(w)
      while (idx !== -1) {
        n += 1
        idx = text.indexOf(w, idx + w.length)
      }
    }
    return n
  }

  private computeDialogueTagDensity(text: string): number {
    // "X道" / "X说" 占对话相关行的比例（简化估算）
    const tagMatches = text.match(/[说道问道喊叫笑]道/g) ?? []
    const sayMatches = text.match(/[^说道]{1,3}说[^道]/g) ?? []
    const dialogueLines = text.split('\n').filter((l) => /[""「」''']/.test(l)).length
    if (dialogueLines === 0) return 0
    return ((tagMatches.length + sayMatches.length) / dialogueLines) * 100
  }

  private computeAvgSentencesPerParagraph(text: string): number {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim())
    if (paragraphs.length === 0) return 0
    let totalSentences = 0
    for (const p of paragraphs) {
      totalSentences += p.split(/[。！？!?]/).filter((s) => s.trim()).length
    }
    return totalSentences / paragraphs.length
  }

  /** 读取/写入项目级白名单（IPC 层用） */
  static async readWhitelistFile(path: string): Promise<string[]> {
    try {
      const content = await fs.readFile(path, 'utf-8')
      return content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    } catch {
      return []
    }
  }

  static async writeWhitelistFile(path: string, words: string[]): Promise<void> {
    const dir = join(path, '..')
    await fs.mkdir(dir, { recursive: true })
    const content = words.filter((w) => w.trim()).join('\n') + '\n'
    await fs.writeFile(path, content, 'utf-8')
  }
}

function levelName(level: DeslopLevel): string {
  return level === 'mild' ? '轻度' : level === 'moderate' ? '中度' : '重度'
}

function deleteLimitPct(level: DeslopLevel): number {
  return level === 'mild' ? 15 : level === 'moderate' ? 25 : 35
}

// re-export 供测试
export { ALL_BANNED_WORDS, PARALLELISM_PATTERNS, countPunctuationIssues }
