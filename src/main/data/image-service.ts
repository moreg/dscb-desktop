import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { SettingsRepository } from './settings-repository'
import { killProcessTree } from './kill-process-tree'
import { COVER_GENERATION_SIZE } from './cover-frame'

/** 图像生成请求超时（毫秒）。大型绘图模型常需 3-6 分钟，预留 10 分钟与 CLI 对齐 */
const GENERATE_TIMEOUT_MS = 600_000
const EDIT_TIMEOUT_MS = 600_000

/** CLI 生图超时（秒）：codex/grok 走模型工具，预留更长 */
const CLI_GENERATE_TIMEOUT_SEC = 600
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_PIXELS = 40_000_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** 允许的参考图扩展名（防任意文件读取外传） */
export const ALLOWED_IMAGE_EXTS = /\.(png|jpg|jpeg|webp|gif|bmp)$/i

/** 出图通道 */
export type ImageChannel = 'api' | 'codex' | 'grok'

/** 解析 codex 可执行文件路径（与 codex-runner 相同的探测次序） */
function resolveCodexBin(): string {
  if (process.platform === 'win32') {
    const exe = join(
      homedir(),
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    )
    if (existsSync(exe)) return exe
    const cmd = join(homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd')
    if (existsSync(cmd)) return cmd
    // 可能装在其他位置：npm 全局目录
    const npmBin = join(homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd')
    if (existsSync(npmBin)) return npmBin
  }
  return 'codex'
}

/** 解析 grok 可执行文件路径 */
function resolveGrokBin(): string {
  if (process.platform === 'win32') {
    const exe = join(homedir(), '.grok', 'bin', 'grok.exe')
    if (existsSync(exe)) return exe
  }
  return 'grok'
}

/** Each CLI invocation writes to its own directory; stdout never selects another job's file. */
async function runCli(
  bin: string,
  args: string[],
  timeoutSec: number,
  cwd: string,
  stdinPrompt?: string,
  signal?: AbortSignal
): Promise<{ code: number; out: string; err: string }> {
  throwIfAborted(signal)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: bin.endsWith('.cmd'), cwd, detached: process.platform !== 'win32'
    })
    let out = ''
    let err = ''
    let settled = false
    let terminationError: Error | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    const appendOut = (data: Buffer) => { out = (out + data.toString()).slice(-12_000) }
    const appendErr = (data: Buffer) => { err = (err + data.toString()).slice(-12_000) }
    const ignoreStdinError = () => undefined
    const finish = (error?: Error, code = -1) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(terminationTimer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout.removeListener('data', appendOut)
      child.stderr.removeListener('data', appendErr)
      child.stdin.removeListener('error', ignoreStdinError)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (error) reject(error)
      else resolvePromise({ code, out, err })
    }
    const terminate = (error: Error) => {
      if (settled || terminationError) return
      terminationError = error
      clearTimeout(timer)
      // Wait for close before removing the task directory, with a bounded fallback.
      terminationTimer = setTimeout(() => finish(error), 2000)
      killProcessTree(child)
    }
    const onAbort = () => terminate(abortedError())
    const onError = (error: NodeJS.ErrnoException) => finish(terminationError ?? (
      error.code === 'ENOENT'
        ? new Error(`IMAGE_CLI_NOT_FOUND（未检测到 ${basename(bin).replace(/\.(exe|cmd)$/i, '')} CLI，请先安装并完成登录）`, { cause: error })
        : new Error(`IMAGE_CLI_SPAWN_FAILED: ${error.message}`, { cause: error })
    ))
    const onClose = (code: number | null) => finish(terminationError, code ?? -1)
    const timer = setTimeout(() => terminate(new Error('IMAGE_CLI_TIMEOUT')), timeoutSec * 1000)
    child.stdout.on('data', appendOut)
    child.stderr.on('data', appendErr)
    child.on('error', onError)
    child.on('close', onClose)
    child.stdin.on('error', ignoreStdinError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    if (stdinPrompt !== undefined) child.stdin.write(stdinPrompt, 'utf8')
    child.stdin.end()
  })
}

