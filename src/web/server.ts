import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { startBackend } from '../main/backend'
import { configureShim, invokeTab, releaseTab, retainTab, subscribeTab } from './electron-shim'
import { createWebHandler } from './http-app'

async function ensureDataKey(userData: string): Promise<void> {
  const configured = process.env.WEB_DATA_KEY?.trim()
  if (configured) {
    process.env.WEB_DATA_KEY = configured
    return
  }
  const file = join(userData, 'web-data.key')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing) {
      process.env.WEB_DATA_KEY = existing
      return
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  const key = randomBytes(32).toString('hex')
  await mkdir(userData, { recursive: true })
  await writeFile(file, key, { mode: 0o600 })
  process.env.WEB_DATA_KEY = key
}

async function main(): Promise<void> {
  const token = process.env.WEB_ACCESS_TOKEN?.trim()
  if (!token) {
    console.error('缺少 WEB_ACCESS_TOKEN。服务器上的作品和模型密钥需要口令才能打开。')
    process.exit(1)
  }
  const port = Number(process.env.WEB_PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('WEB_PORT 无效')
    process.exit(1)
  }
  const host = process.env.WEB_HOST?.trim() || '0.0.0.0'
  const userData = resolve(process.env.WEB_DATA_DIR?.trim() || join(process.cwd(), 'data'))
  const exportsDir = join(userData, 'exports')
  await mkdir(userData, { recursive: true })
  await mkdir(exportsDir, { recursive: true })
  await ensureDataKey(userData)
  configureShim({ userData, exportsDir })

  const backend = await startBackend(userData, {
    open: () => ({ ok: true, focusedExisting: false }),
    bind: () => ({ ok: true, focusedExisting: false })
  })
  const staticRoot = resolve(process.env.WEB_RENDERER_DIR?.trim() || join(process.cwd(), 'out', 'web', 'renderer'))
  const handler = createWebHandler({
    accessToken: token,
    staticRoot,
    exportsDir,
    invoke: invokeTab,
    subscribeTab,
    retainTab,
    releaseTab
  })
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      console.error('[web]', error instanceof Error ? error.message : error)
      if (response.headersSent) {
        response.end()
        return
      }
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: '服务器内部错误' }))
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolveListen())
  })
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host
  console.log(`大神持笔 Web 已启动：http://${shownHost}:${port}`)
  console.log(`数据目录：${userData}`)

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    server.close()
    void backend.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
