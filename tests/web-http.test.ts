import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebHandler } from '../src/web/http-app'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ProjectMeta } from '../src/shared/types'
import { MAX_PROJECT_PACKAGE_BYTES } from '../src/shared/project-package'
import { encodeZip } from '../src/main/data/project-package'

describe('web http gate', () => {
  let server: Server
  let base: string
  let root: string
  let service: ProjectService
  let cookie: string
  const uploadedPaths: string[] = []
  const calls: Array<{ tabId: string; channel: string; args: unknown[] }> = []

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dscb-web-'))
    service = new ProjectService(
      join(root, 'projects'),
      new LibraryRepository(join(root, 'library.json')),
      { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository
    )
    await mkdir(join(root, 'exports'))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf8')
    await writeFile(join(root, 'exports', 'abcd1234-书.txt'), '正文', 'utf8')
    const handler = createWebHandler({
      accessToken: 'secret-token',
      staticRoot: root,
      exportsDir: join(root, 'exports'),
      importProjectPackage: async (zipPath) => {
        uploadedPaths.push(zipPath)
        return service.importProjectPackage(zipPath)
      },
      invoke: async (tabId, channel, args) => {
        calls.push({ tabId, channel, args })
        return { echoed: channel }
      },
      subscribeTab: () => () => {},
      retainTab: () => {},
      releaseTab: () => {}
    })
    server = createServer((request, response) => {
      void handler(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' })
    })
    cookie = login.headers.getSetCookie()[0]?.split(';')[0] || ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  it('serves health and the app shell without a session', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    const page = await fetch(`${base}/`)
    expect(await page.text()).toContain('ok')
    expect((await fetch(`${base}/api/rpc`, { method: 'POST' })).status).toBe(401)
  })

  it('rejects a wrong token and accepts the configured token', async () => {
    const wrong = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' })
    })
    expect(wrong.status).toBe(401)

    const right = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' })
    })
    expect(right.status).toBe(200)
    const cookie = right.headers.getSetCookie()[0]?.split(';')[0]
    expect(cookie).toMatch(/^dscb_session=/)

    const tabId = 'tab12345678'
    const rpc = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie || '',
        'x-dscb-tab': tabId
      },
      body: JSON.stringify({ channel: 'library:list', args: [{}], tabId })
    })
    expect(rpc.status).toBe(200)
    expect(await rpc.json()).toEqual({ ok: true, result: { echoed: 'library:list' } })
    expect(calls.at(-1)).toEqual({ tabId, channel: 'library:list', args: [{}] })
  })

  it('downloads an export and refuses paths outside the export directory', async () => {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' })
    })
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0] || ''
    const file = await fetch(`${base}/api/exports/${encodeURIComponent('abcd1234-书.txt')}`, {
      headers: { cookie }
    })
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('正文')
    const disposition = file.headers.get('content-disposition') || ''
    expect(disposition).toContain(`UTF-8''${encodeURIComponent('书.txt')}`)
    expect(disposition).not.toContain('%25')
    const escaped = await fetch(`${base}/api/exports/${encodeURIComponent('../package.json')}`, {
      headers: { cookie }
    })
    expect(escaped.status).toBeGreaterThanOrEqual(400)
  })

  const upload = (body: Buffer, headers: Record<string, string> = {}) => fetch(`${base}/api/import-package`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/zip', ...headers },
    body: new Uint8Array(body)
  })

  it('requires login before accepting a novel package', async () => {
    const count = uploadedPaths.length
    const response = await upload(Buffer.from('zip'), { cookie: '' })
    expect(response.status).toBe(401)
    expect(uploadedPaths).toHaveLength(count)
  })

  it('imports a package into the shelf, preserves chapters and saves duplicates separately', async () => {
    const chapter = '# 第一章\n\n雨落在瓦上。\n'
    const zip = encodeZip([
      { name: '示例/大纲/大纲.md', data: Buffer.from('# 《网页导入》大纲\n\n## 主线\n夜雨。\n') },
      { name: '示例/正文/第001章.md', data: Buffer.from(chapter) }
    ])
    const firstResponse = await upload(zip)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json() as { ok: boolean; result: { canceled: boolean; project: ProjectMeta } }
    expect(first.ok).toBe(true)
    expect(first.result.canceled).toBe(false)
    expect(first.result.project.name).toBe('网页导入')
    const secondResponse = await upload(zip)
    expect(secondResponse.status).toBe(200)
    const second = await secondResponse.json() as typeof first
    expect(second.result.project.id).not.toBe(first.result.project.id)
    expect(second.result.project.path).not.toBe(first.result.project.path)
    for (const project of [first.result.project, second.result.project]) {
      expect(await readFile(join(project.path, '正文', '第001章.md'), 'utf8')).toBe(chapter)
    }
    expect(await service.listProjects()).toHaveLength(2)
    for (const path of uploadedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns actionable errors for invalid packages and removes temporary uploads', async () => {
    for (const [data, message] of [
      [Buffer.alloc(0), '小说包为空'],
      [Buffer.from('broken zip'), '小说包已损坏'],
      [encodeZip([{ name: '../outside.txt', data: Buffer.from('escape') }]), '小说包里的路径不安全'],
      [encodeZip([{ name: 'notes.txt', data: Buffer.from('notes') }]), '这不是大神持笔的小说包']
    ] as const) {
      const response = await upload(data)
      expect(response.status).toBe(400)
      expect((await response.json() as { error: string }).error).toContain(message)
    }
    for (const path of uploadedPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported content types and oversized uploads before importing', async () => {
    const count = uploadedPaths.length
    expect((await upload(Buffer.from('{}'), { 'content-type': 'application/json' })).status).toBe(415)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/import-package`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/zip', 'content-length': MAX_PROJECT_PACKAGE_BYTES + 1 }
      }, (response) => {
        response.resume()
        resolve(response.statusCode)
        request.destroy()
      })
      request.on('error', reject)
      request.flushHeaders()
    })
    expect(status).toBe(413)
    expect(uploadedPaths).toHaveLength(count)
  })
})