function abortedError(cause?: unknown): Error {
  return new Error('IMAGE_ABORTED（已取消本次图片生成）', cause === undefined ? undefined : { cause })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError(signal.reason)
}

function requestDeadline(timeout: number, caller?: AbortSignal): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let expired = false
  const cancel = () => controller.abort(caller?.reason)
  const timer = setTimeout(() => { expired = true; controller.abort(new Error('IMAGE_TIMEOUT')) }, timeout)
  caller?.addEventListener('abort', cancel, { once: true })
  if (caller?.aborted) cancel()
  return { signal: controller.signal, timedOut: () => expired, dispose: () => { clearTimeout(timer); caller?.removeEventListener('abort', cancel) } }
}

function imageType(bytes: Buffer): { mime: string; extension: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' }
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', extension: 'webp' }
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return { mime: 'image/gif', extension: 'gif' }
  if (bytes.subarray(0, 2).toString() === 'BM') return { mime: 'image/bmp', extension: 'bmp' }
  return null
}

async function validateImageBytes(bytes: Buffer, label: string): Promise<{ mime: string; extension: string }> {
  const type = imageType(bytes)
  if (!type) throw new Error(`${label}（文件内容不是支持的 PNG/JPEG/WebP/GIF/BMP 图片）`)
  try {
    // Reject advertised oversized rasters before native decoding allocates their pixel buffer.
    const dimensions = headerDimensions(bytes, type.extension)
    if (dimensions) validateDimensions(dimensions.width, dimensions.height)
    const { loadImage } = await import('skia-canvas')
    const image = await loadImage(bytes)
    validateDimensions(image.width, image.height)
  } catch (error) {
    throw new Error(`${label}（无法读取有效图片：${(error as Error).message}）`, { cause: error })
  }
  return type
}

function validateDimensions(width: number, height: number): void {
  if (!width || !height || width < 0 || height < 0) throw new Error('图片尺寸无效')
  if (width * height > MAX_REFERENCE_PIXELS || width > 16_384 || height > 16_384) throw new Error('图片分辨率过大，最多 4000 万像素，单边不超过 16384 像素')
}

