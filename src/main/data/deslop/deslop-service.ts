import { promises as fs } from 'fs'
import { join } from 'path'
import { LlmService } from '../llm-service'
import { scanAiPatterns } from './check-ai-patterns'
import { scanDegeneration } from './check-degeneration'
import { normalizePunctuation, countPunctuationIssues } from './normalize-punctuation'
import { ALL_BANNED_WORDS, PARALLELISM_PATTERNS } from './banned-words'
import {
  DESLOP_SYSTEM_PROMPT,
  buildDeslopPrompt,
  buildCleanupPrompt,
  gatesForLevel,
  expandGatesForFindings,
  passesForGates,
  PASS_GATE_MAP,
  extractRewritten,
  extractChangeSummary
} from '../skill-prompts/deslop/anti-ai-methods'
import { countWords } from '../words'
import { summarizeTextDiff } from '../../../shared/text-diff'
import { guardLanguageLeak } from './language-guard'
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
  /** 用户取消信号：透传到每一遍 LLM 改写/清理调用 */
  signal?: AbortSignal
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

  /**
   * @param whitelist 项目级豁免词（IPC 层按 projectId 解析后传入）
   * @param isTail 本段是否是全文结尾（分块改写时只有最后一块是）。
   *   false 时不按「章末」升级 Gate F 升华句，也不做截断检测——否则每个分块的
   *   末尾都会被误判成章末/被截断。缺省 true（整篇扫描）。
   */
  async scan(
    text: string,
    opts: { whitelist?: Set<string>; bannedWords?: string[]; isTail?: boolean } = {}
  ): Promise<DeslopScanReport> {
    const isTail = opts.isTail ?? true
    const aiFindings = scanAiPatterns(text, {
      whitelist: opts.whitelist,
      bannedWords: opts.bannedWords,
      isTail
    })
    const degenFindings = scanDegeneration(text, { isTail })
    const findings = [...aiFindings, ...degenFindings]
    const counts = {
      blocking: findings.filter((f) => f.severity === 'blocking').length,
      advisory: findings.filter((f) => f.severity === 'advisory').length
    }
    const wordCount = countWords(text)
    const metrics = this.computeMetrics(findings, wordCount)
    return { findings, counts, metrics, wordCount }
  }

  /* =========================================================
     Phase 2：诊断分级
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

  /**
   * 分块编排：正文不超长时直接跑一遍完整流程；超长时按段落切块逐块处理再合并。
   *
   * 单次 LLM 调用要吐出「改写后正文 +【改动说明】」，超过 tokensForDeslop 的上限就会被截断，
   * 截断结果又会被 acceptRewrite 拒绝——表现为「长文点了润色什么都没发生」。切块是唯一出路。
   */
  async deslop(text: string, opts: DeslopOptions = {}): Promise<DeslopResult> {
    const emit = (t: string): void => opts.onToken?.(t)
    const chunks = splitForDeslop(text)
    if (chunks.length <= 1) return this.deslopChunk(text, opts, true)

    // 长文一跑就是几十次 LLM 调用，先把规模摆出来，用户可以立刻点停止
    emit(
      `\n📚 正文 ${countWords(text)} 字，超出单次改写上限（${CHUNK_MAX_WORDS} 字），` +
        `按段落边界切成 ${chunks.length} 块依次处理。\n` +
        `   规模预估：每块最多 ${MAX_LLM_CALLS_PER_CHUNK} 次 LLM 调用（3 遍 × 每遍最多 1 改写 + 2 清理），` +
        `本次最多 ${chunks.length * MAX_LLM_CALLS_PER_CHUNK} 次。随时可点「停止」。\n`
    )
    // 切块以行为最小单位（行内切会把一句台词劈开），所以单行本身超长时切不动。
    // 不静默：这种块几乎必然被模型截断、进而被 acceptRewrite 拒绝，得让用户知道为什么白跑。
    const oversized = chunks.filter((c) => countWords(c.text) > CHUNK_MAX_WORDS)
    if (oversized.length > 0) {
      emit(
        `   ⚠️ 其中 ${oversized.length} 块含超长单行（最大 ${Math.max(...oversized.map((c) => countWords(c.text)))} 字），` +
          `切块以行为单位切不开。这些块可能超出模型单次输出上限而被拒绝，建议先在对应位置手动分段。\n`
      )
    }

    const results: DeslopResult[] = []
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      emit(
        `\n══════ 第 ${i + 1}/${chunks.length} 块（原文第 ${c.startLine} 行起，${countWords(c.text)} 字）══════\n`
      )
      try {
        // 只有最后一块是真正的全文结尾：其余块不按「章末」升级 Gate F、不做截断检测
        results.push(await this.deslopChunk(c.text, opts, i === chunks.length - 1))
      } catch (err) {
        if (!isUserAbort(err)) throw err
        // 用户取消：已完成的块不能白跑。未处理的块按原文补齐后照常返回，
        // 结果仍要用户在 diff 面板点「应用」才落盘，不会偷偷写入半成品。
        emit(
          `\n🛑 已取消：保留前 ${i} 块的改写结果，其余 ${chunks.length - i} 块保持原文。\n` +
            `   仍需在下方确认改动后点「应用」才会写回正文。\n`
        )
        for (let j = i; j < chunks.length; j++) {
          results.push(await this.unchangedChunkResult(chunks[j].text, opts, j === chunks.length - 1))
        }
        return mergeChunkResults(text, chunks, results)
      }
    }
    const merged = mergeChunkResults(text, chunks, results)
    emit(
      `\n📊 分块合并完成：${merged.beforeWords} -> ${merged.afterWords} 字，` +
        `改动 ${merged.changeSummary.length} 条，剩余问题 ${merged.remainingFindings.length} 处\n`
    )
    return merged
  }

  /**
   * 取消后未处理的块：正文原样，但仍照实扫描一遍。
   * 不扫的话合并报告里「剩余问题」会漏掉这些块，看起来像已经改干净了。
   */
  private async unchangedChunkResult(
    text: string,
    opts: DeslopOptions,
    isTail: boolean
  ): Promise<DeslopResult> {
    const scan = await this.scan(text, {
      whitelist: opts.whitelist,
      bannedWords: opts.bannedWords,
      isTail
    })
    const words = countWords(text)
    return {
      rewritten: text,
      processedGates: [],
      beforeWords: words,
      afterWords: words,
      deleteRatio: 0,
      remainingFindings: scan.findings,
      changeSummary: []
    }
  }

  /**
   * 单块改写（Phase 1-4 完整流程）。
   * @param isTail 本块是否是全文结尾；影响 Gate F 章末升级与截断检测
   */
  private async deslopChunk(
    text: string,
    opts: DeslopOptions,
    isTail: boolean
  ): Promise<DeslopResult> {
    const beforeWords = countWords(text)

    // Phase 1 扫描（用户配置的禁用词表优先，否则内置默认）
    const report = await this.scan(text, {
      whitelist: opts.whitelist,
      bannedWords: opts.bannedWords,
      isTail
    })

    // Phase 2 分级
    const level = opts.levelOverride ?? this.classify(report.metrics, report.counts)
    const baseGates = gatesForLevel(level)
    // 分级决定"改多狠"（删除比例上限），不决定"哪些问题配被修"：
    // 只含章末升华（F）或工程词泄漏（G）的正文会判为 mild，若不扩展就一次 LLM 都不调，
    // 正文原样返回却报"仍剩 N 处 blocking"；对话标签单一化（E，只产 advisory）则永远没人管。
    // 没命中的 Gate 在下面的 Pass 循环里本来就会跳过，所以扩展不会凭空多调 LLM。
    const gates = expandGatesForFindings(baseGates, report.findings.map((f) => f.gate))
    const passes = passesForGates(gates)
    const emit = (t: string): void => opts.onToken?.(t)
    emit(`\n🔍 Phase 1-2：扫描完成，诊断为${levelName(level)}（blocking ${report.counts.blocking} / advisory ${report.counts.advisory}）\n`)
    emit(`   总处理 Gate：${gates.join(' ')} | 三遍法：${passes.length} 遍\n`)
    const extraGates = gates.filter((g) => !baseGates.includes(g))
    if (extraGates.length > 0) {
      emit(`   ⬆️ Gate ${extraGates.join(' ')} 有命中，已加入本次处理范围（超出${levelName(level)}默认范围）\n`)
    }
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
          bannedWords: opts.bannedWords,
          isTail
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
          maxTokens: tokensForDeslop(finalText),
          meta: { feature: `deslop:pass${passNum}`, ...opts.meta },
          onToken: emit,
          signal: opts.signal
        })
        let rewritten = extractRewritten(llmOutput)

        // 可用性护栏：寒暄/拒答/截断的输出一律不落到正文，保留改写前文本继续下一遍
        const verdict = acceptRewrite(finalText, llmOutput, rewritten, level)
        if (!verdict.ok) {
          emit(`\n   ⛔ 本遍改写结果被拒绝（${verdict.reason}），保留改写前正文。\n`)
          allChangeSummary.push(`- [已拒绝] Pass${passNum} 改写结果不可用：${verdict.reason}`)
          lastReport = passScan
          continue
        }

        const passChanges = extractChangeSummary(llmOutput)
        if (passChanges.length > 0) {
          allChangeSummary.push(...passChanges)
          emit(`\n   改写完成：${passChanges.length} 处改动\n`)
          emit('   改动明细：\n')
          for (const c of passChanges) emit(`   ${c}\n`)
        } else {
          emit(`\n   改写完成\n`)
        }

        // 语言守卫：拦截「他→He」/整句英译等越权翻译
        const langGuard = guardLanguageLeak(finalText, rewritten)
        if (langGuard.revertedUnits > 0) {
          rewritten = langGuard.text
          allChangeSummary.push(...langGuard.notes)
          emit(`   🚫 语言守卫：回退 ${langGuard.revertedUnits} 处英文化改写\n`)
          for (const n of langGuard.notes) emit(`   ${n}\n`)
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
        const cleaned = await this.cleanupPass(
          finalText,
          passGates,
          passNum,
          level,
          effectiveSystemPrompt,
          opts,
          emit,
          isTail
        )
        finalText = cleaned.text
        if (cleaned.changes.length > 0) {
          allChangeSummary.push(...cleaned.changes)
        }

        // 记录最后一次复扫结果（供 Phase 4 报告）——必须带 whitelist，否则豁免词会以"剩余问题"回到报告里
        lastReport = await this.scan(finalText, {
          whitelist: opts.whitelist,
          bannedWords: opts.bannedWords,
          isTail
        })
      }
    } else {
      emit(`\n✔️ 无 AI 味问题，跳过改写。\n`)
    }

    // extractRewritten 会 trim；把原文首尾空白还回去，否则分块时块边界的空行会被吃掉
    finalText = restoreEdgeWhitespace(text, finalText)

    // Phase 4：报告
    // LLM 常漏写【改动说明】或格式不规范 → 文本已变但 changeSummary 为空。
    // 用段级自动 diff 兜底，保证 UI 总能提示「改了什么」。
    if (finalText !== text && allChangeSummary.length === 0) {
      const autoSummary = summarizeTextDiff(text, finalText)
      if (autoSummary.length > 0) {
        allChangeSummary.push(...autoSummary)
        emit(`\n📝 改动说明缺失，已自动对比生成 ${autoSummary.length} 条：\n`)
        for (const c of autoSummary.slice(0, 10)) emit(`   ${c}\n`)
        if (autoSummary.length > 10) emit(`   …共 ${autoSummary.length} 条\n`)
      }
    } else if (finalText !== text && allChangeSummary.length > 0) {
      emit(`\n📝 改动明细共 ${allChangeSummary.length} 条\n`)
    } else if (finalText === text) {
      emit(`\n📝 正文与改写前一致（无实质改动）\n`)
    }

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
    opts: Pick<DeslopOptions, 'styleContext' | 'textOverrides' | 'bannedWords' | 'whitelist' | 'meta' | 'signal'>,
    emit: (t: string) => void,
    isTail: boolean
  ): Promise<{ text: string; changes: string[] }> {
    const MAX_CLEANUP_ROUNDS = 2
    let result = text
    let round = 0
    const changes: string[] = []
    // 复扫，只看本遍 Gate 范围内的 blocking
    let scan = await this.scan(result, {
      whitelist: opts.whitelist,
      bannedWords: opts.bannedWords,
      isTail
    })
    let remaining = scan.findings.filter((f) => f.severity === 'blocking' && passGates.includes(f.gate))
    if (remaining.length === 0) {
      emit(`   ✔️ 本遍复扫无 blocking 残留，跳过二次清理。\n`)
      return { text: result, changes }
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
        maxTokens: tokensForDeslop(result),
        meta: { feature: `deslop:cleanup:pass${passNum}:${round}`, ...opts.meta },
        onToken: emit,
        signal: opts.signal
      })
      let cleanupRewritten = extractRewritten(cleanupOutput)
      const verdict = acceptRewrite(result, cleanupOutput, cleanupRewritten, level)
      if (!verdict.ok) {
        emit(`   ⛔ 第 ${round} 轮清理结果被拒绝（${verdict.reason}），保留上一版正文并停止清理。\n`)
        changes.push(`- [已拒绝] Pass${passNum} 第 ${round} 轮清理结果不可用：${verdict.reason}`)
        break
      }
      const cleanupChanges = extractChangeSummary(cleanupOutput)
      if (cleanupChanges.length > 0) {
        changes.push(...cleanupChanges)
        emit(`   第 ${round} 轮清理改动：${cleanupChanges.length} 处\n`)
        for (const c of cleanupChanges) emit(`   ${c}\n`)
      }
      const cleanupLang = guardLanguageLeak(result, cleanupRewritten)
      if (cleanupLang.revertedUnits > 0) {
        cleanupRewritten = cleanupLang.text
        changes.push(...cleanupLang.notes)
        emit(`   🚫 语言守卫：回退 ${cleanupLang.revertedUnits} 处英文化改写\n`)
      }
      // 标点兜底
      const reNorm = normalizePunctuation(cleanupRewritten)
      result = reNorm.text
      // 复扫判断是否还需下一轮
      scan = await this.scan(result, {
        whitelist: opts.whitelist,
        bannedWords: opts.bannedWords,
        isTail
      })
      remaining = scan.findings.filter((f) => f.severity === 'blocking' && passGates.includes(f.gate))
    }
    if (remaining.length > 0) {
      emit(`   ⚠️ Pass${passNum} 二次清理后仍剩 ${remaining.length} 处 blocking\n`)
    } else {
      emit(`   ✔️ Pass${passNum} blocking 已清零（${round} 轮）\n`)
    }
    return { text: result, changes }
  }

  /* =========================================================
     私有：指标计算 + 白名单
     ========================================================= */

  /** 只算 classify() 真正读的两项；其余问题由 findings 逐条呈现，不需要聚合数字 */
  private computeMetrics(findings: DeslopFinding[], wordCount: number): DeslopMetrics {
    const bannedHits = findings.filter((f) => f.type === 'banned-word').length
    return {
      bannedWordDensity: wordCount > 0 ? (bannedHits / wordCount) * 1000 : 0,
      parallelismCount: findings.filter((f) => f.type === 'parallelism').length
    }
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

/**
 * 单块最大字数。超过就切块——tokensForDeslop 在此之上会顶到 DESLOP_MAX_MAX_TOKENS，
 * 输出装不下「正文 +【改动说明】」必被截断。
 * 取 10000 是为了让正常章节（上限 MAX_TARGET_WORDS = 8000 字）永远走单块路径，行为不变；
 * 只有文本模式里粘进来的超长内容才会被切。
 */
export const CHUNK_MAX_WORDS = 10_000

/**
 * 单块最坏情况下的 LLM 调用数：3 遍 × 每遍（1 次改写 + 最多 2 轮二次清理）。
 * 只用于开跑前给用户报规模，不参与任何控制流。
 */
const MAX_LLM_CALLS_PER_CHUNK = 9

/** 用户主动取消（llm-service 在 opts.signal 已 abort 时抛 LLM_ABORTED），区别于超时/截断 */
function isUserAbort(err: unknown): boolean {
  return err instanceof Error && err.message === 'LLM_ABORTED'
}

/** 一个待改写分块：正文 + 它在原文里的起始行号（1-based），用于把行号引用还原成全局 */
export interface DeslopChunk {
  text: string
  startLine: number
}

/**
 * 按行切块，优先在空行（段落边界）断开，绝不从行中间切断——
 * 对话独立成行，从行内切会把一句台词劈成两块。
 */
export function splitForDeslop(text: string, maxWords = CHUNK_MAX_WORDS): DeslopChunk[] {
  if (countWords(text) <= maxWords) return [{ text, startLine: 1 }]

  // 只按 '\n' 切、用 '\n' 拼回：'\r' 留在行尾，未改写的块能逐字还原
  const lines = text.split('\n')
  const chunks: DeslopChunk[] = []
  let buf: string[] = []
  let bufWords = 0
  let startLine = 1

  for (const line of lines) {
    const w = countWords(line)
    if (bufWords > 0 && bufWords + w > maxWords) {
      // 回看最近的空行作为段落边界；只回退最后 20%，避免切出极小的块
      let cut = buf.length
      const minCut = Math.floor(buf.length * 0.8)
      for (let i = buf.length - 1; i >= minCut; i--) {
        if (buf[i].trim() === '') {
          cut = i
          break
        }
      }
      const head = buf.slice(0, cut)
      const tail = buf.slice(cut)
      chunks.push({ text: head.join('\n'), startLine })
      startLine += head.length
      buf = tail
      bufWords = tail.reduce((n, l) => n + countWords(l), 0)
    }
    buf.push(line)
    bufWords += w
  }
  if (buf.length > 0) chunks.push({ text: buf.join('\n'), startLine })
  return chunks
}

/**
 * 合并分块结果：拼回正文、把块内行号还原成全文行号、按 A-G 顺序合并 Gate。
 *
 * 两种行号用两个不同的偏移，别混：
 * - **changeSummary 的「第N行」**：LLM 引用的是它收到的**原文**行号 → 按 chunk.startLine 偏移。
 * - **remainingFindings 的 line**：扫的是**改写后**文本 → 必须按已拼接的改写结果累计行数偏移。
 *   用原文行号会在前面的块行数变了之后整体错位（改写压行时甚至指到文本末尾之外）。
 *
 * 自动 diff 兜底产生的「第N段」是块内段号，无法换算成全文段号，
 * 因此给每条改动说明都加「[第i/N块]」前缀标明范围。
 */
export function mergeChunkResults(
  original: string,
  chunks: DeslopChunk[],
  results: DeslopResult[]
): DeslopResult {
  const gateSet = new Set<string>()
  const changeSummary: string[] = []
  const remainingFindings: DeslopFinding[] = []

  // 边拼边记：每块正文在合并结果里的起始行号（1-based）
  let acc = ''
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (i > 0) acc += '\n'
    const startLineInMerged = acc.split('\n').length
    acc += r.rewritten

    for (const g of r.processedGates) gateSet.add(g)
    for (const c of r.changeSummary) {
      changeSummary.push(tagChunkSummary(c, i + 1, results.length, chunks[i].startLine - 1))
    }
    for (const f of r.remainingFindings) {
      remainingFindings.push({ ...f, line: f.line + startLineInMerged - 1 })
    }
  }
  const rewritten = acc

  const beforeWords = countWords(original)
  const afterWords = countWords(rewritten)
  return {
    rewritten,
    processedGates: expandGatesForFindings([], gateSet) as DeslopResult['processedGates'],
    beforeWords,
    afterWords,
    deleteRatio: beforeWords > 0 ? 1 - afterWords / beforeWords : 0,
    remainingFindings,
    changeSummary
  }
}

