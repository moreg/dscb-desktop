import { findJsonObject } from '../../shared/json-extract'
import { assertNovelProse } from './agent-meta-detect'

const REPAIR_ROUNDS_BEFORE_BACKOFF = 3

/** Unique, non-overlapping replacements preserve everything outside the faulty passages. */
export function applyContinuityReplacements(content: string, raw: string): string {
  const parsed = findJsonObject(raw)
  if (!Array.isArray(parsed?.replacements) || !parsed.replacements.length || parsed.replacements.length > 12) {
    throw new Error('衔接修复未返回有效的局部替换')
  }
  const edits: Array<{ start: number; end: number; after: string }> = []
  let removed = 0
  for (const entry of parsed.replacements) {
    if (typeof entry?.before !== 'string' || typeof entry.after !== 'string' || !entry.before.trim() || !entry.after.trim()) {
      throw new Error('衔接修复替换原句或新句为空')
    }
    const start = content.indexOf(entry.before)
    if (start < 0 || content.indexOf(entry.before, start + 1) >= 0) throw new Error('衔接修复原句无法唯一定位')
    const end = start + entry.before.length
    if (edits.some(edit => start < edit.end && end > edit.start)) throw new Error('衔接修复替换范围重叠')
    if (entry.before === entry.after) throw new Error('衔接修复没有实际改动')
    assertNovelProse(entry.after)
    edits.push({ start, end, after: entry.after })
    removed += entry.before.length
  }
  if (removed >= content.length * 0.9 || removed > Math.max(300, content.length * 0.45)) throw new Error('衔接修复改动范围过大，须缩小到矛盾段落')
  let candidate = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    candidate = candidate.slice(0, edit.start) + edit.after + candidate.slice(edit.end)
  }
  if (candidate.length < content.length * 0.75 || candidate.length > content.length + Math.max(600, content.length * 0.35)) {
    throw new Error('衔接修复删减或扩写过多')
  }
  assertNovelProse(candidate)
  return candidate
}

/** Invalid edits or failed checks are retried in memory; only verified text is returned for saving. */
export async function repairContinuity<Check>(input: {
  chapterNumber: number; content: string; issue: string; context: string; signal?: AbortSignal
}, dependencies: {
  generate: (prompt: string) => Promise<string>
  prepare?: (candidate: string) => Promise<string>
  verify: (original: string, candidate: string) => Promise<void>
  check: (candidate: string) => Promise<Check>
  onProgress?: (round: number, stage: 'generate' | 'verify' | 'check' | 'retry', detail?: string) => void
}): Promise<{ content: string; check: Check }> {
  let feedback = input.issue
  for (let round = 1; ; round++) {
    if (input.signal?.aborted) throw new Error('LLM_ABORTED')
    try {
      dependencies.onProgress?.(round, 'generate')
      const raw = await dependencies.generate([
        `自动修复第 ${input.chapterNumber} 章已经确认的衔接矛盾，只做局部替换。`,
        '以实际前文与有证据的记忆为准；标为细纲/计划的材料不是历史事实。不修改过去章节，不编造转场、道具、能力或人物知情来掩盖矛盾。',
        '只纠正下列矛盾及其直接影响，保留其余事件、人物动机、伏笔阶段与章末落点，遵守作者临时要求。',
        '严格输出 JSON：{"replacements":[{"before":"当前正文中可唯一定位的原句或段落","after":"修复后的正文"}]}。不输出整章，不输出解释。',
        'before 必须逐字复制原文，每个位置仅替换一次，范围不得重叠；不靠删除场景或大段重写消除检查提示。',
        '--- 最初确认的问题 ---', input.issue,
        '--- 本轮需要解决的问题或上轮复检反馈 ---', feedback,
        '--- 前文、细纲、记忆及作者要求（按来源使用） ---', input.context,
        '--- 当前原稿（本轮所有替换均基于此稿） ---', input.content
      ].join('\n'))
      let candidate = applyContinuityReplacements(input.content, raw)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      if (dependencies.prepare) candidate = await dependencies.prepare(candidate)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      dependencies.onProgress?.(round, 'verify')
      await dependencies.verify(input.content, candidate)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      dependencies.onProgress?.(round, 'check')
      const check = await dependencies.check(candidate)
      if (input.signal?.aborted) throw new Error('LLM_ABORTED')
      return { content: candidate, check }
    } catch (error) {
      if (input.signal?.aborted || (error as Error).message?.includes('LLM_ABORTED')) throw error
      feedback = (error as Error).message
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
