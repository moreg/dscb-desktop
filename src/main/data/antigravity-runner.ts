import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageInfo } from './llm-service'

/**
 * Antigravity CLI (agy) 子进程执行器。
 *
 * agy 不提供 HTTP API，只能作为本地命令行调用。使用 `-p`（--print）headless 单轮模式：
 *   agy -p "<prompt>" --dangerously-skip-permissions --print-timeout <timeout> [--model "<name>"]
 *
 * prompt 作为 `-p` 的参数传入（非 stdin）。实测 agy 1.1.1 的 `-p` 不从 stdin 读取--
 * 若 stdin 传 prompt、`-p` 不带值，agy 会把命令行上其他 flag（如 --dangerously-skip-permissions）
 * 当成对话内容返回，导致输出"解释 flag 含义"而非响应 prompt。
 *
 * 命令行长度限制：Windows CreateProcess 上限约 32767 字符（含 exe 路径 + 所有参数）。
 * 网文正文生成的 systemPrompt + prompt 通常在数千字以内，远低于限制。
 * 超长 prompt（> 30000 字符）时回退到临时文件 + stdin 兜底，避免 spawn 失败。
 *
 * 注意：不要加 `--sandbox`。该标志会让 agy 在受限沙箱里运行（无当前 workspace），
 * 触发 agy 内置的"是否创建 sandbox 目录"引导话术，被当成模型输出返回。
 * `--dangerously-skip-permissions` 已自动批准所有工具权限，无需额外沙箱隔离。
 *
 * 实测行为（agy 1.1.1）：
 * - stdout 是纯净响应文本，无 agent 思考日志混入
 * - 正常生成：exit 0，stdout=模型输出，stderr 空
 * - 超时/错误：exit 1，stdout 部分内容或空，stderr="Error: ..."（错误在 stderr，不是 stdout）
 * - 认证失败：exit 1，stdout 空，stderr="Error: ...sign in..."
 * - 认证靠本机 Google OAuth（用户需先交互式 `agy` 登录一次）
 * - 并发不安全：多个 agy -p 同时跑会互相干扰（共享 brain 目录），需串行化
 * - `-p` 是单轮模式，不支持 sessionId 续聊
 */
export interface AntigravityOptions {
  /** 模型显示名（如 "Gemini 3.1 Pro (High)"）；空则走 agy 默认模型 */
  model?: string
  /** 超时（秒），默认 300 */
  timeoutSec?: number
  /** 流式 token 回调（agy 实际非流式，按 stdout 数据块伪流式喂回） */
  onToken?: (token: string) => void
  /** 中止信号 */
  signal?: AbortSignal
}

export interface AntigravityResult {
  full: string
  usage: UsageInfo | null
}

/**
 * 解析 agy 可执行文件路径。
 * Windows 上 Electron 的 spawn 不会自动查 PATH，且 agy 是 .exe（不是 .cmd），
 * 需拼绝对路径。Unix 上 PATH 可用，直接返回命令名。
 */
function resolveAgyBin(): string {
  if (process.platform === 'win32') {
    const exe = join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
    if (existsSync(exe)) return exe
  }
  return 'agy'
}

/** agy 可执行文件路径（Windows 用绝对路径，其他平台用 PATH 查找） */
const AGY_BIN = resolveAgyBin()

/**
 * 计算 Buffer 中最后一个完整 UTF-8 字符的结束位置。
 * 用于流式解码时防止多字节字符（如中文，3 字节）被 chunk 边界截断成乱码（�）。
 * 返回可安全 toString('utf8') 的字节长度，尾部不完整字节留给下一个 chunk 拼接。
 */
function utf8CompleteLength(buf: Buffer): number {
  if (buf.length === 0) return 0
  // UTF-8 多字节字符的首字节前缀位标识了该字符的总字节数：
  //   110xxxxx -> 2 字节, 1110xxxx -> 3 字节, 11110xxx -> 4 字节
  // 从末尾往回找，定位最后一个字符的首字节
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - 3); i--) {
    const byte = buf[i]
    let charLen: number
    if ((byte & 0x80) === 0) continue // 0xxxxxxx: 单字节 ASCII，本身就是完整字符
    if ((byte & 0xe0) === 0xc0) charLen = 2 // 110xxxxx
    else if ((byte & 0xf0) === 0xe0) charLen = 3 // 1110xxxx
    else if ((byte & 0xf8) === 0xf0) charLen = 4 // 11110xxx
    else continue // 10xxxxxx: 续字节，继续往前找首字节

    // 从位置 i 开始的字符是否完整（剩余字节够不够）
    if (i + charLen <= buf.length) {
      // 这个字符完整，说明它前面所有字符都已完整
      return buf.length
    }
    // 字符不完整：截断到最后一个完整字符的末尾
    return i
  }
  // 全是续字节（理论上不会发生，除非数据本身就是损坏的）
  return buf.length
}