function headerDimensions(bytes: Buffer, type: string): { width: number; height: number } | null {
  if (type === 'png' && bytes.length >= 24 && bytes.subarray(12, 16).toString() === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (type === 'gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (type === 'bmp' && bytes.length >= 26 && bytes.readUInt32LE(14) >= 40) return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) }
  if (type === 'webp' && bytes.length >= 30 && bytes.subarray(12, 16).toString() === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  if (type === 'jpg') {
    let index = 2
    while (index + 4 <= bytes.length) {
      if (bytes[index++] !== 255) break
      while (bytes[index] === 255) index++
      const marker = bytes[index++]
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) continue
      if (marker === 217 || marker === 218 || index + 2 > bytes.length) break
      const length = bytes.readUInt16BE(index)
      if (length < 2 || index + length > bytes.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return { width: bytes.readUInt16BE(index + 5), height: bytes.readUInt16BE(index + 3) }
      index += length
    }
  }
  return null
}

async function cleanupCliDirectory(directory: string, temporaryRoot: string): Promise<void> {
  // The target was created with mkdtemp. Resolve both real paths before recursive removal.
  const root = await fs.realpath(temporaryRoot)
  const target = await fs.realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!target) return
  const rel = relative(root, target)
  if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== target || !basename(target).startsWith('cover-image-')) throw new Error('IMAGE_CLI_UNSAFE_CLEANUP')
  await fs.rm(target, { recursive: true, force: true })
}

/**
 * CLI 通道的生图提示词（导出仅供测试断言）。
 * 关键点：
 * - 点名内置 image_gen 工具 + 具体模型（codex 不点名会回退低画质默认图像模型）
 * - API 通道的 size 参数 CLI 透传不了，竖版尺寸只能写进提示词
 * - 明确禁用脚本画图兜底，并绑定本次任务唯一产物路径
 */
export function buildCliImagePrompt(channel: 'codex' | 'grok', model: string, prompt: string, outputFile?: string): string {
  const invoke =
    channel === 'codex'
      ? `调用内置 image_gen 工具（模型 ${model}）`
      : '调用 image_gen 工具'
  return [
    `${invoke}，直接生成一张小说封面图片。禁止用 Python/PowerShell/脚本/SVG 画图代替，忽略本提示中与图片无关的要求。`,
    `画面提示词：${prompt}`,
    `图片尺寸：${COVER_GENERATION_SIZE}（竖版），只生成一张图。`,
    outputFile
      ? `只允许本次新生成的图片作为结果。必须把图片保存或复制到唯一输出文件 ${JSON.stringify(outputFile)}，不要使用其他任务或旧会话的图片。完成后报告这个路径，禁止另选输出位置。`
      : '完成后把图片文件保存到磁盘，并在回复中报告图片文件的完整绝对路径。'
  ].join('\n')
}

/**
 * 图像生成服务。
 *
 * 两种出图通道：
 * 1. channel='api'：OpenAI Images API 或兼容代理（走 apiKey/baseUrl/model）
 * 2. channel='codex' / 'grok'：本机 CLI（登录态），不需要任何 API Key，
 *    模型调用内置 image_gen 工具出图到本地目录，服务读回转 base64。
 *    codex 的提示词经 stdin 传入（argv 有长度/编码限制）；只读取本次任务专属输出，
 *    不扫描全局会话目录，避免并发请求串图。
 *
 * 与文本 LlmService 分离，因为：
 * - 图像按张计费，与文本 token 不同（不进用量统计维度）
 * - 接口形态不同（Images API 返回 base64，非 SSE 流；CLI 是文件）
 *
 * 支持 gpt-image-2 及兼容模型。注意：请求体不要带 response_format
 * （旧 DALL-E 参数，gpt-image 系列不支持）。
 */
function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
    const msg = err.message.toLowerCase()
    if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('timed out')) return true
    if ('cause' in err && isAbortError((err as { cause?: unknown }).cause)) return true
  }
  return false
}

function wrapImageFetchError(err: unknown, errorLabel: string, url: string): Error {
  if (err instanceof Error && err.message.startsWith(errorLabel)) {
    return err
  }
  if (isAbortError(err)) {
    return new Error(
      `IMAGE_TIMEOUT（图像生成请求超时，服务端在限定时间内未完成响应。大型绘图模型通常需 3-8 分钟，请稍后重试或检查接口提供方状态）`,
      { cause: err }
    )
  }

  let domain: string
  try {
    domain = new URL(url).hostname
  } catch {
    domain = url
  }

  const cause =
    err instanceof Error && 'cause' in err
      ? (err.cause as Record<string, unknown> | undefined)
      : undefined
  const code = typeof cause?.code === 'string' ? cause.code : ''
  const causeMsg = typeof cause?.message === 'string' ? cause.message : ''

  if (code === 'ECONNREFUSED') {
    return new Error(
      `IMAGE_NETWORK_ERROR（无法连接到 API 服务地址 [${domain}]，连接被拒绝 [ECONNREFUSED]。请检查 Base URL 端口是否正确或本地代理服务是否已开启）`,
      { cause: err }
    )
  }
  if (code === 'ENOTFOUND') {
    return new Error(
      `IMAGE_NETWORK_ERROR（无法解析 API 域名 [${domain}] [ENOTFOUND]，请检查网络是否连通或 Base URL 拼写是否正确）`,
      { cause: err }
    )
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(
      `IMAGE_NETWORK_ERROR（连接 API 服务器 [${domain}] 超时 [${code}]。可能是网络受阻，请检查网络连接或开启代理）`,
      { cause: err }
    )
  }
  if (code === 'ECONNRESET') {
    return new Error(
      `IMAGE_NETWORK_ERROR（与 API 服务器 [${domain}] 的连接被重置 [ECONNRESET]，网络中断或被防火墙拦截，请重试）`,
      { cause: err }
    )
  }
  if (causeMsg && /certificate|self[- ]?signed/i.test(causeMsg)) {
    return new Error(
      `IMAGE_NETWORK_ERROR（SSL/TLS 证书校验失败: ${causeMsg}）`,
      { cause: err }
    )
  }
  const detail = causeMsg || (err instanceof Error ? err.message : String(err))
  return new Error(
    `IMAGE_NETWORK_ERROR（网络请求失败 [${domain}]: ${detail}）`,
    { cause: err }
  )
}

