import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { ChapterContent, ChapterMeta, MobileServerStatus, ProjectMeta } from '../../shared/types'
import { contentRevision, isChapterRevisionConflict } from '../data/chapter-revision'
import { MOBILE_PAGE, MOBILE_PAIRING_ERROR_PAGE } from './mobile-page'
import type { MobileReferenceReader } from './mobile-reference-service'
import { CHAPTER_NAME_MAX_LEN } from '../../shared/parsers'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_CHAPTER_CHARS = 500_000
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const SESSION_COOKIE = 'ai_writer_mobile_session'

export interface MobileProjectReader {
  listProjects(): Promise<ProjectMeta[]>
}

export interface MobileChapterReaderWriter {
  listChapters(projectId: string): Promise<ChapterMeta[]>
  getChapter(projectId: string, chapterNumber: number): Promise<ChapterContent>
  updateContent(
    projectId: string,
    chapterNumber: number,
    content: string,
    expectedRevision?: string
  ): Promise<ChapterMeta>
  updateMeta(
    projectId: string,
    chapterNumber: number,
    patch: { title?: string }
  ): Promise<ChapterMeta>
}

export interface MobileAiWriter {
  generateChapterStream(
    projectId: string,
    chapterNumber: number,
    options: { existingText?: string; tempContext?: string; maxTokens?: number }
  ): Promise<string>
  adjustChapterStream(
    projectId: string,
    chapterNumber: number,
    content: string,
    instruction: string,
    options: { maxTokens?: number }
  ): Promise<string>
}

interface SessionRecord {
  expiresAt: number
}

