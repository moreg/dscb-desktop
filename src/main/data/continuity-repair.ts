import { findJsonObject } from '../../shared/json-extract'
import { assertNovelProse } from './agent-meta-detect'
import { diffUnits, splitUnits } from '../../shared/text-diff'

const REPAIR_ROUNDS_BEFORE_BACKOFF = 3
const MAX_LOCAL_REPLACEMENTS = 6
const MAX_SOURCE_PASSAGE = 300
const MAX_REPAIRED_PASSAGE = 400
export type RepairScope = 'local' | 'scene' | 'structure'

/** Guard findings contain three lines each: kind/message, chapter evidence, reference. */
export function splitLongformFindings(issue: string): string[] {
  const starts = [...issue.matchAll(/^(?:章节边界|主线|人物知情|跨章道具|长期剧情线)：/gm)]
  if (!starts.length) return [issue]
  const findings = starts.map((match, index) => issue.slice(match.index!, starts[index + 1]?.index ?? issue.length).trim())
  return findings.every(item => /(?:^|\n)本章：/.test(item) && /(?:^|\n)依据：/.test(item)) ? findings : [issue]
}

function localRepairLimits(length: number): { source: number; replacement: number } {
  return {
    // Short excerpts still allow a sentence repair, but never a wholesale replacement.
    source: Math.max(0, Math.min(Math.ceil(length * 0.9) - 1, 800, Math.max(120, Math.floor(length * 0.2)))),
    replacement: Math.min(1000, Math.max(180, Math.floor(length * 0.25)))
  }
}

/** Several individually small edits can still amount to a large chapter revision. */
export function accumulatedRepairIsBroad(original: string, candidate: string): boolean {
  const changes = diffUnits(splitUnits(original), splitUnits(candidate))
  const limits = localRepairLimits(original.length)
  let removed = 0, added = 0
  for (const change of changes) {
    let start = 0, end = 0
    while (start < change.before.length && start < change.after.length && change.before[start] === change.after[start]) start++
    while (end < change.before.length - start && end < change.after.length - start &&
      change.before[change.before.length - 1 - end] === change.after[change.after.length - 1 - end]) end++
    removed += change.before.length - start - end
    added += change.after.length - start - end
  }
  return changes.length > MAX_LOCAL_REPLACEMENTS || removed > limits.source || added > limits.replacement
}

/** Unique, non-overlapping replacements preserve everything outside the faulty passages. */
export function applyContinuityReplacements(content: string, raw: string, scope: RepairScope = 'local'): string {
  const parsed = findJsonObject(raw)
  if (!Array.isArray(parsed?.replacements) || !parsed.replacements.length) {
    throw new Error('衔接修复未返回有效的局部替换')
  }
  if (parsed.replacements.length > MAX_LOCAL_REPLACEMENTS) throw new Error(`衔接修复超过 ${MAX_LOCAL_REPLACEMENTS} 处，须合并为必要的局部纠错，不得顺带润色其他句段`)
  const limits = scope === 'local' ? localRepairLimits(content.length) : scope === 'scene'
    ? { source: Math.min(2400, Math.floor(content.length * 0.6)), replacement: Math.min(3000, Math.floor(content.length * 0.8)) }
    : { source: content.length, replacement: Math.max(2000, content.length * 2) }
  const maxSource = scope === 'local' ? MAX_SOURCE_PASSAGE : scope === 'scene' ? 1200 : content.length
  const maxReplacement = scope === 'local' ? MAX_REPAIRED_PASSAGE : scope === 'scene' ? 1500 : Math.max(2000, content.length * 2)
  const edits: Array<{ start: number; end: number; after: string }> = []
  let removed = 0
  let added = 0
  for (const entry of parsed.replacements) {
    if (typeof entry?.before !== 'string' || typeof entry.after !== 'string' || !entry.before.trim() || (scope !== 'structure' && !entry.after.trim())) {
      throw new Error('衔接修复替换原句或新句为空')
    }
    const start = content.indexOf(entry.before)
    if (start < 0 || content.indexOf(entry.before, start + 1) >= 0) throw new Error('衔接修复原句无法唯一定位')
    const end = start + entry.before.length
    if (edits.some(edit => start < edit.end && end > edit.start)) throw new Error('衔接修复替换范围重叠')
    if (entry.before === entry.after) throw new Error('衔接修复没有实际改动')
    // Models sometimes include a long, identical surrounding passage for locating
    // the edit. Count only the changed span, while retaining the full unique anchor.
    let prefix = 0
    while (prefix < entry.before.length && prefix < entry.after.length && entry.before[prefix] === entry.after[prefix]) prefix++
    let suffix = 0
    while (suffix < entry.before.length - prefix && suffix < entry.after.length - prefix &&
      entry.before[entry.before.length - 1 - suffix] === entry.after[entry.after.length - 1 - suffix]) suffix++
    const changedBefore = entry.before.length - prefix - suffix
    const changedAfter = entry.after.length - prefix - suffix
    if (changedBefore > maxSource || changedAfter > maxReplacement) {
      throw new Error(`衔接修复单处范围过大：实际改动原文 ${changedBefore}/${maxSource} 字符，新文 ${changedAfter}/${maxReplacement} 字符；须将相隔的冲突拆成多处分别替换，保留中间未变正文`)
    }
    if (entry.after.trim()) assertNovelProse(entry.after)
    edits.push({ start, end, after: entry.after })
    removed += changedBefore
    added += changedAfter
  }
  if (removed > limits.source || added > limits.replacement) {
    throw new Error(`衔接修复改动范围过大，须缩小到矛盾句段：原文共 ${removed}/${limits.source} 字符，新文共 ${added}/${limits.replacement} 字符`)
  }
  let candidate = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    candidate = candidate.slice(0, edit.start) + edit.after + candidate.slice(edit.end)
  }
  if (!candidate.trim() || (scope === 'local' && (candidate.length < content.length * 0.75 || candidate.length > content.length + Math.max(600, content.length * 0.35)))) {
    throw new Error('衔接修复删减或扩写过多')
  }
  assertNovelProse(candidate)
  return candidate
}

