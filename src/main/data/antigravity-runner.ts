import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageInfo } from './llm-service'

/**
 * Antigravity CLI (agy) 子进程执行器。
 *
 * agy 不提供 HTTP API，只能作为本地命令行调用。使用 `-p`（--print）headless 单轮模式：
 *   agy -p --sandbox --dangerously-skip-permissions --print-timeout <timeout> [--model "<name>"]
 * prompt 通过 stdin 管道传入（不带值的 -p 从 stdin 读取），规避 Windows ~32k ARG_MAX 限制，
 * 对任意长 prompt 均稳定。
 *
 * 实测行为（agy 1.1.0）：
 * - stdout 是纯净响应文本，无 agent 思考日志混入
 * - 错误（认证失败/超时等）也打到 stdout，前缀为 "Error:"，退出码恒为 0
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

/** 默认超时 5 分钟（对齐 agy --print-timeout 默认 5m） */
const DEFAULT_TIMEOUT_SEC = 300

/**
 * 模块级串行化锁。agy 并发不安全（共享 brain 目录 / last_conversations.json），
 * 同时跑多个 -p 会互相干扰。用一个 Promise 链保证串行执行。
 */
let agyChain: Promise<unknown> = Promise.resolve()

/**
 * 调用 agy -p 执行单轮生成。
 *
 * prompt 经 stdin 传入；stdout 按数据块喂回 onToken（伪流式）。
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
  const args: string[] = [
    '-p',
    '--sandbox',
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
      const text = chunk.toString('utf8')
      stdoutBuf += text
      opts.onToken?.(text)
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
        reject(new Error('AGY_NOT_FOUND'))
      } else {
        reject(new Error(`AGY_SPAWN_FAILED: ${e.message}`))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()

      // abort 场景
      if (opts.signal?.aborted) {
        reject(new Error('LLM_TIMEOUT'))
        return
      }

      // agy 退出码恒为 0（即使出错），错误以 "Error:" 前缀打到 stdout
      const full = stdoutBuf
      const trimmed = full.trim()
      if (/^Error:/i.test(trimmed)) {
        const msg = trimmed.split('\n')[0]
        // 认证失败映射到统一错误码
        if (/authenticat|sign\s*in/i.test(msg)) {
          reject(new Error('LLM_AUTH_FAILED'))
        } else if (/timed?\s*out|timeout/i.test(msg)) {
          reject(new Error('LLM_TIMEOUT'))
        } else if (/rate|quota|limit/i.test(msg)) {
          reject(new Error('LLM_RATE_LIMIT'))
        } else {
          reject(new Error(`AGY_ERROR: ${msg}`))
        }
        return
      }

      // stderr 有内容但 stdout 也成功 -- 记日志但不阻断（agy 有时往 stderr 写警告）
      if (stderrBuf.trim()) {
        console.warn('[antigravity] stderr:', stderrBuf.trim().slice(0, 200))
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

    // prompt 经 stdin 传入（规避 ARG_MAX）
    child.stdin.write(prompt, 'utf8')
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