export class MobileServer {
  private server: Server | null = null
  private port = 0
  private pairToken = ''
  private pairingAvailable = false
  private readonly sessions = new Map<string, SessionRecord>()
  private lifecycleTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly projects: MobileProjectReader,
    private readonly chapters: MobileChapterReaderWriter,
    private readonly references?: MobileReferenceReader,
    private readonly ai?: MobileAiWriter
  ) {}

  start(): Promise<MobileServerStatus> {
    return this.runLifecycle(() => this.startUnlocked())
  }

  private async startUnlocked(): Promise<MobileServerStatus> {
    if (this.server) return this.getStatus()
    this.pairToken = createSecret(18)
    this.pairingAvailable = true
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (isChapterRevisionConflict(error)) {
          this.sendJson(response, 409, { error: '电脑端内容已发生变化，请重新打开章节' })
          return
        }
        if (error instanceof MobileHttpError) {
          this.sendJson(response, error.status, { error: error.publicMessage })
          return
        }
        console.error('[mobile-server] request failed:', error)
        this.sendJson(response, 500, { error: '服务器内部错误' })
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, '0.0.0.0')
      })
    } catch (error) {
      this.pairToken = ''
      this.pairingAvailable = false
      server.closeAllConnections()
      throw error
    }
    this.server = server
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    return this.getStatus()
  }

  stop(): Promise<MobileServerStatus> {
    return this.runLifecycle(() => this.stopUnlocked())
  }

  private async stopUnlocked(): Promise<MobileServerStatus> {
    const server = this.server
    this.server = null
    this.port = 0
    this.pairToken = ''
    this.pairingAvailable = false
    this.sessions.clear()
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    return this.getStatus()
  }

  refreshPairing(): Promise<MobileServerStatus> {
    return this.runLifecycle(async () => {
      if (!this.server) return this.startUnlocked()
      this.pairToken = createSecret(18)
      this.pairingAvailable = true
      return this.getStatus()
    })
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation)
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async getStatus(): Promise<MobileServerStatus> {
    this.pruneSessions()
    if (!this.server || !this.port) {
      return {
        running: false,
        addressUrls: [],
        pairingUrl: null,
        qrDataUrl: null,
        pairingAvailable: false,
        pairedDevices: 0,
        accessibleOnLan: false
      }
    }
    const addresses = getLanAddresses()
    const addressUrls = (addresses.length ? addresses : ['127.0.0.1']).map(
      (address) => `http://${address}:${this.port}`
    )
    const pairingUrl = this.pairingAvailable
      ? `${addressUrls[0]}/?pair=${encodeURIComponent(this.pairToken)}`
      : null
    const qrDataUrl = pairingUrl
      ? await QRCode.toDataURL(pairingUrl, { width: 360, margin: 2, errorCorrectionLevel: 'M' })
      : null
    return {
      running: true,
      addressUrls,
      pairingUrl,
      qrDataUrl,
      pairingAvailable: this.pairingAvailable,
      pairedDevices: this.sessions.size,
      accessibleOnLan: addresses.length > 0
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response)
    const method = request.method || 'GET'
    const url = new URL(request.url || '/', 'http://127.0.0.1')

    if (method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('pair')) {
      if (!this.consumePairToken(url.searchParams.get('pair') || '')) {
        this.sendHtml(response, 401, MOBILE_PAIRING_ERROR_PAGE)
        return
      }
      const sessionId = createSecret(32)
      this.sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS })
      response.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      )
      response.writeHead(303, { Location: '/' })
      response.end()
      return
    }

    if (!this.isAuthorized(request)) {
      if (method === 'GET' && url.pathname === '/') {
        this.sendHtml(response, 401, MOBILE_PAIRING_ERROR_PAGE)
      } else {
        this.sendJson(response, 401, { error: '连接已失效，请重新扫码' })
      }
      return
    }

    if (method === 'GET' && url.pathname === '/') {
      this.sendHtml(response, 200, MOBILE_PAGE)
      return
    }
    if (method === 'GET' && url.pathname === '/api/projects') {
      const projects = (await this.projects.listProjects()).map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        genre: project.genre
      }))
      this.sendJson(response, 200, { projects })
      return
    }

    const chapterListMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/chapters$/)
    if (method === 'GET' && chapterListMatch) {
      const projectId = decodePathPart(chapterListMatch[1])
      const chapters = await this.chapters.listChapters(projectId)
      this.sendJson(response, 200, { chapters: chapters.map(publicChapterMeta) })
      return
    }

    const referenceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/references$/)
    if (method === 'GET' && referenceMatch) {
      if (!this.references) {
        this.sendJson(response, 501, { error: '资料服务暂不可用' })
        return
      }
      const projectId = decodePathPart(referenceMatch[1])
      this.sendJson(response, 200, { library: await this.references.getLibrary(projectId) })
      return
    }

    const searchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/search$/)
    if (method === 'GET' && searchMatch) {
      if (!this.references) {
        this.sendJson(response, 501, { error: '搜索服务暂不可用' })
        return
      }
      const query = (url.searchParams.get('q') || '').trim()
      if (!query) {
        this.sendJson(response, 400, { error: '请输入搜索内容' })
        return
      }
      if (query.length > 80) {
        this.sendJson(response, 400, { error: '搜索内容不能超过 80 个字符' })
        return
      }
      const projectId = decodePathPart(searchMatch[1])
      this.sendJson(response, 200, { results: await this.references.search(projectId, query) })
      return
    }

    const chapterMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/chapters\/(\d+)$/)
    if (chapterMatch) {
      const projectId = decodePathPart(chapterMatch[1])
      const chapterNumber = Number(chapterMatch[2])
      if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
        this.sendJson(response, 400, { error: '章节编号无效' })
        return
      }
      if (method === 'GET') {
        const chapter = await this.chapters.getChapter(projectId, chapterNumber)
        const detail = this.references
          ? await this.references.getChapterDetail(projectId, chapterNumber)
          : null
        this.sendJson(response, 200, {
          chapter: { meta: publicChapterMeta(chapter.meta), content: chapter.content },
          revision: contentRevision(chapter.content),
          detail
        })
        return
      }
      if (method === 'PUT') {
        const body = await readJsonBody(request)
        const content = body.content
        const baseRevision = body.baseRevision
        if (typeof content !== 'string' || typeof baseRevision !== 'string') {
          this.sendJson(response, 400, { error: '正文或版本信息无效' })
          return
        }
        if (content.length > MAX_CHAPTER_CHARS) {
          this.sendJson(response, 413, { error: '正文内容过大' })
          return
        }
        const meta = await this.chapters.updateContent(
          projectId,
          chapterNumber,
          content,
          baseRevision
        )
        this.sendJson(response, 200, { meta: publicChapterMeta(meta), revision: contentRevision(content) })
        return
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(request)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (!title) {
          this.sendJson(response, 400, { error: '章节标题不能为空' })
          return
        }
        if (title.length > CHAPTER_NAME_MAX_LEN) {
          this.sendJson(response, 400, { error: `章节标题不能超过 ${CHAPTER_NAME_MAX_LEN} 个字符` })
          return
        }
        const meta = await this.chapters.updateMeta(projectId, chapterNumber, { title })
        this.sendJson(response, 200, { meta: publicChapterMeta(meta) })
        return
      }
      if (method === 'POST' && url.searchParams.get('action') === 'ai') {
        if (!this.ai) {
          this.sendJson(response, 501, { error: 'AI 写作服务暂不可用' })
          return
        }
        const body = await readJsonBody(request)
        const mode = body.mode
        const content = body.content
        const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''
        if ((mode !== 'continue' && mode !== 'rewrite') || typeof content !== 'string') {
          this.sendJson(response, 400, { error: 'AI 写作参数无效' })
          return
        }
        if (content.length > MAX_CHAPTER_CHARS) {
          this.sendJson(response, 413, { error: '正文内容过大' })
          return
        }
        if (instruction.length > 2_000) {
          this.sendJson(response, 400, { error: '写作要求不能超过 2000 个字符' })
          return
        }
        if (mode === 'rewrite' && !instruction) {
          this.sendJson(response, 400, { error: '重写时请输入具体要求' })
          return
        }
        const text = mode === 'continue'
          ? await this.ai.generateChapterStream(projectId, chapterNumber, {
              existingText: content,
              tempContext: instruction || undefined,
              maxTokens: 4_096
            })
          : await this.ai.adjustChapterStream(
              projectId,
              chapterNumber,
              content,
              instruction,
              { maxTokens: 8_192 }
            )
        this.sendJson(response, 200, { mode, text })
        return
      }
    }

    this.sendJson(response, 404, { error: '接口不存在' })
  }

  private consumePairToken(candidate: string): boolean {
    if (!this.pairingAvailable || !candidate || !this.pairToken) return false
    const expected = Buffer.from(this.pairToken)
    const actual = Buffer.from(candidate)
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual)
    if (matches) {
      this.pairingAvailable = false
      this.pairToken = ''
    }
    return matches
  }

  private isAuthorized(request: IncomingMessage): boolean {
    this.pruneSessions()
    const cookies = parseCookies(request.headers.cookie || '')
    const sessionId = cookies.get(SESSION_COOKIE)
    if (!sessionId) return false
    const session = this.sessions.get(sessionId)
    if (!session || session.expiresAt <= Date.now()) return false
    session.expiresAt = Date.now() + SESSION_TTL_MS
    return true
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id)
    }
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    )
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  private sendHtml(response: ServerResponse, status: number, body: string): void {
    if (response.headersSent) return
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(body)
  }
}

