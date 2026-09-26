import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChapterPaginator } from '../src/renderer/src/ChapterListPage'

beforeAll(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

describe('ChapterPaginator 分页组件', () => {
  it('totalPages <= 1 时不渲染任何内容', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterPaginator, {
        currentPage: 1,
        totalPages: 1,
        totalItems: 15,
        onPageChange: () => {}
      })
    )
    expect(html).toBe('')
  })

  it('totalPages > 1 时渲染分页器与信息', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterPaginator, {
        currentPage: 1,
        totalPages: 20,
        totalItems: 400,
        onPageChange: () => {},
        className: 'paginator-top'
      })
    )
    expect(html).toContain('paginator paginator-top')
    expect(html).toContain('第 1/20 页 · 共 400 章')
    expect(html).toContain('上一页')
    expect(html).toContain('下一页')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>上一页<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>下一页<\/button>/)
  })

  it('最后一页时下一页按钮置灰', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterPaginator, {
        currentPage: 20,
        totalPages: 20,
        totalItems: 400,
        onPageChange: () => {}
      })
    )
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>上一页<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>下一页<\/button>/)
  })

  it('高亮当前选中页码，并包含折叠省略号', () => {
    const html = renderToStaticMarkup(
      createElement(ChapterPaginator, {
        currentPage: 5,
        totalPages: 20,
        totalItems: 400,
        onPageChange: () => {}
      })
    )
    expect(html).toContain('page-num active">5</button>')
    expect(html).toContain('page-num ellipsis')
  })
})
