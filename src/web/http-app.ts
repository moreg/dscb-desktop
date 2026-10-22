import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { MAX_PROJECT_PACKAGE_BYTES } from '../shared/project-package'
import type { ProjectMeta } from '../shared/types'

const SESSION_COOKIE = 'dscb_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 32 * 1024 * 1024
const TAB_ID = /^[a-zA-Z0-9_-]{8,80}$/

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

interface AuthSession {
  expiresAt: number
}

export interface WebHandlerOptions {
  accessToken: string
  staticRoot: string
  exportsDir: string
  importProjectPackage(zipPath: string): Promise<ProjectMeta>
  invoke(tabId: string, channel: string, args: unknown[]): Promise<unknown>
  subscribeTab(tabId: string, subscriber: (channel: string, args: unknown[]) => void): () => void
  retainTab(tabId: string): void
  releaseTab(tabId: string): void
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function tokensMatch(input: string, expected: string): boolean {
  const left = createHash('sha256').update(input).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function clientIp(request: IncomingMessage): string {
  if (process.env.WEB_TRUST_PROXY === '1') {
    const forwarded = request.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim()
  }
  return request.socket.remoteAddress || 'unknown'
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const text = part.trim()
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    if (text.slice(0, eq) !== name) continue
    try {
      return decodeURIComponent(text.slice(eq + 1))
    } catch {
      return null
    }
  }
  return null
}

function sessionCookie(id: string, maxAge: number): string {
  const secure = process.env.WEB_COOKIE_SECURE === '1' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求过大')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readBody(request)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, '请求不是 JSON')
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  })
  response.end(payload)
}

function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  const relative = decoded.replace(/^[/\\]+/, '')
  if (!relative || relative.includes('\0')) return null
  const full = resolve(root, relative)
  const base = resolve(root)
  if (full !== base && !full.startsWith(base + sep)) return null
  return full
}

function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'"
  }
}