function createSecret(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function publicChapterMeta(meta: ChapterMeta): ChapterMeta {
  return {
    schemaVersion: meta.schemaVersion,
    updatedAt: meta.updatedAt,
    chapterNumber: meta.chapterNumber,
    title: meta.title,
    wordCount: meta.wordCount,
    status: meta.status,
    synopsis: meta.synopsis,
    volume: meta.volume,
    emotion: meta.emotion,
    climax: meta.climax,
    appearingCharacters: meta.appearingCharacters
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new MobileHttpError(400, '路径参数无效')
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new MobileHttpError(413, '请求内容过大')
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new MobileHttpError(400, '请求内容不是有效 JSON')
  }
}

class MobileHttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string
  ) {
    super(publicMessage)
    this.name = 'MobileHttpError'
  }
}

function parseCookies(header: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim())
  }
  return result
}

function getLanAddresses(): string[] {
  const candidates: Array<{ address: string; score: number }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      const address = entry.address
      if (!isPrivateIpv4(address)) continue
      const lowered = name.toLowerCase()
      let score = address.startsWith('192.168.') ? 100 : address.startsWith('10.') ? 80 : 70
      if (/wi-?fi|wlan|ethernet|以太网|无线/.test(lowered)) score += 30
      if (/virtual|vmware|vethernet|wsl|docker|hyper-v|loopback/.test(lowered)) score -= 80
      candidates.push({ address, score })
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .map((item) => item.address)
    .filter((address, index, all) => all.indexOf(address) === index)
}

function isPrivateIpv4(address: string): boolean {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true
  const match = address.match(/^172\.(\d+)\./)
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
}