export class ImageService {
  constructor(private readonly settings: SettingsRepository) {}

  /** 文生图：返回 base64（不含 data: 前缀） */
  async generate(prompt: string, size: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const cfg = await this.requireConfig()
    throwIfAborted(signal)
    if (cfg.channel === 'codex' || cfg.channel === 'grok') {
      return this.generateViaCli(cfg.channel, cfg.model, prompt, signal)
    }
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`
    // 不带 response_format（gpt-image 系列）
    const body: Record<string, unknown> = { model: cfg.model, prompt, size }
    const deadline = requestDeadline(GENERATE_TIMEOUT_MS, signal)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: deadline.signal
      })
      const result = await this.parseImageResponse(res, 'IMAGE_REQUEST_FAILED')
      throwIfAborted(signal)
      return result
    } catch (err) {
      if (signal?.aborted) throw abortedError(err)
      if (deadline.timedOut()) throw wrapImageFetchError(new Error('timeout', { cause: err }), 'IMAGE_REQUEST_FAILED', url)
      throw wrapImageFetchError(err, 'IMAGE_REQUEST_FAILED', url)
    } finally {
      deadline.dispose()
    }
  }

  /** 图生图：传参考图本地路径，返回 base64 */
  async edit(prompt: string, size: string, imagePath: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const cfg = await this.requireConfig()
    throwIfAborted(signal)
    // CLI 通道暂不支持图生图：codex/grok 的 image_gen 是文生图工具
    if (cfg.channel === 'codex' || cfg.channel === 'grok') {
      throw new Error(`IMAGE_CLI_NO_EDIT（${cfg.channel} 通道暂不支持参考图生图，请使用「API」通道或改为文生图）`)
    }
    let imgBuffer: Buffer
    try {
      const stat = await fs.stat(imagePath)
      if (!stat.isFile()) throw new Error('请选择图片文件')
      if (stat.size > MAX_REFERENCE_BYTES) throw new Error('参考图不能超过 20 MiB')
      imgBuffer = await fs.readFile(imagePath)
      if (imgBuffer.length > MAX_REFERENCE_BYTES) throw new Error('参考图不能超过 20 MiB')
    } catch (error) {
      throw new Error(`IMAGE_REFERENCE_INVALID（无法读取参考图：${(error as Error).message}）`, { cause: error })
    }
    throwIfAborted(signal)
    const type = await validateImageBytes(imgBuffer, 'IMAGE_REFERENCE_INVALID')
    throwIfAborted(signal)
    const imgBlob = new Blob([new Uint8Array(imgBuffer)], { type: type.mime })

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/edits`
    const form = new FormData()
    form.append('model', cfg.model)
    form.append('size', size)
    form.append('prompt', prompt)
    form.append('image', imgBlob, `${basename(imagePath, extname(imagePath))}.${type.extension}`)

    const deadline = requestDeadline(EDIT_TIMEOUT_MS, signal)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal: deadline.signal
      })
      const result = await this.parseImageResponse(res, 'IMAGE_EDIT_FAILED')
      throwIfAborted(signal)
      return result
    } catch (err) {
      if (signal?.aborted) throw abortedError(err)
      if (deadline.timedOut()) throw wrapImageFetchError(new Error('timeout', { cause: err }), 'IMAGE_EDIT_FAILED', url)
      throw wrapImageFetchError(err, 'IMAGE_EDIT_FAILED', url)
    } finally {
      deadline.dispose()
    }
  }

  /** CLI 通道生图：调 codex/grok，模型自动调 image_gen，读回最新产物 */
  private async generateViaCli(channel: 'codex' | 'grok', model: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const temporaryRoot = await fs.realpath(tmpdir())
    const outputDirectory = await fs.mkdtemp(join(temporaryRoot, 'cover-image-'))
    const outputFile = join(outputDirectory, 'generated.png')
    const cliPrompt = buildCliImagePrompt(channel, model, prompt, outputFile)
    let bin: string
    let args: string[]
    let stdinPrompt: string | undefined
    if (channel === 'codex') {
      bin = resolveCodexBin()
      // codex exec 无位置参数时从 stdin 读提示词；不进 argv（长度/编码限制）
      args = ['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check']
      stdinPrompt = cliPrompt
    } else {
      // grok CLI 原生 exe 走 argv 位置参数（未验证 stdin 支持，保持原行为）
      bin = resolveGrokBin()
      args = ['--output-format', 'plain', '--always-approve', '--max-turns', '3', cliPrompt]
    }

    try {
      const { code, out, err } = await runCli(bin, args, CLI_GENERATE_TIMEOUT_SEC, outputDirectory, stdinPrompt, signal)
      throwIfAborted(signal)
      if (code !== 0) throw new Error(`IMAGE_CLI_GENERATE_FAILED (${channel}, code=${code}): ${(err || out).slice(-400)}`)
      const stat = await fs.lstat(outputFile).catch(() => null)
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`IMAGE_CLI_NO_FILE（${channel} 没有在本次任务的输出位置生成图片）`)
      if (await fs.realpath(outputFile) !== outputFile) throw new Error('IMAGE_CLI_INVALID_OUTPUT（图片路径超出本次任务目录）')
      if (stat.size > MAX_RESPONSE_BYTES) throw new Error('IMAGE_CLI_INVALID_OUTPUT（图片文件超过 64 MiB）')
      const bytes = await fs.readFile(outputFile)
      await validateImageBytes(bytes, 'IMAGE_CLI_INVALID_OUTPUT')
      throwIfAborted(signal)
      return bytes.toString('base64')
    } finally {
      await cleanupCliDirectory(outputDirectory, temporaryRoot)
    }
  }

  /** 校验配置存在，返回脱敏前的完整配置（apiKey 不入日志） */
  private async requireConfig(): Promise<{ apiKey: string; baseUrl: string; model: string; channel: ImageChannel }> {
    const cfg = await this.settings.getCoverImageConfig()
    // CLI 通道不需要 apiKey；API 通道必须配 key
    if (cfg.channel === 'api' && !cfg.apiKey) throw new Error('IMAGE_NOT_CONFIGURED')
    return cfg
  }

  /** 统一解析图像 API 响应：校验 HTTP 状态 + 提取 b64_json */
  private async parseImageResponse(res: Response, errorLabel: string): Promise<string> {
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`${errorLabel} (${res.status}): ${errText.slice(0, 200)}`)
    }
    let json: { data?: Array<{ b64_json?: unknown }> }
    try { json = await res.json() as typeof json } catch (error) {
      throw new Error(`${errorLabel}（API 响应不是有效 JSON）`, { cause: error })
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.data)) throw new Error(`${errorLabel}: IMAGE_INVALID_RESPONSE（API 未返回图片数据数组）`)
    const b64 = json.data[0]?.b64_json
    if (typeof b64 !== 'string' || !b64.trim()) throw new Error(`${errorLabel}: IMAGE_EMPTY_RESPONSE（API 未返回有效的 b64_json 字符串）`)
    const normalized = b64.replace(/\s/g, '')
    if (normalized.length > Math.ceil(MAX_RESPONSE_BYTES / 3) * 4 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      throw new Error(`${errorLabel}: IMAGE_INVALID_RESPONSE（图片 base64 格式异常或超过 64 MiB）`)
    }
    if (Buffer.from(normalized, 'base64').toString('base64') !== normalized) throw new Error(`${errorLabel}: IMAGE_INVALID_RESPONSE（图片 base64 数据不完整）`)
    return normalized
  }
}
