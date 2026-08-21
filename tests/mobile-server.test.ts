import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileServer } from '../src/main/mobile/mobile-server'
import {
  ChapterRevisionConflictError,
  contentRevision
} from '../src/main/data/chapter-revision'
import type { ChapterContent, ChapterMeta, ProjectMeta } from '../src/shared/types'

const meta = (content: string): ChapterMeta => ({
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  chapterNumber: 1,
  title: '第一章 初见',
  wordCount: content.length,
  status: content ? 'draft' : 'outline'
})

describe('MobileServer', () => {
  let server: MobileServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  function createFixture() {
    let content = '原始正文'
    const project: ProjectMeta = {
      id: 'project-1',
      name: '测试作品',
      description: '只向手机暴露必要字段',
      genre: '都市',
      path: 'C:\\private\\novel',
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    }
    const projects = { listProjects: vi.fn(async () => [project]) }
    const chapters = {
      listChapters: vi.fn(async () => [meta(content)]),
      getChapter: vi.fn(async (): Promise<ChapterContent> => ({ meta: meta(content), content })),
      updateContent: vi.fn(async (
        _projectId: string,
        _chapterNumber: number,
        next: string,
        expectedRevision?: string
      ) => {
        if (expectedRevision !== undefined && contentRevision(content) !== expectedRevision) {
          throw new ChapterRevisionConflictError()
        }
        content = next
        return meta(content)
      }),
      updateMeta: vi.fn(async (
        _projectId: string,
        _chapterNumber: number,
        patch: { title?: string }
      ) => ({ ...meta(content), title: patch.title || meta(content).title }))
    }
    const references = {
      getLibrary: vi.fn(async () => ({
        outline: { synopsis: '测试梗概', volumes: [] },
        details: [],
        characters: [],
        locations: [],
        worldviews: [],
        items: [],
        foreshadowings: []
      })),
      getChapterDetail: vi.fn(async () => ({
        chapterNumber: 1,
        title: '第一章 初见',
        plotSummary: '主角第一次登场'
      })),
      search: vi.fn(async (_projectId: string, query: string) => [{
        chapterNumber: 1,
        title: '第一章 初见',
        snippet: `找到：${query}`,
        occurrences: 1
      }])
    }
    const ai = {
      generateChapterStream: vi.fn(async () => 'AI 续写内容'),
      adjustChapterStream: vi.fn(async () => 'AI 重写后的整章')
    }
    server = new MobileServer(projects, chapters, references, ai)
    return {
      projects,
      chapters,
      references,
      ai,
      getContent: () => content,
      setContent: (next: string) => { content = next }
    }
  }

  async function pair() {
    const status = await server!.start()
    const pairingUrl = new URL(status.pairingUrl!)
    const port = new URL(status.addressUrls[0]).port
    const localPairingUrl = `http://127.0.0.1:${port}/?pair=${pairingUrl.searchParams.get('pair')}`
    const response = await fetch(localPairingUrl, { redirect: 'manual' })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    return { response, cookie, baseUrl: `http://127.0.0.1:${port}`, localPairingUrl }
  }

  it('uses a one-time pairing link and does not expose project paths', async () => {
    createFixture()
    const { response, cookie, baseUrl, localPairingUrl } = await pair()
    expect(response.status).toBe(303)

    const reused = await fetch(localPairingUrl, { redirect: 'manual' })
    expect(reused.status).toBe(401)

    const result = await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })
    expect(result.status).toBe(200)
    const body = await result.json() as { projects: Array<Record<string, unknown>> }
    expect(body.projects[0]).toMatchObject({ id: 'project-1', name: '测试作品', genre: '都市' })
    expect(body.projects[0]).not.toHaveProperty('path')
  })

  it('serializes concurrent starts onto one listening server', async () => {
    createFixture()
    const statuses = await Promise.all([server!.start(), server!.start(), server!.start()])
    const ports = statuses.map((status) => new URL(status.addressUrls[0]).port)
    expect(new Set(ports).size).toBe(1)
  })

  it('does not expose internal exception details to the phone', async () => {
    const fixture = createFixture()
    fixture.projects.listProjects.mockRejectedValueOnce(
      new Error('大纲.md missing in C:\\private\\novel')
    )
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { cookie, baseUrl } = await pair()

    const response = await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } })
    const body = await response.json() as { error: string }
    expect(response.status).toBe(500)
    expect(body.error).toBe('服务器内部错误')
    expect(body.error).not.toContain('private')
    errorLog.mockRestore()
  })

  it('saves content and rejects a stale mobile revision', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
    const chapterUrl = `${baseUrl}/api/projects/project-1/chapters/1`

    const opened = await fetch(chapterUrl, { headers })
    const openedBody = await opened.json() as { revision: string }
    const saved = await fetch(chapterUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content: '手机写下的新正文', baseRevision: openedBody.revision })
    })
    expect(saved.status).toBe(200)
    expect(fixture.getContent()).toBe('手机写下的新正文')

    const current = await fetch(chapterUrl, { headers })
    const currentBody = await current.json() as { revision: string }
    fixture.setContent('电脑端刚刚修改')
    const stale = await fetch(chapterUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content: '手机的旧版本', baseRevision: currentBody.revision })
    })
    expect(stale.status).toBe(409)
    expect(fixture.chapters.updateContent).toHaveBeenCalledTimes(2)
    expect(fixture.getContent()).toBe('电脑端刚刚修改')
  })

  it('serves references, searches prose, returns chapter detail, and renames chapters', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }

    const library = await fetch(`${baseUrl}/api/projects/project-1/references`, { headers })
    expect(library.status).toBe(200)
    await expect(library.json()).resolves.toMatchObject({
      library: { outline: { synopsis: '测试梗概' } }
    })

    const search = await fetch(
      `${baseUrl}/api/projects/project-1/search?q=${encodeURIComponent('主角')}`,
      { headers }
    )
    expect(search.status).toBe(200)
    await expect(search.json()).resolves.toMatchObject({
      results: [{ chapterNumber: 1, occurrences: 1 }]
    })
    expect(fixture.references.search).toHaveBeenCalledWith('project-1', '主角')

    const opened = await fetch(`${baseUrl}/api/projects/project-1/chapters/1`, { headers })
    await expect(opened.json()).resolves.toMatchObject({
      detail: { plotSummary: '主角第一次登场' }
    })

    const renamed = await fetch(`${baseUrl}/api/projects/project-1/chapters/1`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: '新的章名' })
    })
    expect(renamed.status).toBe(200)
    await expect(renamed.json()).resolves.toMatchObject({ meta: { title: '新的章名' } })
    expect(fixture.chapters.updateMeta).toHaveBeenCalledWith('project-1', 1, {
      title: '新的章名'
    })
  })

  it('returns AI continuations and rewrites as previews without saving them', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
    const endpoint = `${baseUrl}/api/projects/project-1/chapters/1?action=ai`

    const continued = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'continue', content: '现有正文', instruction: '加强悬念' })
    })
    expect(continued.status).toBe(200)
    await expect(continued.json()).resolves.toEqual({ mode: 'continue', text: 'AI 续写内容' })
    expect(fixture.ai.generateChapterStream).toHaveBeenCalledWith('project-1', 1, {
      existingText: '现有正文',
      tempContext: '加强悬念',
      maxTokens: 4_096
    })

    const rewritten = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'rewrite', content: '现有正文', instruction: '改成第一人称' })
    })
    expect(rewritten.status).toBe(200)
    await expect(rewritten.json()).resolves.toEqual({ mode: 'rewrite', text: 'AI 重写后的整章' })
    expect(fixture.ai.adjustChapterStream).toHaveBeenCalled()
    expect(fixture.chapters.updateContent).not.toHaveBeenCalled()
    expect(fixture.getContent()).toBe('原始正文')
  })
})
