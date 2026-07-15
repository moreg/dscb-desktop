import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageInfo } from './llm-service'

/**
 * Codex CLI 子进程执行器。
 *
 * codex 不提供 HTTP API，只能作为本地命令行调用。使用 `codex exec` 非交互模式：
 *   codex exec --skip-git-repo-check --ephemeral -s read-only --json [-m <model>]
 * prompt 通过 stdin 管道传入（codex exec 默认从 stdin 读取 prompt）。
 *
 * stdout 输出 JSONL 事件流（每行一个 JSON 对象）：
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"正文"}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}
 *
 * 错误以 turn.failed / error 事件表示，退出码恒为 0。
 * 认证靠 ChatGPT 登录（`codex login` 交互式登录）。
 * --ephemeral 模式不持久化 session，多个 exec 并发安全（与 agy 不同，无需串行化）。
 */
export interface CodexOptions {
  /** 模型名（如 "gpt-5.5"）；空则走 config.toml 默认 */
  model?: string
  /** 超时（秒），默认 300 */
  timeoutSec?: number
  /** 流式 token 回调（按 JSONL item.completed 事件伪流式喂回） */
  onToken?: (token: string) => void
  /** 中止信号 */
  signal?: AbortSignal
}

export interface CodexResult {
  full: string
  usage: UsageInfo | null
}

/**
 * 解析 codex 可执行文件路径。
 * Windows 上 codex 通过 npm 安装，实际 exe 在 vendor 目录下。
 * npm 的 codex.cmd 包装脚本需要 shell 才能执行，直接用 exe 路径更可靠。
 * Unix 上 PATH 可用，直接返回命令名。
 */
function resolveCodexBin(): string {
  if (process.platform === 'win32') {
    const exe = join(
      homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
      '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
      'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
    )
    if (existsSync(exe)) return exe
    // 回退：npm 全局 bin 目录的 codex.cmd（需 shell:true）
    const cmd = join(homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd')
    if (existsSync(cmd)) return cmd
  }
  return 'codex'
}

/** codex 可执行文件路径（Windows 用绝对路径，其他平台用 PATH 查找） */
const CODEX_BIN = resolveCodexBin()

/** Windows 上 .cmd 包装脚本需要 shell 执行 */
const CODEX_SHELL = CODEX_BIN.endsWith('.cmd')

/** 默认超时 5 分钟 */
const DEFAULT_TIMEOUT_SEC = 300

/**
 * 计算 Buffer 中最后一个完整 UTF-8 字符的结束位置。
 * 防止多字节字符（如中文，3 字节）被 chunk 边界截断成乱码（�）。
 * 与 antigravity-runner 中的实现一致。
 */
function utf8CompleteLength(buf: Buffer): number {
  if (buf.length === 0) return 0
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - 3); i--) {
    const byte = buf[i]
    let charLen: number
    if ((byte & 0x80) === 0) continue
    if ((byte & 0xe0) === 0xc0) charLen = 2
    else if ((byte & 0xf0) === 0xe0) charLen = 3
    else if ((byte & 0xf8) === 0xf0) charLen = 4
    else continue
    if (i + charLen <= buf.length) return buf.length
    return i
  }
  return buf.length
}

/**
 * 调用 codex exec 执行单轮生成。
 *
 * prompt 经 stdin 传入；stdout JSONL 逐行解析，累积 agent_message 文本并喂回 onToken。
 * 完成后返回完整文本与真实用量（codex 返回精确 token 数，无需估算）。
 *
 * 不需串行化：--ephemeral 模式每次 exec 创建独立 session，并发安全。
 */
/** 认证失败后重试前的等待时间（让 codex 刷新登录态） */
const AUTH_RETRY_DELAY_MS = 1500

export function runCodex(prompt: string, opts: CodexOptions = {}): Promise<CodexResult> {
  let retried = false
  const exec = (): Promise<CodexResult> =>
    runCodexOnce(prompt, opts).catch((err) => {
      // 认证失败多为登录态的暂时性失效，等一下再跑一次，避免直接把错误抛给用户。
      // 认证失败时不会输出 agent_message，不会产生重复 token。
      if (!retried && err && /CODEX_AUTH_EXPIRED/.test(err.message)) {
        retried = true
        return new Promise((resolve) =>
          setTimeout(resolve, AUTH_RETRY_DELAY_MS)
        ).then(() => runCodexOnce(prompt, opts))
      }
      throw err
    })
  return exec()
}

