import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebHandler } from '../src/web/http-app'

describe('web http gate', () => {
  let server: Server
  let base: string
  const calls: Array<{ tabId: string; channel: string; args: unknown[] }> = []

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dscb-web-'))
    await mkdir(join(root, 'exports'))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf8')
    await writeFile(join(root, 'exports', 'abcd1234-书.txt'), '正文', 'utf8')
    const handler = createWebHandler({
      accessToken: 'secret-token',
      staticRoot: root,
      exportsDir: join(root, 'exports'),
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
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
})
