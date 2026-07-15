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
  passesForLevel,
  PASS_GATE_MAP,
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
 * deslop() 的选项。deslop() 和 cleanupPass() 共用此类型，避免内联重复定义。
 * IPC 层解析后注入 whitelist/bannedWords/textOverrides/styleContext。
 */
export interface DeslopOptions {
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
  /** 透传到 LLM 调用的 meta（用量统计/归属），缺省 = 仅 feature:deslop */
  meta?: Record<string, unknown>
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
    opts: DeslopOptions = {}
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
    const passes = passesForLevel(level)
    const emit = (t: string): void => opts.onToken?.(t)
    emit(`\n🔍 Phase 1-2：扫描完成，诊断为${levelName(level)}（blocking ${report.counts.blocking} / advisory ${report.counts.advisory}）\n`)
    emit(`   总处理 Gate：${gates.join(' ')} | 三遍法：${passes.length} 遍\n`)
    if (opts.styleContext?.genre || opts.styleContext?.style) {
      const bits: string[] = []
      if (opts.styleContext.genre) bits.push(`题材=${opts.styleContext.genre}`)
      if (opts.styleContext.style?.identifiedStyle) bits.push(`文风=${opts.styleContext.style.identifiedStyle}`)
      emit(`   风格语境：${bits.join(' ')}\n`)
    }

    const effectiveSystemPrompt = opts.textOverrides?.systemPrompt ?? DESLOP_SYSTEM_PROMPT
    const allChangeSummary: string[] = []
    let finalText = text
    let lastReport = report

    if (report.counts.blocking > 0 || report.counts.advisory > 0) {
      // =====================================================
      // Phase 3：三遍法编排（按 passesForLevel 顺序跑每一遍）
      // 每遍只处理「该 Pass 的 Gate 范围」∩「gatesForLevel 总范围」∩「该遍开始时仍命中的 finding」
      // =====================================================
      const totalPasses = passes.length
      for (let pi = 0; pi < passes.length; pi++) {
        const passNum = passes[pi]
        const passGates = PASS_GATE_MAP[passNum].filter((g) => gates.includes(g))
        if (passGates.length === 0) continue

        emit(`\n✍️ Pass ${pi + 1}/${totalPasses}（Gate ${passGates.join(' ')}）：改写（${levelName(level)}，删除比例上限 ${deleteLimitPct(level)}%）...\n`)

        // 本遍开始时扫描当前文本，过滤出该遍 Gate 范围内的命中 finding
        const passScan = await this.scan(finalText, {
          whitelist: opts.whitelist,
          bannedWords: opts.bannedWords
        })
        const passFindings = passScan.findings.filter((f) => passGates.includes(f.gate))
        if (passFindings.length === 0) {
          emit(`   ✔️ 本遍 Gate 无命中项，跳过。\n`)
          lastReport = passScan
          continue
        }

        // 调 LLM 改写（只处理本遍的 Gate）
        const prompt = buildDeslopPrompt(finalText, level, passFindings, passGates, opts.styleContext, {
          textOverrides: opts.textOverrides?.gates,
          bannedWords: opts.bannedWords
        })
        const llmOutput = await this.llm.generateStream(prompt, {
          systemPrompt: effectiveSystemPrompt,
          maxTokens: 12288,
          meta: { feature: `deslop:pass${passNum}`, ...opts.meta },
          onToken: emit
        })
        const rewritten = extractRewritten(llmOutput)
        const passChanges = extractChangeSummary(llmOutput)
        if (passChanges.length > 0) {
          allChangeSummary.push(...passChanges)
          emit(`\n   改写完成：${passChanges.length} 处改动\n`)
          emit('   改动明细：\n')
          for (const c of passChanges) emit(`   ${c}\n`)
        } else {
          emit(`\n   改写完成\n`)
        }

        // Phase 3.5：标点兜底（每遍改写后都跑，清理 LLM 可能引入的破折号/省略号）
        const normalized = normalizePunctuation(rewritten)
        const totalNormChanges =
          normalized.changes.emDash +
          normalized.changes.dash +
          normalized.changes.doubleHyphen +
          normalized.changes.ellipsis +
          normalized.changes.singleEllipsis
        if (totalNormChanges > 0) {
          emit(`   🧹 标点兜底：修正 ${totalNormChanges} 处（破折号 ${normalized.changes.emDash + normalized.changes.dash} / 省略号 ${normalized.changes.ellipsis + normalized.changes.singleEllipsis}）\n`)
        }
        finalText = normalized.text

        // Phase 3.6：本遍二次清理（复扫后对本遍 Gate 范围内剩余 blocking 再改，上限 2 轮）
        finalText = await this.cleanupPass(
          finalText,
          passGates,
          passNum,
          level,
          effectiveSystemPrompt,
          opts,
          emit
        )

        // 记录最后一次复扫结果（供 Phase 4 报告）
        lastReport = await this.scan(finalText, { bannedWords: opts.bannedWords })
      }
    } else {
      emit(`\n✔️ 无 AI 味问题，跳过改写。\n`)
    }