/** 默认超时 5 分钟（对齐 agy --print-timeout 默认 5m） */
const DEFAULT_TIMEOUT_SEC = 300

/**
 * 命令行长度安全上限（字符数）。
 * Windows CreateProcessW 上限约 32767 字符（含 exe 路径 + 所有参数）。
 * 留 ~2000 字符余量给 exe 路径 + flag 参数。
 * 超过此值时返回明确错误，不再尝试不可靠的"让 agent 读文件"方案
 * （agy agent 行为不可控，不会可靠地读取并执行文件内容）。
 */
const ARG_MAX_SAFE = 30000

/**
 * 模块级串行化锁。agy 并发不安全（共享 brain 目录 / last_conversations.json），
 * 同时跑多个 -p 会互相干扰。用一个 Promise 链保证串行执行。
 */
let agyChain: Promise<unknown> = Promise.resolve()

/**
 * 调用 agy -p 执行单轮生成。
 *
 * prompt 作为 `-p` 参数传入；stdout 按数据块喂回 onToken（伪流式）。
 * 超长 prompt（> 30000 字符）时返回 AGY_PROMPT_TOO_LARGE 错误，
 * 提示用户精简设定/细纲/角色卡内容。
 * 完成后返回完整文本与估算用量（agy 不返回 token 数，按 1 字 ≈ 1.5 token 估算）。
 */
export function runAntigravity(
  prompt: string,
  opts: AntigravityOptions = {}
): Promise<AntigravityResult> {
  const exec = () => runAntigravityOnce(prompt, opts)
  // 串行化：前一个 agy 调用完成（或失败）后才跑下一个
  const next = agyChain.then(exec, exec) // 即使前一个失败也继续
  agyChain = next.catch(() => {}) // 锁链不因业务错误断裂
  return next
}

