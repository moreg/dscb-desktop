import type { ChapterSummaryBatchOptions, ChapterSummaryBatchItem, ChapterSummaryBatchProgress,
  ChapterSummaryBatchResult, ChapterSummaryView } from '../../shared/types'
import { ProseRepo } from './skill-format/prose-repo'
import { ChapterSummaryRepo } from './memory/chapter-summary-repo'
import { hashProse, listProseSources } from './memory/prose-memory-index'
import { contentRevision } from './chapter-revision'
import { parseContinuityFacts, assertSummaryKnowledgeCoverage, buildContinuityContext } from './memory/continuity-context'

export async function regenerateSummariesBatch(
  dir: string, options: ChapterSummaryBatchOptions,
  generate: (chapter: number, content: string, revision: string) => Promise<ChapterSummaryView>,
  onChapterComplete: (result: ChapterSummaryBatchItem) => void,
  opts: { signal?: AbortSignal; onProgress?: (progress: ChapterSummaryBatchProgress) => void;
    validateChapter?: (chapter: number, content: string) => Promise<void> } = {}
): Promise<ChapterSummaryBatchResult> {
  const { fromChapter, toChapter } = options
  const results: ChapterSummaryBatchItem[] = []
  if (![fromChapter, toChapter].every((n) => Number.isSafeInteger(n) && n > 0) || fromChapter > toChapter) {
    return { ok: false, results, error: '请选择有效的起止章号' }
  }
  const stopped = (): ChapterSummaryBatchResult => ({ ok: false, stopped: true, results, error: '已停止，已生成的概要保留' })
  if (opts.signal?.aborted) return stopped()
  // Enumerate actual files rather than iterating a potentially sparse or huge numeric range.
  const chapters = (await listProseSources(dir)).filter((c) => c.chapterNumber >= fromChapter && c.chapterNumber <= toChapter)
  if (!chapters.length) return { ok: false, results, error: '所选范围没有已保存正文' }
  const completed = new Map(options.completed?.map((c) => [c.chapterNumber, c.sourceHash]))
  const repo = new ChapterSummaryRepo(dir)
  for (const [index, chapter] of chapters.entries()) {
    if (opts.signal?.aborted) return stopped()
    opts.onProgress?.({ chapter: chapter.chapterNumber, index: index + 1, total: chapters.length })
    let result: ChapterSummaryBatchItem
    try {
      const content = await new ProseRepo(dir).read(chapter.chapterNumber)
      const sourceHash = hashProse(content)
      if (!content.trim()) result = { chapterNumber: chapter.chapterNumber, status: 'skipped', error: '正文为空，已跳过' }
      else {
        await opts.validateChapter?.(chapter.chapterNumber, content)
        const current = await repo.readCurrent(chapter.chapterNumber, content)
        let validContinuity = false
        if (current?.continuity !== undefined) {
          try {
            parseContinuityFacts(current.continuity, content)
            const vocabulary = (await buildContinuityContext(dir, chapter.chapterNumber, {
              text: content, characters: [], aliases: [], props: []
            })).filter(line => line.startsWith('- [') && line.includes('最近可核实记录'))
            assertSummaryKnowledgeCoverage(current, vocabulary)
            validContinuity = true
          } catch { /* Regenerate invalid or incomplete records. */ }
        }
        if (current && validContinuity &&
          (options.onlyMissing || completed.get(chapter.chapterNumber) === sourceHash)) {
          if (hashProse(await new ProseRepo(dir).read(chapter.chapterNumber)) !== sourceHash) throw new Error('章节正文已改变，请重试本章概要')
          result = { chapterNumber: chapter.chapterNumber, status: 'reused', sourceHash, continuityCount: current.continuity!.length }
        } else {
          const summary = await generate(chapter.chapterNumber, content, contentRevision(content))
          if (summary.continuity === undefined) throw new Error('未返回道具、关系和知情记录，请重试本章概要')
          result = { chapterNumber: chapter.chapterNumber, status: 'generated', sourceHash, continuityCount: summary.continuity.length }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && (err.message === 'LLM_ABORTED' || err.name === 'AbortError'))) return stopped()
      result = { chapterNumber: chapter.chapterNumber, status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    // A summary that finished committing before cancellation is still a completed result.
    results.push(result)
    onChapterComplete(result)
  }
  if (opts.signal?.aborted) return stopped()
  const failed = results.filter((r) => r.status === 'failed').length
  return { ok: failed === 0, results, ...(failed ? { error: `${failed} 章概要生成失败，可继续补齐未完成章节` } : {}) }
}
