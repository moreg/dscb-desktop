import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uploadProjectPackage } from '../src/renderer/src/web-import'
import ProjectListPage from '../src/renderer/src/ProjectListPage'
import { MAX_PROJECT_PACKAGE_BYTES } from '../src/shared/project-package'

afterEach(() => vi.unstubAllGlobals())

describe('web novel package import', () => {
  it('shows the import action and native file input on the web shelf', () => {
    vi.stubGlobal('React', React)
    vi.stubGlobal('window', { __DSCB_WEB__: true })
    const markup = renderToStaticMarkup(createElement(ProjectListPage, {
      onOpenProject: () => {}, onOpenProjectWindow: () => {}, onOpenBrainstorm: () => {}
    }))
    expect(markup).toContain('导入小说包')
    expect(markup).toContain('type="file"')
    expect(markup).toContain('accept=".zip,application/zip,application/x-zip-compressed"')
  })

  it('uploads binary data and returns the imported project', async () => {
    const file = new File(['zip bytes'], '小说.zip', { type: 'application/zip' })
    const result = { canceled: false, project: { id: 'new-book', name: '小说' } }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await uploadProjectPackage(file)).toEqual(result)
    expect(fetchMock).toHaveBeenCalledWith('/api/import-package', {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: file
    })
  })

  it('rejects empty, non-ZIP and oversized files before uploading', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadProjectPackage(new File([], '小说.zip'))).rejects.toThrow('小说包为空')
    await expect(uploadProjectPackage(new File(['text'], '小说.txt'))).rejects.toThrow('ZIP')
    await expect(uploadProjectPackage({ name: '小说.zip', size: MAX_PROJECT_PACKAGE_BYTES + 1 } as File)).rejects.toThrow('512 MB')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'expired', '登录已失效'],
    [413, '<html>Too large</html>', '超过服务器允许的上传大小'],
    [400, JSON.stringify({ ok: false, error: '小说包已损坏' }), '小说包已损坏'],
    [502, '<html>Bad gateway</html>', '导入小说包失败']
  ])('handles HTTP %s without requiring a JSON error body', async (status, body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })))
    await expect(uploadProjectPackage(new File(['zip'], '小说.zip'))).rejects.toThrow(message)
  })
})