async function runCodexOnce(
  prompt: string,
  opts: CodexOptions
): Promise<CodexResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const args: string[] = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s', 'read-only',
    '--json'
  ]
  if (opts.model && opts.model.trim()) {
    args.push('-m', opts.model.trim())
  }

  return new Promise<CodexResult>((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: CODEX_SHELL
    })

    let stderrBuf = ''
    let stdoutPending = Buffer.alloc(0) // 跨 chunk 的不完整 UTF-8 尾部字节
    let settled = false
    let timedOut = false
    let full = ''
    let usage: UsageInfo | null = null
    let lineBuf = ''

    // 超时定时器（codex exec 自身无 --timeout 参数，靠外部 kill）
    const timer = setTimeout(() => {
      if (!settled && !child.killed) {
        timedOut = true
        child.kill('SIGTERM')
      }
    }, timeoutSec * 1000)

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
    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const processLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let json: Record<string, unknown>
      try {
        json = JSON.parse(trimmed)
      } catch {
        // 非 JSON 行（如 "Reading prompt from stdin..."），跳过
        return
      }
      const type = String(json.type ?? '')

      // 正文：item.completed + item.type === 'agent_message'
      if (type === 'item.completed') {
        const item = json.item as { type?: string; text?: string } | undefined
        if (item?.type === 'agent_message' && item.text) {
          full += item.text
          opts.onToken?.(item.text)
        }
        // item.type === 'error' 是非致命警告（如模型 metadata not found），不中断
      }

      // 用量：turn.completed
      if (type === 'turn.completed') {
        const u = json.usage as {
          input_tokens?: number
          output_tokens?: number
        } | undefined
        if (u) {
          usage = {
            inputTokens: Number(u.input_tokens ?? 0) || 0,
            outputTokens: Number(u.output_tokens ?? 0) || 0,
            totalTokens: (Number(u.input_tokens ?? 0) || 0) + (Number(u.output_tokens ?? 0) || 0)
          }
        }
      }

      // 错误：turn.failed / error
      if (type === 'turn.failed' || type === 'error') {
        const msg = type === 'turn.failed'
          ? String((json.error as { message?: string })?.message ?? '')
          : String(json.message ?? json.error ?? '')
        if (!settled) {
          settled = true
          cleanup()
          // 仅开发环境记录详细诊断信息，生产环境避免敏感信息泄露
          if (process.env.NODE_ENV === 'development') {
            console.error('[codex] execution failed.', {
              type,
              msg,
              hint:
                /tls|handshake|ssl|certificate|eof/i.test(msg) ? 'TLS/SSL 握手失败，通常是网络代理问题或 OpenAI 服务器连接不稳定' :
                /reconnect|disconnected|network/i.test(msg) ? '网络连接中断，请检查网络稳定性或代理设置' :
                /auth|login|credential/i.test(msg) ? '认证失败（登录态暂时失效），runCodex 会自动重试一次' :
                '检查网络连接或 CLI 版本'
            })
          }
          // codex 靠本机 ChatGPT 登录态，通常自动保持有效。认证失败多为暂时性，
          // 用独立错误码 CODEX_AUTH_EXPIRED 与 HTTP API Key 失效区分，前端提示"稍后重试"。
          // runCodex 层会自动重试一次（等 1.5s 让登录态恢复），此处仅在重试仍失败时抛出。
          if (/auth|login|credential|401|403/i.test(msg)) {
            reject(new Error('CODEX_AUTH_EXPIRED'))
          } else if (/rate|quota|limit|429/i.test(msg)) {
            reject(new Error('LLM_RATE_LIMIT'))
          } else if (/model.*not supported|invalid_request/i.test(msg)) {
            reject(new Error(`CODEX_MODEL_ERROR: ${msg.slice(0, 200)}`))
          } else {
            reject(new Error(`CODEX_ERROR: ${msg.slice(0, 200)}`))
          }
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      // 防止 UTF-8 多字节字符被 chunk 边界截断（与 antigravity-runner 一致）
      const combined = Buffer.concat([stdoutPending, chunk])
      const completeLen = utf8CompleteLength(combined)
      const text = combined.subarray(0, completeLen).toString('utf8')
      stdoutPending = combined.subarray(completeLen)
      // JSONL 逐行解析
      lineBuf += text
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        reject(new Error('CODEX_NOT_FOUND'))
      } else {
        reject(new Error(`CODEX_SPAWN_FAILED: ${e.message}`))
      }
    })

    child.on('close', () => {
      // flush 残留的不完整 UTF-8 尾部字节
      if (stdoutPending.length > 0) {
        lineBuf += stdoutPending.toString('utf8')
        stdoutPending = Buffer.alloc(0)
      }
      // 处理残留 buffer
      if (lineBuf.trim()) processLine(lineBuf)

      if (settled) return // error 已处理
      settled = true
      cleanup()

      // abort 场景
      if (opts.signal?.aborted) {
        reject(new Error('LLM_TIMEOUT'))
        return
      }

      // 超时（timer 触发了 kill）
      if (timedOut) {
        reject(new Error('LLM_TIMEOUT'))
        return
      }

      if (stderrBuf.trim()) {
        console.warn('[codex] stderr:', stderrBuf.trim().slice(0, 200))
      }

      // 兜底用量估算：若 turn.completed 未出现，按 1 字 ≈ 1.5 token 估算
      if (!usage) {
        const outputTokens = Math.ceil(full.length / 1.5)
        usage = {
          inputTokens: 0,
          outputTokens,
          totalTokens: outputTokens
        }
      }
      resolve({ full, usage })
    })

    // prompt 经 stdin 传入
    child.stdin.end(prompt, 'utf8')
  })
}

/**
 * 探测 codex 是否已安装（不触发模型调用）。
 * `codex --version` 不需要认证，可安全用于预检。
 * @returns 版本号或 null（未安装）
 */
export async function probeCodex(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(CODEX_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: CODEX_SHELL
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
 * 列出 codex 可用模型。
 * codex 没有 `codex models` 命令，从 `~/.codex/config.toml` 读取 `model` 字段
 * 作为默认模型返回。用户也可在 UI 手动输入其他模型名。
 * @returns 模型名数组（通常只有 1 个默认模型），未安装/无配置时返回空数组
 */
export async function listCodexModels(): Promise<string[]> {
  const configPath = join(homedir(), '.codex', 'config.toml')
  try {
    const content = await readFile(configPath, 'utf8')
    // 简单解析 `model = "xxx"` 行（TOML 顶层字符串值）
    const match = content.match(/^model\s*=\s*"([^"]+)"/m)
    if (match && match[1]) {
      return [match[1]]
    }
    return []
  } catch {
    // 文件不存在或读取失败
    return []
  }
}
