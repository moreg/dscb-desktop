import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, join } from 'path'
import type { SettingsRepository } from './settings-repository'
import { killProcessTree } from './kill-process-tree'

/** 图像生成请求超时（毫秒）。大型绘图模型常需 3-6 分钟，预留 10 分钟与 CLI 对齐 */
const GENERATE_TIMEOUT_MS = 600_000
const EDIT_TIMEOUT_MS = 600_000

/** CLI 生图超时（秒）：codex/grok 走模型工具，预留更长 */
const CLI_GENERATE_TIMEOUT_SEC = 600

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

/**
 * 在 CLI 图片目录里找最新生成的图片文件。
 * codex：~/.codex/generated_images/<session>/exec-*.png
 * grok：~/.grok/sessions/<session>/images/*.jpg（路径里含 URL 编码的 Temp）
 */
async function findLatestImage(bin: 'codex' | 'grok', notBefore: number): Promise<string> {
  const roots =
    bin === 'codex'
      ? [join(homedir(), '.codex', 'generated_images')]
      : [join(homedir(), '.grok', 'sessions')]

  const candidates: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[])
    for (const entry of entries) {
      if (entry.isFile()) {
        candidates.push(join(root, entry.name))
      } else if (entry.isDirectory()) {
        // session 子目录：grok 的图片在 <session>/images/，codex 直接在 <session>/ 下
        const sessionDir = join(root, entry.name)
        const imgDir = join(sessionDir, 'images')
        for (const f of await fs.readdir(imgDir).catch(() => [] as string[])) {
          candidates.push(join(imgDir, f))
        }
        for (const f of await fs.readdir(sessionDir).catch(() => [] as string[])) {
          candidates.push(join(sessionDir, f))
        }
      }
    }
  }

  let latestPath: string | null = null
  let latestMtime = -1
  for (const full of candidates) {
    if (!/\.(png|jpg|jpeg)$/i.test(full)) continue
    try {
      const st = await fs.stat(full)
      if (st.mtimeMs >= notBefore && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs
        latestPath = full
      }
    } catch {
      /* 无权限等，跳过 */
    }
  }
  if (!latestPath) throw new Error(`IMAGE_CLI_NO_FILE（${bin} 未产出图片文件）`)
  return latestPath
}

/** CLI 子进程执行：完成/超时/出错都返回 stdout+stderr。stdinPrompt 存在时经 stdin 传入 */
async function runCli(
  bin: string,
  args: string[],
  timeoutSec: number,
  stdinPrompt?: string
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const isCmd = bin.endsWith('.cmd')
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isCmd,
      cwd: tmpdir()
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        killProcessTree(child)
        reject(new Error('IMAGE_CLI_TIMEOUT'))
      }
    }, timeoutSec * 1000)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT'
        reject(
          enoent
            ? new Error(
                `IMAGE_CLI_NOT_FOUND（未检测到 ${basename(bin).replace(/\.(exe|cmd)$/i, '')} CLI，请先安装并完成登录）`
              )
            : new Error(`IMAGE_CLI_SPAWN_FAILED: ${e.message}`)
        )
      }
    })
    // prompt 走 stdin（不进 argv）：绕开 Windows 命令行长度上限与 .cmd shell 的中文编码问题。
    // 无 prompt 时也立即 end，避免 CLI 等 stdin 挂起。
    child.stdin.on('error', () => {
      /* EPIPE：进程提前退出，由 close 分支处理 */
    })
    if (stdinPrompt !== undefined) child.stdin.write(stdinPrompt, 'utf8')
    child.stdin.end()

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

/** 从文件读出 base64（不含 data: 前缀），保证 cover-service 落盘逻辑不动 */
async function fileToBase64(path: string): Promise<string> {
  const buf = await fs.readFile(path)
  return buf.toString('base64')
}

/**
 * CLI 通道的生图提示词（导出仅供测试断言）。
 * 关键点：
 * - 点名内置 image_gen 工具 + 具体模型（codex 不点名会回退低画质默认图像模型）
 * - API 通道的 size 参数 CLI 透传不了，竖版尺寸只能写进提示词
 * - 明确禁用脚本画图兜底，并要求报告产物绝对路径（失败时按路径/目录双兜底捞图）
 */