    // Phase 4：报告
    const afterWords = countWords(finalText)
    const deleteRatio = beforeWords > 0 ? 1 - afterWords / beforeWords : 0
    const remainingBlocking = lastReport.findings.filter((f) => f.severity === 'blocking')
    if (remainingBlocking.length > 0) {
      emit(`\n⚠️ 复扫后仍剩 ${remainingBlocking.length} 处 blocking（建议人工复核）：\n`)
      remainingBlocking.slice(0, 5).forEach((f) => emit(`   - 第${f.line}行 [${f.type}]: ${f.excerpt}\n`))
    }
    emit(`\n📊 Phase 4：润色完成（${beforeWords} -> ${afterWords} 字，删除比例 ${(deleteRatio * 100).toFixed(1)}%）\n`)

    return {
      rewritten: finalText,
      processedGates: gates as DeslopResult['processedGates'],
      beforeWords,
      afterWords,
      deleteRatio,
      remainingFindings: lastReport.findings,
      changeSummary: allChangeSummary
    }
  }

  /**
   * 单遍二次清理（Phase 3.6）：复扫后对本遍 Gate 范围内剩余 blocking 再改，上限 2 轮。
   * 与 buildCleanupPrompt 复用：只处理「本遍 Gate 范围」内的 blocking，不跨 Gate 清理。
   */
  private async cleanupPass(
    text: string,
    passGates: string[],
    passNum: number,
    level: DeslopLevel,
    effectiveSystemPrompt: string,
    opts: Pick<DeslopOptions, 'styleContext' | 'textOverrides' | 'bannedWords' | 'whitelist' | 'meta'>,
    emit: (t: string) => void
  ): Promise<string> {
    const MAX_CLEANUP_ROUNDS = 2
    let result = text
    let round = 0
    // 复扫，只看本遍 Gate 范围内的 blocking
    let scan = await this.scan(result, { whitelist: opts.whitelist, bannedWords: opts.bannedWords })
    let remaining = scan.findings.filter((f) => f.severity === 'blocking' && passGates.includes(f.gate))
    if (remaining.length === 0) {
      emit(`   ✔️ 本遍复扫无 blocking 残留，跳过二次清理。\n`)
      return result
    }
    while (remaining.length > 0 && round < MAX_CLEANUP_ROUNDS) {
      round += 1
      emit(`   🔄 二次清理 ${round}/${MAX_CLEANUP_ROUNDS}（Pass${passNum} 剩余 ${remaining.length} 处 blocking）...\n`)
      const cleanupPrompt = buildCleanupPrompt(
        result,
        level,
        remaining,
        round,
        opts.styleContext,
        { textOverrides: opts.textOverrides?.gates, bannedWords: opts.bannedWords }
      )
      const cleanupOutput = await this.llm.generateStream(cleanupPrompt, {
        systemPrompt: effectiveSystemPrompt,
        maxTokens: 12288,
        meta: { feature: `deslop:cleanup:pass${passNum}:${round}`, ...opts.meta },
        onToken: emit
      })
      const cleanupRewritten = extractRewritten(cleanupOutput)
      const cleanupChanges = extractChangeSummary(cleanupOutput)
      if (cleanupChanges.length > 0) {
        emit(`   第 ${round} 轮清理改动：${cleanupChanges.length} 处\n`)
      }
      // 标点兜底
      const reNorm = normalizePunctuation(cleanupRewritten)
      result = reNorm.text
      // 复扫判断是否还需下一轮
      scan = await this.scan(result, { whitelist: opts.whitelist, bannedWords: opts.bannedWords })
      remaining = scan.findings.filter((f) => f.severity === 'blocking' && passGates.includes(f.gate))
    }
    if (remaining.length > 0) {
      emit(`   ⚠️ Pass${passNum} 二次清理后仍剩 ${remaining.length} 处 blocking\n`)
    } else {
      emit(`   ✔️ Pass${passNum} blocking 已清零（${round} 轮）\n`)
    }
    return result
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