/**
 * 把原文首尾的空白（换行）原样还给改写结果。
 *
 * extractRewritten 会 trim 掉 LLM 输出的首尾空白，分块时这会吃掉块边界上的空行——
 * 两个自然段被悄悄并成一段。非分块路径同样受益：用户正文末尾的换行不再被吞。
 */
function restoreEdgeWhitespace(original: string, rewritten: string): string {
  if (original === rewritten) return rewritten
  const lead = /^\s*/.exec(original)?.[0] ?? ''
  const trail = /\s*$/.exec(original)?.[0] ?? ''
  return lead + rewritten.replace(/^\s+/, '').replace(/\s+$/, '') + trail
}

/** 把一条块内改动说明的「第N行」加上偏移，并标注它属于第几块 */
function tagChunkSummary(entry: string, index: number, total: number, lineOffset: number): string {
  const shifted = entry.replace(/第(\d+)行/g, (_m, n: string) => `第${Number(n) + lineOffset}行`)
  const body = shifted.replace(/^-\s*/, '')
  return `- [第${index}/${total}块] ${body}`
}

/** 改写调用的 token 下限（短章节沿用原值，保证行为不变） */
const DESLOP_MIN_MAX_TOKENS = 12288
/** token 上限，防止有人把整本书粘进来时算出荒唐的请求值 */
const DESLOP_MAX_MAX_TOKENS = 32768