export function buildCliImagePrompt(channel: 'codex' | 'grok', model: string, prompt: string): string {
  const invoke =
    channel === 'codex'
      ? `调用内置 image_gen 工具（模型 ${model}）`
      : '调用 image_gen 工具'
  return [
    `${invoke}，直接生成一张小说封面图片。禁止用 Python/PowerShell/脚本/SVG 画图代替，忽略本提示中与图片无关的要求。`,
    `画面提示词：${prompt}`,
    '图片尺寸：1024x1536（竖版），只生成一张图。',
    '完成后把图片文件保存到磁盘，并在回复中报告图片文件的完整绝对路径。'
  ].join('\n')
}

/**
 * 图像生成服务。
 *
 * 两种出图通道：
 * 1. channel='api'：OpenAI Images API 或兼容代理（走 apiKey/baseUrl/model）
 * 2. channel='codex' / 'grok'：本机 CLI（登录态），不需要任何 API Key，
 *    模型调用内置 image_gen 工具出图到本地目录，服务读回转 base64。
 *    codex 的提示词经 stdin 传入（argv 有长度/编码限制）；产物优先取 stdout 里的路径，
 *    取不到再扫 ~/.codex/generated_images（codex 落盘复制步骤有已知缺陷，见
 *    openai/codex#28887）。
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

  let domain = ''
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
  async generate(prompt: string, size: string): Promise<string> {
    const cfg = await this.requireConfig()
    if (cfg.channel === 'codex' || cfg.channel === 'grok') {
      return this.generateViaCli(cfg.channel, cfg.model, prompt)
    }
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`
    // 不带 response_format（gpt-image 系列）
    const body: Record<string, unknown> = { model: cfg.model, prompt, size }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS)
      })
      return await this.parseImageResponse(res, 'IMAGE_REQUEST_FAILED')
    } catch (err) {
      throw wrapImageFetchError(err, 'IMAGE_REQUEST_FAILED', url)
    }
  }

  /** 图生图：传参考图本地路径，返回 base64 */
  async edit(prompt: string, size: string, imagePath: string): Promise<string> {
    const cfg = await this.requireConfig()
    // CLI 通道暂不支持图生图：codex/grok 的 image_gen 是文生图工具
    if (cfg.channel === 'codex' || cfg.channel === 'grok') {
      throw new Error(`IMAGE_CLI_NO_EDIT（${cfg.channel} 通道暂不支持参考图生图，请使用「API」通道或改为文生图）`)
    }
    const imgBuffer = await fs.readFile(imagePath)
    const imgBlob = new Blob([imgBuffer])

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/edits`
    const form = new FormData()
    form.append('model', cfg.model)
    form.append('size', size)
    form.append('prompt', prompt)
    form.append('image', imgBlob, basename(imagePath))

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(EDIT_TIMEOUT_MS)
      })
      return await this.parseImageResponse(res, 'IMAGE_EDIT_FAILED')
    } catch (err) {
      throw wrapImageFetchError(err, 'IMAGE_EDIT_FAILED', url)
    }
  }

  /** CLI 通道生图：调 codex/grok，模型自动调 image_gen，读回最新产物 */
  private async generateViaCli(channel: 'codex' | 'grok', model: string, prompt: string): Promise<string> {
    const startedAt = Date.now()
    const cliPrompt = buildCliImagePrompt(channel, model, prompt)
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

    const { code, out, err } = await runCli(bin, args, CLI_GENERATE_TIMEOUT_SEC, stdinPrompt)

    // 先尝试从 stdout 里找绝对路径；找不到则翻目录按 mtime 找
    const pathFromOutput = out.match(/[A-Za-z]:[\\/][^\s`"']+\.(?:png|jpg|jpeg)/i)?.[0]
    if (pathFromOutput && existsSync(pathFromOutput)) {
      return fileToBase64(pathFromOutput)
    }

    const found = await findLatestImage(channel, startedAt - 2000).catch(() => null)
    if (found) {
      return fileToBase64(found)
    }

    const tail = out.slice(-400) || err.slice(-400)
    throw new Error(`IMAGE_CLI_GENERATE_FAILED (${channel}, code=${code}): ${tail}`)
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
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> }
    const b64 = json.data?.[0]?.b64_json
    if (!b64) throw new Error('IMAGE_EMPTY_RESPONSE（API 未返回 b64_json）')
    return b64
  }
}
