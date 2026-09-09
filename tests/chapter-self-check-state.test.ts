import { describe, expect, it } from 'vitest'
import type { ChapterSelfCheckReport, SelfCheckItemResult } from '../src/shared/types'
import { createChapterCheckTracker, selfCheckPresentation, selfCheckToastType } from '../src/renderer/src/chapterSelfCheckState'

const original = { projectId: 'book-a', chapterNumber: 3, content: '修改前正文' }

function report(items: SelfCheckItemResult[]): ChapterSelfCheckReport {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const item of items) counts[item.verdict] += 1
  return { schemaVersion: 1, chapterNumber: 3, generatedAt: '', items, counts, ok: counts.fail === 0, summary: '' }
}

describe('chapter self-check request ownership', () => {
  it('rejects a late response after changing chapter or project, even with identical text', () => {
    const tracker = createChapterCheckTracker(original)
    const first = tracker.begin()
    tracker.update({ ...original, chapterNumber: 4 })
    expect(tracker.accepts(first)).toBe(false)
    const second = tracker.begin()
    tracker.update({ ...original, projectId: 'book-b', chapterNumber: 4 })
    expect(tracker.accepts(second)).toBe(false)
  })

  it('keeps an old report stale after editing and undoing back to the original text', () => {
    const tracker = createChapterCheckTracker(original)
    const checked = tracker.begin()
    tracker.update({ ...original, content: '修改后的正文' })
    expect(tracker.accepts(checked)).toBe(false)
    tracker.update(original)
    expect(tracker.matches(checked)).toBe(false)
    expect(tracker.accepts(tracker.begin())).toBe(true)
  })

  it('accepts only the newest request and lets only its completion clear loading', () => {
    const tracker = createChapterCheckTracker(original)
    const automatic = tracker.begin()
    const manual = tracker.begin()
    expect(tracker.accepts(automatic)).toBe(false)
    expect(tracker.isLatest(automatic)).toBe(false)
    expect(tracker.accepts(manual)).toBe(true)
    expect(tracker.isLatest(manual)).toBe(true)
  })

  it('rejects pending punctuation edits once the draft changes and after leaving the editor', () => {
    const tracker = createChapterCheckTracker(original)
    const punctuationSource = tracker.capture()
    tracker.update({ ...original, content: original.content + '新输入' })
    expect(tracker.matches(punctuationSource)).toBe(false)
    const request = tracker.begin()
    tracker.invalidate()
    expect(tracker.accepts(request)).toBe(false)
    expect(tracker.isLatest(request)).toBe(false)
  })

  it('does not invalidate a report on unrelated renders of the same chapter draft', () => {
    const tracker = createChapterCheckTracker(original)
    const checked = tracker.begin()
    tracker.update({ ...original })
    expect(tracker.matches(checked)).toBe(true)
  })
})

describe('self-check coverage presentation', () => {
  const passed: SelfCheckItemResult = { id: 'punctuation_rule', category: 'ban', label: '标点', detail: '', verdict: 'pass' }
  const skipped: SelfCheckItemResult = { id: 'core_plot', category: 'plot', label: '核心事件', detail: '缺少细纲', verdict: 'skip' }

  it('does not say all passed when some or all checks were skipped', () => {
    expect(selfCheckPresentation(report([passed, skipped]))).toMatchObject({ label: '已检查项通过 · 1 项跳过', status: 'warn' })
    expect(selfCheckPresentation(report([skipped]))).toMatchObject({ label: '尚无可判定项', status: 'warn' })
    expect(selfCheckPresentation(report([]))).toMatchObject({ label: '尚无可判定项', status: 'warn' })
    expect(selfCheckPresentation(report([passed]))).toMatchObject({ label: '全部通过', status: 'ok' })
    expect(selfCheckToastType(report([passed, skipped]))).toBe('info')
    expect(selfCheckToastType(report([passed]))).toBe('success')
  })

  it('separates pending completion from real failures in unfinished chapters', () => {
    const result = selfCheckPresentation(report([{ ...skipped, verdict: 'fail' }, passed]), true)
    expect(result).toMatchObject({ counts: { fail: 0, pass: 1 }, label: '1 项待写完', status: 'warn' })
    expect(result.deferred.has('core_plot')).toBe(true)
  })

  it('keeps excessive chapter length actionable even in an unfinished chapter', () => {
    const result = selfCheckPresentation(report([{
      id: 'word_count', category: 'structure', label: '字数上限', detail: '超出上限',
      verdict: 'warn', repairKind: 'over_length'
    }]), true)
    expect(result.counts.warn).toBe(1)
    expect(result.deferred.size).toBe(0)
    expect(result.label).toBe('1 项留意')
  })

  it('preserves execution failures instead of treating them as uncompleted plot', () => {
    const result = selfCheckPresentation(report([{
      id: 'self_check_error', category: 'structure', label: '检查异常', detail: '',
      verdict: 'fail', repairKind: 'execution_error'
    }]), true)
    expect(result).toMatchObject({ label: '检查未完成', status: 'fail' })
  })
})