/** Invalid edits or failed checks are retried in memory; only verified text is returned for saving. */
export async function repairContinuity<Check>(input: {
  chapterNumber: number; content: string; issue: string; context: string; signal?: AbortSignal; maxRounds?: number; scope?: RepairScope
}, dependencies: {
  generate: (prompt: string) => Promise<string>
  verify: (original: string, candidate: string) => Promise<void>
  check: (candidate: string) => Promise<Check>
  onProgress?: (round: number, stage: 'generate' | 'verify' | 'check' | 'retry', detail?: string) => void
}): Promise<{ content: string; check: Check }> {
  let feedback = input.issue
  const limits = localRepairLimits(input.content.length)
  const scope = input.scope ?? 'local'
  for (let round = 1; ; round++) {
    if (input.signal?.aborted) throw new Error('LLM_ABORTED')
    try {
      dependencies.onProgress?.(round, 'generate')
      const raw = await dependencies.generate([
        `自动修复第 ${input.chapterNumber} 章已经确认的衔接矛盾，范围：${scope === 'local' ? '局部句段' : scope === 'scene' ? '相关场景' : '章节结构'}。`,
        '以实际前文与有证据的记忆为准；标为细纲/计划的材料不是历史事实。不修改过去章节，不编造转场、道具、能力或人物知情来掩盖矛盾。',
        '只纠正下列矛盾及其直接影响，保留其余事件、人物动机、伏笔阶段与章末落点，遵守作者临时要求。若章末落点本身被明确指出抢写后续节点，须退回本章计划允许的阶段。',
        scope === 'local' ? '先定位冲突原句，只改必要的词句；确需衔接时才涉及紧邻段落。未被指出有问题的文字逐字保留，不顺带润色、改对白比例、统一文风或重写场景。'
          : '仅因已列出的遗漏、越界或因果矛盾调整相关场景；保留其他事件、人物及文风。不得编造已发生的历史。结构调整候选只供作者审阅，删除越界片段必须依据本章边界。',
        '补入耗时经历时必须维护场景时间顺序：需要数小时的行为放在后文时间自然推进后，并交代桥接；不能插在刚开场时宣称已经完成后再退回原时刻，也不能虚构时间加速、测试区或未发生的历史来凑齐要求。',
        '严格输出 JSON：{"replacements":[{"before":"当前正文中可唯一定位的原句或段落","after":"修复后的正文"}]}。不输出整章，不输出解释。',
        'before 必须逐字复制原文，每个位置仅替换一次，范围不得重叠；不靠删除场景或大段重写消除检查提示。',
        scope === 'local' ? `最多 ${MAX_LOCAL_REPLACEMENTS} 处小范围替换；去掉每处前后完全相同的文字后，实际改动原文每处不超过 ${MAX_SOURCE_PASSAGE} 字符、新文不超过 ${MAX_REPAIRED_PASSAGE} 字符，累计原文不超过 ${limits.source} 字符、新文不超过 ${limits.replacement} 字符。相隔的冲突必须分别定位成多项，绝不能用一个替换跨越大段不相关正文。候选全文长度须在 ${Math.ceil(input.content.length * 0.75)}～${Math.floor(input.content.length + Math.max(600, input.content.length * 0.35))} 字符之间。`
          : `最多 ${MAX_LOCAL_REPLACEMENTS} 处替换；${scope === 'scene' ? '每处原文最多1200字符、新文最多1500字符，仅调整相关场景。' : '如章节边界要求移除越界段落，可用空 after 删除原文；不得删除无关情节。'}未涉及的原文保持不变。`,
        '--- 最初确认的问题 ---', input.issue,
        '--- 本轮需要解决的问题或上轮复检反馈 ---', feedback,
        '--- 前文、细纲、记忆及作者要求（按来源使用） ---', input.context,
        '--- 当前原稿（本轮所有替换均基于此稿） ---', input.content
      ].join('\n'))
      const candidate = applyContinuityReplacements(input.content, raw, scope)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      dependencies.onProgress?.(round, 'verify')
      await dependencies.verify(input.content, candidate)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      dependencies.onProgress?.(round, 'check')
      const check = await dependencies.check(candidate)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      return { content: candidate, check }
    } catch (error) {
      if (input.signal?.aborted || (error as Error).message?.includes('LLM_ABORTED') ||
          (error as Error).message?.includes('CHAPTER_REPAIR_BUDGET') ||
          (error as Error).message?.includes('AGY_REPAIR_CONTEXT_TOO_LARGE')) throw error
      feedback = (error as Error).message
      if (input.maxRounds !== undefined && round >= input.maxRounds) throw new Error(`自动修复复核未通过：${feedback}`, { cause: error })
      if (round % REPAIR_ROUNDS_BEFORE_BACKOFF === 0) {
        dependencies.onProgress?.(round, 'retry', feedback)
        await waitForRetry(Math.min(30_000, 5_000 * (round / REPAIR_ROUNDS_BEFORE_BACKOFF)), input.signal)
      }
    }
  }
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('LLM_ABORTED'))
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(new Error('LLM_ABORTED')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