/**
 * 按待改写正文长度反算本次生成的 token 上限。
 *
 * 输出 = 改写后正文（≈ 原文长度，删除比例上限 35%）+【改动说明】（逐条引用原句/改后，
 * 命中密集时能和正文同量级）。中文 1 字 ≈ 1.7 token（与 write-service.tokensForWords 同口径），
 * 再乘 1.6 给改动说明留额度。
 *
 * 原先固定 12288：2500 字章节够用，5000 字以上必被截断。截断输出会被 acceptRewrite 拒绝，
 * 对用户表现为「长章节点了润色什么都没发生」。
 */
function tokensForDeslop(text: string): number {
  const needed = Math.ceil(countWords(text) * 1.7 * 1.6)
  return Math.min(DESLOP_MAX_MAX_TOKENS, Math.max(DESLOP_MIN_MAX_TOKENS, needed))
}

/** LLM 把「寒暄开场白」当正文返回的常见开头（仅在缺 【改写后】 标记时检查） */
const CHATTER_HEAD_RE =
  /^(好的|好[，,]|明白了?|收到|当然|没问题|以下是|下面是|这是(改写|修改)|我(来|将|会)|遵命|抱歉|很抱歉|对不起)/

/**
 * 拒答/元信息泄漏。只在「原文没有、改写后凭空冒出来」时判定，
 * 因为 AI 伴侣/系统流题材里「作为一个人工智能」可能是合法台词
 * （check-degeneration 的 findPlaceholders 对对话行也做了同样豁免）。
 */
