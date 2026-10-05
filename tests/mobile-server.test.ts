import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileServer } from '../src/main/mobile/mobile-server'
import type { MobileBrainstormInput, MobileBrainstormResult } from '../src/main/mobile/mobile-brainstorm-service'
import {
  MobileBatchError,
  type MobileBatchJob,
  type MobileBatchStartInput
} from '../src/main/mobile/mobile-batch-service'
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

  function createFixture(includeBrainstorm = true, includeBatch = true) {
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
    const brainstorm = {
      generate: vi.fn(async (_input: MobileBrainstormInput, _signal: AbortSignal): Promise<MobileBrainstormResult> => ({
        ok: true,
        ideas: [{ title: '雨夜来信', premise: '找出寄信人的秘密', hook: '收到自己寄来的信', twist: '信来自旧友', ending: '主角选择赴约' }],
        rawText: '原始脑洞输出'
      }))
    }
    const batchJob: MobileBatchJob = {
      id: 'batch-job-1', projectId: 'project-1', requestId: 'batch-request-1',
      autoStrength: false, running: true, stopping: false,
      progress: { fromChapter: 1, toChapter: 10, total: 10, current: 0, currentChapter: 1, completed: [], status: 'generating' },
      stage: 'generating', streamText: '', summaries: [], updatedAt: Date.now()
    }
    const batch = {
      get: vi.fn(async (_projectId: string): Promise<MobileBatchJob | null> => null),
      start: vi.fn(async (_projectId: string, _input: MobileBatchStartInput): Promise<MobileBatchJob> => batchJob),
      resume: vi.fn(async (_projectId: string, _jobId: string): Promise<MobileBatchJob> => batchJob),
      stop: vi.fn(async (_projectId: string, _jobId: string): Promise<MobileBatchJob> => ({
        ...batchJob, running: false, progress: { ...batchJob.progress, status: 'paused' }
      })),
      clear: vi.fn(async (_projectId: string, _jobId: string): Promise<null> => null),
      shutdown: vi.fn(async (): Promise<void> => undefined)
    }
    server = new MobileServer(
      projects, chapters, references, ai,
      includeBrainstorm ? brainstorm : undefined,
      includeBatch ? batch : undefined
    )
    return {
      projects,
      chapters,
      references,
      ai,
      brainstorm,
      batch,
      batchJob,
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

  it('requires pairing and same-origin access for all mobile batch commands', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const endpoint = `${baseUrl}/api/projects/project-1/batch`
    const commands = [
      { path: endpoint, method: 'GET', body: undefined },
      { path: endpoint, method: 'POST', body: JSON.stringify({ requestId: 'batch-request-1', fromChapter: 1, toChapter: 10 }) },
      ...['resume', 'stop', 'clear'].map((action) => ({ path: `${endpoint}/${action}`, method: 'POST', body: JSON.stringify({ jobId: 'batch-job-1' }) }))
    ]
    for (const command of commands) {
      expect((await fetch(command.path, { method: command.method, body: command.body })).status).toBe(401)
      expect((await fetch(command.path, {
        method: command.method, body: command.body,
        headers: { Cookie: cookie, Origin: 'https://other.example' }
      })).status).toBe(403)
    }
    for (const method of ['get', 'start', 'resume', 'stop', 'clear'] as const) {
      expect(fixture.batch[method]).not.toHaveBeenCalled()
    }
    const allowed = await fetch(endpoint, { headers: { Cookie: cookie, Origin: baseUrl } })
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toEqual({ job: null })
    expect(fixture.batch.get).toHaveBeenCalledWith('project-1')
  })

  it('returns the current batch, accepts all commands and refreshes live progress with GET', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const endpoint = `${baseUrl}/api/projects/project-1/batch`
    const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' }
    const empty = await fetch(endpoint, { headers })
    await expect(empty.json()).resolves.toEqual({ job: null })

    const input = { requestId: 'batch-request-1', fromChapter: 1, toChapter: 10, autoStrength: true }
    const started = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
    expect(started.status).toBe(202)
    await expect(started.json()).resolves.toEqual({ job: fixture.batchJob })
    expect(fixture.batch.start).toHaveBeenCalledWith('project-1', input)

    const advanced: MobileBatchJob = {
      ...fixture.batchJob,
      stage: 'checking', streamText: '正在检查第 2 章',
      progress: { ...fixture.batchJob.progress, current: 2, currentChapter: 2, completed: [1, 2], status: 'flow', pendingPostProcessChapter: 2 },
      summaries: [{ chapter: 1, wordCount: 2_300, saved: true, checks: 'completed', deslop: '已完成', memory: '已同步' }],
      retryWait: { chapter: 2, attempt: 1, maxAttempts: 3, waitMs: 2_000, retryAt: Date.now() + 2_000 }
    }
    fixture.batch.get.mockResolvedValueOnce(advanced)
    const refreshed = await fetch(endpoint, { headers })
    expect(refreshed.status).toBe(200)
    await expect(refreshed.json()).resolves.toEqual({ job: advanced })
    expect(fixture.batch.get).toHaveBeenCalledTimes(2)

    const stopped = await fetch(`${endpoint}/stop`, {
      method: 'POST', headers, body: JSON.stringify({ jobId: fixture.batchJob.id })
    })
    expect(stopped.status).toBe(200)
    await expect(stopped.json()).resolves.toMatchObject({ job: { running: false, progress: { status: 'paused' } } })
    expect(fixture.batch.stop).toHaveBeenCalledWith('project-1', fixture.batchJob.id)

    const resumed = await fetch(`${endpoint}/resume`, {
      method: 'POST', headers, body: JSON.stringify({ jobId: fixture.batchJob.id })
    })
    expect(resumed.status).toBe(202)
    await expect(resumed.json()).resolves.toEqual({ job: fixture.batchJob })
    expect(fixture.batch.resume).toHaveBeenCalledWith('project-1', fixture.batchJob.id)

    const cleared = await fetch(`${endpoint}/clear`, {
      method: 'POST', headers, body: JSON.stringify({ jobId: fixture.batchJob.id })
    })
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toEqual({ job: null })
    expect(fixture.batch.clear).toHaveBeenCalledWith('project-1', fixture.batchJob.id)
  })

  it('validates batch request identifiers, integer ranges and the 100-chapter limit before starting', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const endpoint = `${baseUrl}/api/projects/project-1/batch`
    const headers = { Cookie: cookie }
    const input = { requestId: 'batch-request-1', fromChapter: 1, toChapter: 10 }
    for (const invalid of [
      { ...input, requestId: '' }, { ...input, requestId: '  ' }, { ...input, requestId: 'x'.repeat(256) },
      { ...input, fromChapter: 0 }, { ...input, fromChapter: 1.5 }, { ...input, fromChapter: '1' },
      { ...input, toChapter: 0 }, { ...input, toChapter: 10.5 },
      { ...input, fromChapter: 10, toChapter: 9 },
      { ...input, fromChapter: 1, toChapter: 101 },
      { ...input, fromChapter: Number.MAX_SAFE_INTEGER + 1, toChapter: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, autoStrength: 'true' }
    ]) {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(invalid) })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    }
    const malformed = await fetch(endpoint, { method: 'POST', headers, body: '{' })
    expect(malformed.status).toBe(400)
    expect(fixture.batch.start).not.toHaveBeenCalled()

    for (const range of [{ fromChapter: 1, toChapter: 1 }, { fromChapter: 101, toChapter: 200 }]) {
      const accepted = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify({ ...range, requestId: '  valid-request  ' })
      })
      expect(accepted.status).toBe(202)
      expect(fixture.batch.start).toHaveBeenLastCalledWith('project-1', { ...range, requestId: 'valid-request' })
    }
  })

  it('validates job identifiers for resume, stop and clear without calling the runner', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    for (const action of ['resume', 'stop', 'clear'] as const) {
      for (const body of [{}, { jobId: '' }, { jobId: '  ' }, { jobId: 123 }, { jobId: 'x'.repeat(256) }]) {
        const response = await fetch(`${baseUrl}/api/projects/project-1/batch/${action}`, {
          method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body)
        })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: '批次标识无效，请刷新进度后重试' })
      }
      expect(fixture.batch[action]).not.toHaveBeenCalled()
    }
  })

  it('returns public batch errors with their HTTP status and hides internal exceptions', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const endpoint = `${baseUrl}/api/projects/project-1/batch`
    const headers = { Cookie: cookie }
    for (const [status, message] of [[400, '第 1 章缺少细纲'], [404, '批次已不存在'], [409, '作品已有批量任务']] as const) {
      fixture.batch.start.mockRejectedValueOnce(new MobileBatchError(status, message))
      const response = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ requestId: 'batch-request-1', fromChapter: 1, toChapter: 10 })
      })
      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toEqual({ error: message })
    }
    fixture.batch.get.mockRejectedValueOnce(new Error('C:\\private\\batch.json contains private credentials'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await fetch(endpoint, { headers })
    expect(failed.status).toBe(500)
    await expect(failed.json()).resolves.toEqual({ error: '服务器内部错误' })
  })

  it('reports an unavailable batch runner explicitly', async () => {
    const fixture = createFixture(true, false)
    const { cookie, baseUrl } = await pair()
    const response = await fetch(`${baseUrl}/api/projects/project-1/batch`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toEqual({ error: '批量写作服务暂不可用' })
    expect(fixture.batch.get).not.toHaveBeenCalled()
  })

  it('does not stop a desktop-managed batch when the initiating phone request disconnects', async () => {
    const fixture = createFixture()
    let markStarted!: () => void
    let releaseStart!: () => void
    let markFinished!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseStart = resolve })
    const finished = new Promise<void>((resolve) => { markFinished = resolve })
    fixture.batch.start.mockImplementationOnce(async () => {
      markStarted()
      await gate
      markFinished()
      return fixture.batchJob
    })
    fixture.batch.get.mockResolvedValue(fixture.batchJob)
    const { cookie, baseUrl } = await pair()
    const controller = new AbortController()
    const pending = fetch(`${baseUrl}/api/projects/project-1/batch`, {
      method: 'POST', headers: { Cookie: cookie }, signal: controller.signal,
      body: JSON.stringify({ requestId: 'batch-request-1', fromChapter: 1, toChapter: 10 })
    }).then(() => 'responded', () => 'disconnected')
    await started
    controller.abort()
    expect(await pending).toBe('disconnected')
    releaseStart()
    await finished

    const refreshed = await fetch(`${baseUrl}/api/projects/project-1/batch`, { headers: { Cookie: cookie } })
    expect(refreshed.status).toBe(200)
    await expect(refreshed.json()).resolves.toMatchObject({ job: { id: 'batch-job-1', running: true } })
    expect(fixture.batch.stop).not.toHaveBeenCalled()
    expect(fixture.batch.shutdown).not.toHaveBeenCalled()
  })

  it('awaits batch shutdown before restarting, invalidates old pairing and reuses the batch runner', async () => {
    const fixture = createFixture()
    const first = await pair()
    let markShutdownStarted!: () => void
    let releaseShutdown!: () => void
    const shutdownStarted = new Promise<void>((resolve) => { markShutdownStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseShutdown = resolve })
    fixture.batch.shutdown.mockImplementationOnce(async () => { markShutdownStarted(); await gate })
    const stopped = server!.stop()
    await shutdownStarted
    let restartFinished = false
    const restarting = server!.start().then((status) => { restartFinished = true; return status })
    await Promise.resolve()
    expect(restartFinished).toBe(false)
    expect(fixture.batch.shutdown).toHaveBeenCalledTimes(1)
    releaseShutdown()
    expect((await stopped).running).toBe(false)
    expect((await restarting).running).toBe(true)

    const pairedAgain = await pair()
    const endpoint = `${pairedAgain.baseUrl}/api/projects/project-1/batch`
    expect((await fetch(endpoint, { headers: { Cookie: first.cookie } })).status).toBe(401)
    fixture.batch.get.mockResolvedValueOnce({ ...fixture.batchJob, running: false, progress: { ...fixture.batchJob.progress, status: 'paused' } })
    const restored = await fetch(endpoint, { headers: { Cookie: pairedAgain.cookie } })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({ job: { id: 'batch-job-1', running: false } })
    const resumed = await fetch(`${endpoint}/resume`, {
      method: 'POST', headers: { Cookie: pairedAgain.cookie }, body: JSON.stringify({ jobId: fixture.batchJob.id })
    })
    expect(resumed.status).toBe(202)
    expect(fixture.batch.resume).toHaveBeenCalledWith('project-1', fixture.batchJob.id)
  })

  it('generates long, short and medium ideas without creating or changing a project', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    for (const kind of ['long', 'short', 'medium']) {
      const response = await fetch(`${baseUrl}/api/brainstorm`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: baseUrl },
        body: JSON.stringify({ kind, genre: ' 悬疑 ', direction: '雨夜来信', requirements: '' })
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ ok: true, ideas: [{ title: '雨夜来信' }], rawText: '原始脑洞输出' })
    }
    expect(fixture.brainstorm.generate.mock.calls.map(([input]) => input)).toEqual([
      { kind: 'long', genre: '悬疑', direction: '雨夜来信', requirements: '' },
      { kind: 'short', genre: '悬疑', direction: '雨夜来信', requirements: '', targetWords: 8_000 },
      { kind: 'medium', genre: '悬疑', direction: '雨夜来信', requirements: '', targetWords: 30_000 }
    ])
    expect(fixture.chapters.updateContent).not.toHaveBeenCalled()
    expect(fixture.chapters.updateMeta).not.toHaveBeenCalled()
  })

  it('requires a paired same-origin session and validates brainstorming before calling AI', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const body = { kind: 'long', genre: '', direction: '', requirements: '' }
    expect((await fetch(`${baseUrl}/api/brainstorm`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/brainstorm`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' }, body: JSON.stringify(body)
    })).status).toBe(403)
    for (const invalid of [
      { ...body, kind: 'unknown' },
      { ...body, direction: '长'.repeat(2_001) },
      { ...body, targetChapters: 1.5 },
      { ...body, kind: 'short', targetWords: 999 },
      { ...body, previousIdeas: Array.from({ length: 31 }, () => ({ title: '旧题', premise: '旧设定' })) }
    ]) {
      const response = await fetch(`${baseUrl}/api/brainstorm`, {
        method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(invalid)
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ ok: false })
    }
    const malformed = await fetch(`${baseUrl}/api/brainstorm`, {
      method: 'POST', headers: { Cookie: cookie }, body: '{'
    })
    expect(malformed.status).toBe(400)
    expect(fixture.brainstorm.generate).not.toHaveBeenCalled()
  })

  it('reports an unavailable brainstorm service explicitly', async () => {
    createFixture(false)
    const { cookie, baseUrl } = await pair()
    const response = await fetch(`${baseUrl}/api/brainstorm`, {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ kind: 'long', genre: '', direction: '', requirements: '' })
    })
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: '脑洞生成服务暂不可用' })
  })

  it('rejects simultaneous brainstorms in one session, cancels on disconnect and permits retry', async () => {
    const fixture = createFixture()
    let markStarted!: (signal: AbortSignal) => void
    let markAborted!: () => void
    const started = new Promise<AbortSignal>((resolve) => { markStarted = resolve })
    const aborted = new Promise<void>((resolve) => { markAborted = resolve })
    fixture.brainstorm.generate.mockImplementationOnce((_input, signal) => new Promise((resolve) => {
      markStarted(signal)
      signal.addEventListener('abort', () => {
        resolve({ ok: false, error: 'LLM_ABORTED' })
        markAborted()
      }, { once: true })
    }))
    const { cookie, baseUrl } = await pair()
    const options = {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ kind: 'long', genre: '', direction: '', requirements: '' })
    }
    const controller = new AbortController()
    const pending = fetch(`${baseUrl}/api/brainstorm`, { ...options, signal: controller.signal })
      .then(() => 'responded', () => 'disconnected')
    const modelSignal = await started
    // A completed HTTP request body must not cancel the still-running model.
    expect(modelSignal.aborted).toBe(false)
    const duplicate = await fetch(`${baseUrl}/api/brainstorm`, options)
    expect(duplicate.status).toBe(409)
    expect(fixture.brainstorm.generate).toHaveBeenCalledTimes(1)

    controller.abort()
    expect(await pending).toBe('disconnected')
    await aborted
    expect(modelSignal.aborted).toBe(true)
    const retried = await fetch(`${baseUrl}/api/brainstorm`, options)
    expect(retried.status).toBe(200)
    expect(fixture.brainstorm.generate).toHaveBeenCalledTimes(2)
  })

  it('cancels active brainstorm model calls when the mobile server stops', async () => {
    const fixture = createFixture()
    let markStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => { markStarted = resolve })
    fixture.brainstorm.generate.mockImplementationOnce((_input, signal) => new Promise((resolve) => {
      markStarted(signal)
      signal.addEventListener('abort', () => resolve({ ok: false, error: 'LLM_ABORTED' }), { once: true })
    }))
    const { cookie, baseUrl } = await pair()
    const pending = fetch(`${baseUrl}/api/brainstorm`, {
      method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ kind: 'short', genre: '', direction: '', requirements: '' })
    }).then(() => 'responded', () => 'disconnected')
    const signal = await started
    expect((await server!.stop()).running).toBe(false)
    expect(signal.aborted).toBe(true)
    expect(await pending).toBe('disconnected')
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

  it('accepts retrying an already committed save after its response was lost', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const chapterUrl = `${baseUrl}/api/projects/project-1/chapters/1`
    const body = JSON.stringify({ content: '手机新正文', baseRevision: contentRevision('原始正文') })
    const options = { method: 'PUT', headers: { Cookie: cookie }, body }

    expect((await fetch(chapterUrl, options)).status).toBe(200)
    const retried = await fetch(chapterUrl, options)
    expect(retried.status).toBe(200)
    await expect(retried.json()).resolves.toMatchObject({ revision: contentRevision('手机新正文') })
    expect(fixture.getContent()).toBe('手机新正文')
  })

  it('rejects conflicting simultaneous saves based on the same revision', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const responses = await Promise.all(['设备一的正文', '设备二的正文'].map((content) =>
      fetch(`${baseUrl}/api/projects/project-1/chapters/1`, {
        method: 'PUT',
        headers: { Cookie: cookie },
        body: JSON.stringify({ content, baseRevision: contentRevision('原始正文') })
      })
    ))

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(['设备一的正文', '设备二的正文']).toContain(fixture.getContent())
  })

  it('keeps chapter content available when optional detail cannot be read', async () => {
    const fixture = createFixture()
    fixture.references.getChapterDetail.mockRejectedValueOnce(new Error('private detail path'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { cookie, baseUrl } = await pair()

    const response = await fetch(`${baseUrl}/api/projects/project-1/chapters/1`, {
      headers: { Cookie: cookie }
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      chapter: { content: '原始正文' },
      revision: contentRevision('原始正文'),
      detail: null,
      detailError: '细纲暂时无法读取，正文仍可编辑'
    })
  })

  it('allows same-origin writes and rejects writes from a different website', async () => {
    const fixture = createFixture()
    const { cookie, baseUrl } = await pair()
    const chapterUrl = `${baseUrl}/api/projects/project-1/chapters/1`
    const body = JSON.stringify({ content: '同源正文', baseRevision: contentRevision('原始正文') })
    const foreign = await fetch(chapterUrl, {
      method: 'PUT', headers: { Cookie: cookie, Origin: 'https://other.example' }, body
    })
    expect(foreign.status).toBe(403)
    expect(fixture.chapters.updateContent).not.toHaveBeenCalled()

    const sameOrigin = await fetch(chapterUrl, {
      method: 'PUT', headers: { Cookie: cookie, Origin: baseUrl }, body
    })
    expect(sameOrigin.status).toBe(200)
    expect(fixture.getContent()).toBe('同源正文')
  })

  it('stops promptly while an AI request is still pending', async () => {
    const fixture = createFixture()
    let releaseAi!: (text: string) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    fixture.ai.generateChapterStream.mockImplementationOnce(() => {
      markStarted()
      return new Promise<string>((resolve) => { releaseAi = resolve })
    })
    const { cookie, baseUrl } = await pair()
    const pending = fetch(`${baseUrl}/api/projects/project-1/chapters/1?action=ai`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ mode: 'continue', content: '现有正文' })
    }).then(() => 'responded', () => 'disconnected')
    await started

    try {
      expect((await server!.stop()).running).toBe(false)
      expect(await pending).toBe('disconnected')
    } finally {
      releaseAi('已完成的预览')
    }
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
