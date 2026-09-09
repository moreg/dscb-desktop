import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import ChapterSelfCheckPanel from '../src/renderer/src/ChapterSelfCheckPanel'
import type { ChapterSelfCheckReport, SelfCheckItemResult } from '../src/shared/types'

// The application uses the React Vite plugin; the unit-test transform uses classic JSX.
beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function report(items: SelfCheckItemResult[]): ChapterSelfCheckReport {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const item of items) counts[item.verdict] += 1
  return { schemaVersion: 1, chapterNumber: 3, generatedAt: '', items, counts, ok: counts.fail === 0, summary: '全部通过' }
}

const punctuation: SelfCheckItemResult = {
  id: 'punctuation_rule', category: 'ban', label: '标点守则', verdict: 'warn', detail: '需要替换破折号'
}
const callbacks = { onApplyToRewrite() {}, onApplyToContinue() {}, onFixPunctuation() {} }

describe('self-check panel rendered state', () => {
  it('disables every repair action for an outdated report and explains how to refresh it', () => {
    const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
      ...callbacks, report: report([punctuation]), stale: true, onRerun() {}
    }))
    expect(html).toContain('结果已过期')
    expect(html).toContain('重新检查后才能应用自检要求')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>按自检改正文<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>填入续写临时要求<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>⚡ 一键替换标点<\/button>/)
  })

  it('does not show all-passed claims for legacy reports with skipped checks', () => {
    const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
      report: report([{ id: 'core_plot', category: 'plot', label: '剧情', verdict: 'skip', detail: '缺少细纲' }])
    }))
    expect(html).not.toContain('全部通过')
    expect(html).toContain('尚无可判定项')
    expect(html).toContain('查看跳过原因')
  })

  it('does not offer rewriting a chapter to fix a failed check execution', () => {
    const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
      ...callbacks, report: report([{
        id: 'self_check_error', category: 'structure', label: '检查异常', verdict: 'fail', detail: '读取失败',
        repairKind: 'execution_error'
      }])
    }))
    expect(html).toContain('检查未完成')
    expect(html).not.toContain('按自检改正文')
    expect(html).not.toContain('填入续写临时要求')
  })

  it('separates pending completion and leaves continuation available without a repair call to action', () => {
    const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
      ...callbacks, partialChapter: true,
      report: report([{ id: 'core_plot', category: 'plot', label: '剧情', verdict: 'fail', detail: '尚未推进' }])
    }))
    expect(html).toContain('1 项待写完')
    expect(html).toContain('失败 0')
    expect(html).not.toContain('按自检改正文')
    expect(html).toContain('填入续写临时要求')
  })

  it('renders missing plot points beyond the former six-item limit', () => {
    const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
      report: report([{
        id: 'core_plot', category: 'plot', label: '剧情', verdict: 'warn', detail: '',
        missing: Array.from({ length: 8 }, (_, index) => `子事件 ${index + 1}`)
      }])
    }))
    expect(html).toContain('子事件 7')
    expect(html).toContain('子事件 8')
  })

  it('keeps a prior report from being applied while rechecking or after a transport error', () => {
    for (const state of [{ rerunLoading: true }, { error: '自检未完成，请重新检查。' }]) {
      const html = renderToStaticMarkup(createElement(ChapterSelfCheckPanel, {
        ...callbacks, ...state, report: report([punctuation])
      }))
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>按自检改正文<\/button>/)
    }
  })
})