const REFUSAL_RE =
  /(作为(一个)?(AI|人工智能|语言模型))|我无法(继续|完成|提供|帮)|抱歉[，,]?我(不能|无法)/

/** 超出删除比例上限后再放宽的容差（LLM 自己算的比例常有偏差，留 10 个百分点） */
const DELETE_RATIO_TOLERANCE = 0.1

/**
 * 比例护栏的最小样本长度（字）。
 * 短片段（humanizeSegment 传来的命中句、几行对话）删掉一行就轻松超过 25%，
 * 按比例判会把合法改写全拒掉；短文本只用下面的「灾难性截断」兜底。
 */
const RATIO_GUARD_MIN_WORDS = 120

/** 任何长度都适用的灾难性截断阈值：留存不足原文四成一律拒绝 */
const CATASTROPHIC_KEEP_RATIO = 0.4

/**
 * 判断一遍改写/清理的输出能否落到正文。
 *
 * 拒绝三类不可用输出（拒绝时调用方保留改写前文本）：
 * 1. 空结果
 * 2. 缺【改写后】标记且整段像寒暄/拒答——extractRewritten 此时会原样返回整个回复，
 *    直接采用会把"好的，我来帮你改写："写进章节正文
 * 3. 删除比例超过该分级上限 + 容差——多为输出被 maxTokens 截断，采用会造成正文丢失
 */