async function runAntigravityOnce(
  prompt: string,
  opts: AntigravityOptions
): Promise<AntigravityResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

  // prompt 作为 -p 参数传入（agy 不从 stdin 读取）。
  // 超长 prompt 直接报错：agy agent 不可靠地读取文件内容，
  // 且超长 prompt 通常意味着项目设定/细纲/角色卡过于冗长，应精简而非绕过。
  if (prompt.length > ARG_MAX_SAFE) {
    throw new Error(
      `AGY_ERROR: prompt 过长（${prompt.length} 字符 > ${ARG_MAX_SAFE} 上限），` +
      '请精简设定/细纲/角色卡内容，或减少续写时的上文长度。'
    )
  }

  const args: string[] = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${timeoutSec}s`
  ]
  if (opts.model && opts.model.trim()) {
    args.push('--model', opts.model.trim())
  }

  return new Promise<AntigravityResult>((resolve, reject) => {
    const child = spawn(AGY_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

      let stdoutBuf = ''
      let stderrBuf = ''
      let stdoutPending = Buffer.alloc(0) // 跨 chunk 的不完整 UTF-8 尾部字节
      let stderrPending = Buffer.alloc(0)
      let settled = false

      // 中止信号
      const onAbort = (): void => {
        if (!settled && !child.killed) {
          child.kill('SIGTERM')
        }
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort()
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      // 进程结束时移除 abort 监听器，避免 AbortSignal 上残留监听器
      const cleanup = (): void => {
        opts.signal?.removeEventListener('abort', onAbort)
      }

      child.stdout.on('data', (chunk: Buffer) => {
        // 防止 UTF-8 多字节字符被 chunk 边界截断导致乱码（�）：
        // 中文字符占 3 字节，若 chunk 恰好在字符中间断开，toString('utf8') 会输出 U+FFFD。
        // 方案：拼上前一个 chunk 的尾部残留，按完整字符边界截取，不完整的尾部留给下一个 chunk。
        const combined = Buffer.concat([stdoutPending, chunk])
        const completeLen = utf8CompleteLength(combined)
        const decoded = combined.subarray(0, completeLen).toString('utf8')
        stdoutPending = combined.subarray(completeLen)
        stdoutBuf += decoded
        opts.onToken?.(decoded)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const combined = Buffer.concat([stderrPending, chunk])
        const completeLen = utf8CompleteLength(combined)
        stderrBuf += combined.subarray(0, completeLen).toString('utf8')
        stderrPending = combined.subarray(completeLen)
      })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        cleanup()
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') {
          reject(new Error('AGY_NOT_FOUND'))
        } else {
          reject(new Error(`AGY_SPAWN_FAILED: ${e.message}`))
        }
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        cleanup()

        // flush 残留的不完整 UTF-8 尾部字节（正常情况应为空，防御性处理）
        if (stdoutPending.length > 0) {
          const rest = stdoutPending.toString('utf8')
          stdoutBuf += rest
          opts.onToken?.(rest)
          stdoutPending = Buffer.alloc(0)
        }

        // abort 场景
        if (opts.signal?.aborted) {
          reject(new Error('LLM_TIMEOUT'))
          return
        }

        const full = stdoutBuf
        const trimmed = full.trim()

        // agy 1.1.1 错误行为（实测）：
        // - 正常生成：exit 0，stdout=模型输出，stderr 空
        // - 超时/错误：exit 1，stdout 可能有部分 agent 思考文本（非正文），stderr="Error: ..."
        // - 认证失败：exit 1，stdout 空，stderr="Error: ...sign in..."
        // 错误信息在 stderr（不是 stdout），需同时检查 stderr + 退出码。
        // exit 非 0 即为错误：即使 stdout 有部分内容，也是 agent 的思考过程而非正文。
        const stderrTrimmed = stderrBuf.trim()
        const hasError =
          /^Error:/i.test(trimmed) || /^Error:/i.test(stderrTrimmed) || code !== 0

        if (hasError) {
          // 优先取 stderr 的 Error 行，其次 stdout
          const errorSource = stderrTrimmed || trimmed
          const msg = errorSource.split('\n')[0].replace(/^Error:\s*/i, '')
          if (/authenticat|sign\s*in|credential|unauthorized|401|403/i.test(msg)) {
            reject(new Error('LLM_AUTH_FAILED'))
          } else if (/timed?\s*out|timeout/i.test(msg)) {
            reject(new Error('LLM_TIMEOUT'))
          } else if (/rate|quota|limit/i.test(msg)) {
            reject(new Error('LLM_RATE_LIMIT'))
          } else if (msg) {
            reject(new Error(`AGY_ERROR: ${msg}`))
          } else {
            // exit 非 0 但无明确错误信息
            reject(new Error(`AGY_ERROR: agy exited with code ${code}`))
          }
          return
        }

        // stderr 有内容但 stdout 也成功 -- 记日志但不阻断（agy 有时往 stderr 写警告）
        if (stderrTrimmed) {
          console.warn('[antigravity] stderr:', stderrTrimmed.slice(0, 200))
        }

        // 用量估算：agy 不返回 token 数，按 1 字 ≈ 1.5 token 估算（与 llm-service fallback 一致）
        const outputTokens = Math.ceil(full.length / 1.5)
        const usage: UsageInfo = {
          inputTokens: 0,
          outputTokens,
          totalTokens: outputTokens
        }
        resolve({ full, usage })
      })

      // stdin 立即关闭（prompt 已作为 -p 参数传入，不再走 stdin）
      child.stdin.end()
    })
}

/**
 * 探测 agy 是否已安装并可用（不触发模型调用）。
 * `agy --version` 不需要认证，可安全用于预检。
 * @returns 版本号或 null（未安装）
 */
export async function probeAntigravity(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(AGY_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim())
      else resolve(null)
    })
  })
}

/**
 * 列出 agy 可用模型（`agy models` 输出，每行一个显示名）。
 * 需要本机 agy 已登录；未登录/未安装时返回空数组（不抛错，前端据此提示用户）。
 *
 * 实测 `agy models` 输出格式（agy 1.1.0）：
 *   Gemini 3.5 Flash (Medium)
 *   Gemini 3.5 Flash (High)
 *   ...
 * 认证失败时输出 `Error: Please sign in...`（exit 0）。
 */
export async function listAntigravityModels(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const child = spawn(AGY_BIN, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const trimmed = out.trim()
      // 未登录 / 出错：agy 输出 "Error: ..."，返回空
      if (/^Error:/i.test(trimmed)) {
        resolve([])
        return
      }
      const models = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^Error:/i.test(l))
      resolve(models)
    })
  })
}