export function createWebHandler(options: WebHandlerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const sessions = new Map<string, AuthSession>()
  const loginFailures = new Map<string, { count: number; resetAt: number }>()

  const authorized = (request: IncomingMessage): boolean => {
    const id = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (!id) return false
    const session = sessions.get(id)
    if (!session) return false
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id)
      return false
    }
    return true
  }

  const tabIdOf = (request: IncomingMessage, fromBody?: unknown): string => {
    const header = request.headers['x-dscb-tab']
    const query = new URL(request.url || '/', 'http://localhost').searchParams.get('tab')
    const bodyTab = fromBody && typeof fromBody === 'object' && 'tabId' in fromBody
      ? (fromBody as { tabId?: unknown }).tabId
      : undefined
    const value = (typeof header === 'string' && header) || query || (typeof bodyTab === 'string' ? bodyTab : '')
    if (!TAB_ID.test(value)) throw new HttpError(400, '缺少页面标识')
    return value
  }

  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost')
    const path = url.pathname
    try {
      if (request.method === 'GET' && path === '/api/health') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && path === '/api/session') {
        sendJson(response, authorized(request) ? 200 : 401, { ok: authorized(request) })
        return
      }
      if (request.method === 'POST' && path === '/api/login') {
        const ip = clientIp(request)
        const now = Date.now()
        const failure = loginFailures.get(ip)
        if (failure && failure.resetAt > now && failure.count >= 10) {
          sendJson(response, 429, { ok: false, error: '尝试过于频繁，请稍后再试' })
          return
        }
        const body = await readJson(request)
        const token = body && typeof body === 'object' && 'token' in body ? (body as { token?: unknown }).token : ''
        if (typeof token !== 'string' || token.length === 0 || token.length > 500 || !tokensMatch(token, options.accessToken)) {
          const current = failure && failure.resetAt > now ? failure : { count: 0, resetAt: now + 60_000 }
          current.count += 1
          loginFailures.set(ip, current)
          sendJson(response, 401, { ok: false, error: '口令不正确' })
          return
        }
        loginFailures.delete(ip)
        const id = randomBytes(32).toString('hex')
        sessions.set(id, { expiresAt: now + SESSION_TTL_MS })
        sendJson(response, 200, { ok: true }, { 'set-cookie': sessionCookie(id, SESSION_TTL_MS / 1000) })
        return
      }
      if (request.method === 'POST' && path === '/api/logout') {
        const id = readCookie(request.headers.cookie, SESSION_COOKIE)
        if (id) sessions.delete(id)
        sendJson(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
        return
      }
      if (path.startsWith('/api/') && !authorized(request)) {
        sendJson(response, 401, { ok: false, error: '请先登录' })
        return
      }
      if (request.method === 'POST' && path === '/api/import-package') {
        const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/zip' && contentType !== 'application/octet-stream') {
          throw new HttpError(415, '请选择 ZIP 格式的小说包')
        }
        if (Number(request.headers['content-length']) > MAX_PROJECT_PACKAGE_BYTES) {
          throw new HttpError(413, '小说包过大，最大支持 512 MB')
        }
        // 使用服务器生成的临时路径；不接受客户端传入服务器文件路径。
        const zipPath = join(tmpdir(), `dscb-import-${randomUUID()}.zip`)
        const file = await open(zipPath, 'wx')
        let project: ProjectMeta
        try {
          let size = 0
          try {
            // 超限时保留连接，让客户端能收到明确的 413 响应。
            for await (const chunk of request.iterator({ destroyOnReturn: false })) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              size += bytes.length
              if (size > MAX_PROJECT_PACKAGE_BYTES) {
                throw new HttpError(413, '小说包过大，最大支持 512 MB')
              }
              await file.writeFile(bytes)
            }
          } finally {
            await file.close()
          }
          if (size === 0) throw new HttpError(400, '小说包为空，请重新选择文件')
          try {
            project = await options.importProjectPackage(zipPath)
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : '导入小说包失败')
          }
        } finally {
          await rm(zipPath, { force: true })
        }
        sendJson(response, 200, { ok: true, result: { canceled: false, project } })
        return
      }
      if (request.method === 'POST' && path === '/api/rpc') {
        const body = await readJson(request)
        if (!body || typeof body !== 'object') throw new HttpError(400, '请求无效')
        const record = body as { channel?: unknown; args?: unknown; tabId?: unknown }
        if (typeof record.channel !== 'string' || !/^[\w:.-]{1,120}$/.test(record.channel)) {
          throw new HttpError(400, '通道无效')
        }
        if (!Array.isArray(record.args)) throw new HttpError(400, '参数无效')
        const tabId = tabIdOf(request, record)
        options.retainTab(tabId)
        const result = await options.invoke(tabId, record.channel, record.args)
        sendJson(response, 200, { ok: true, result })
        return
      }
      if (request.method === 'GET' && path === '/api/events') {
        const tabId = tabIdOf(request)
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...securityHeaders()
        })
        response.write(': ok\n\n')
        const unsubscribe = options.subscribeTab(tabId, (channel, args) => {
          response.write(`data: ${JSON.stringify({ channel, args })}\n\n`)
        })
        const heartbeat = setInterval(() => {
          response.write(': ping\n\n')
        }, 25_000)
        heartbeat.unref?.()
        request.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
      }
      if (request.method === 'GET' && path.startsWith('/api/exports/')) {
        // pathname 仍保留百分号编码。先解开，下载名才是书名，而不是 %E9...。
        let name: string
        try {
          name = decodeURIComponent(path.slice('/api/exports/'.length))
        } catch {
          sendJson(response, 400, { ok: false, error: '文件名无效' })
          return
        }
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          sendJson(response, 400, { ok: false, error: '文件名无效' })
          return
        }
        const full = resolveInside(options.exportsDir, name)
        if (!full) {
          sendJson(response, 400, { ok: false, error: '文件名无效' })
          return
        }
        const info = await stat(full).catch(() => null)
        if (!info?.isFile()) {
          sendJson(response, 404, { ok: false, error: '文件不存在' })
          return
        }
        const downloadName = name.replace(/^[a-f0-9]{8}-/, '') || name
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          'cache-control': 'no-store',
          ...securityHeaders()
        })
        createReadStream(full).pipe(response)
        return
      }
      if (path.startsWith('/api/')) {
        sendJson(response, 404, { ok: false, error: '接口不存在' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false, error: '方法不允许' })
        return
      }
      await serveStatic(options.staticRoot, path, request, response)
    } catch (error) {
      if (error instanceof HttpError) {
        if (!response.headersSent) sendJson(response, error.status, { ok: false, error: error.message })
        return
      }
      throw error
    }
  }
}

async function serveStatic(root: string, requestPath: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const indexPath = join(root, 'index.html')
  const requested = requestPath === '/' ? indexPath : resolveInside(root, requestPath)
  let file = requested
  let info = file ? await stat(file).catch(() => null) : null
  if (!info?.isFile()) {
    const looksLikeAsset = requestPath.startsWith('/assets/') || extname(requestPath) !== ''
    if (looksLikeAsset || !file) {
      sendJson(response, 404, { ok: false, error: '页面不存在' })
      return
    }
    file = indexPath
    info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      sendJson(response, 503, { ok: false, error: '网页尚未构建' })
      return
    }
  }
  if (!file || !info) {
    sendJson(response, 404, { ok: false, error: '页面不存在' })
    return
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream'
  const cache = requestPath.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  response.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': cache,
    ...securityHeaders()
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
}