function acceptRewrite(
  before: string,
  llmOutput: string,
  candidate: string,
  level: DeslopLevel
): { ok: true } | { ok: false; reason: string } {
  const text = candidate.trim()
  if (!text) return { ok: false, reason: '改写结果为空' }

  const hasMarker = /【改写后】/.test(llmOutput)
  if (REFUSAL_RE.test(text) && !REFUSAL_RE.test(before)) {
    return { ok: false, reason: '结果含拒答/元信息' }
  }
  if (!hasMarker && CHATTER_HEAD_RE.test(text)) {
    return { ok: false, reason: '缺【改写后】标记且开头像寒暄，疑似非正文' }
  }

  const beforeWords = countWords(before)
  if (beforeWords > 0) {
    const keepRatio = countWords(text) / beforeWords
    if (keepRatio < CATASTROPHIC_KEEP_RATIO) {
      return {
        ok: false,
        reason: `只剩原文 ${(keepRatio * 100).toFixed(1)}%，疑似输出被截断`
      }
    }
    const limit = deleteLimitPct(level) / 100 + DELETE_RATIO_TOLERANCE
    if (beforeWords >= RATIO_GUARD_MIN_WORDS && 1 - keepRatio > limit) {
      return {
        ok: false,
        reason: `删除比例 ${((1 - keepRatio) * 100).toFixed(1)}% 超上限 ${(limit * 100).toFixed(0)}%`
      }
    }
  }
  return { ok: true }
}

function levelName(level: DeslopLevel): string {
  return level === 'mild' ? '轻度' : level === 'moderate' ? '中度' : '重度'
}

function deleteLimitPct(level: DeslopLevel): number {
  return level === 'mild' ? 15 : level === 'moderate' ? 25 : 35
}

// re-export 供测试
export { ALL_BANNED_WORDS, PARALLELISM_PATTERNS, countPunctuationIssues }
