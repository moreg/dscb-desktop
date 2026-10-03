import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import BatchPolishDialog, {
  describeBatchPolishResult,
  mergeBatchPolishResults,
  resolveBatchPolishRange
} from '../src/renderer/src/BatchPolishDialog'
import type { ChapterMeta, SavedChapterPolishResult } from '../src/shared/types'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

const chapter = (number: number, wordCount = 2000): ChapterMeta => ({
  schemaVersion: 1,
  updatedAt: '',
  chapterNumber: number,
  title: `第 ${number} 章`,
  wordCount,
  status: wordCount > 0 ? 'draft' : 'outline'
})

const result = (number: number, status: SavedChapterPolishResult['autoDeslop']['status']): SavedChapterPolishResult => ({
  chapterNumber: number,
  changed: status === 'applied',
  autoDeslop: { status, message: '事实差异：原文三天，润色稿五天', remainingIssues: 0, repairAttempts: 2 }
})

describe('已有正文批量去 AI 味', () => {
  it('一键写完十章后默认只选择最近十章正文，排除未来的细纲', () => {
    const chapters = Array.from({ length: 30 }, (_, index) => chapter(index + 1, index < 20 ? 2000 : 0))
    expect(resolveBatchPolishRange(chapters.reverse())).toEqual({ from: 11, to: 20 })
  })

  it('正文不足十章时从第一章已有正文开始', () => {
    expect(resolveBatchPolishRange([chapter(1, 0), chapter(2), chapter(3)])).toEqual({ from: 2, to: 3 })
  })

  it('稀疏章号也不会默认选出超过一百章的调用范围', () => {
    const range = resolveBatchPolishRange([chapter(1), chapter(250)])
    expect(range.to).toBe(250)
    expect(range.to - range.from + 1).toBeLessThanOrEqual(100)
  })

  it('最终回包覆盖该章实时结果，同时保留中断前已收到的其它章节', () => {
    const older = result(2, 'review_required')
    const newer = result(2, 'applied')
    expect(mergeBatchPolishResults([older, result(1, 'applied')], [newer])).toEqual([
      result(1, 'applied'), newer
    ])
  })

  it('未通过时呈现具体原因，绝不误报已保存', () => {
    expect(describeBatchPolishResult(result(8, 'review_required'))).toContain('三天')
    expect(describeBatchPolishResult(result(8, 'review_required'))).not.toContain('正文已保存')
    expect(describeBatchPolishResult({ ...result(8, 'failed'), error: '本章没有已保存正文' })).toBe('本章没有已保存正文')
  })

  it('批次返工预设保留原范围，并告知检查全部已有正文', () => {
    const html = renderToStaticMarkup(createElement(BatchPolishDialog, {
      projectId: 'p', chapters: [chapter(11), chapter(20)], preset: { from: 11, to: 20 },
      onClose: () => {}, onChapterCompleted: () => {}
    }))
    expect(html).toContain('value="11"')
    expect(html).toContain('value="20"')
    expect(html).toContain('范围内全部已有正文')
    expect(html).toContain('仍未通过的章节保留原文')
    expect(html).toContain('开始批量去 AI 味')
  })

  it('超过一百章时明确提示处理上限，禁用开始按钮', () => {
    const html = renderToStaticMarkup(createElement(BatchPolishDialog, {
      projectId: 'p', chapters: [chapter(1)], preset: { from: 1, to: 101 },
      onClose: () => {}, onChapterCompleted: () => {}
    }))
    expect(html).toContain('单次最多处理 100 章')
    expect(html).toMatch(/disabled="">开始批量去 AI 味/)
  })
})
