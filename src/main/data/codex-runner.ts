import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageInfo } from './llm-service'
import { LLM_ABORTED_ERROR } from './agent-meta-detect'

/**
 * Codex CLI 子进程执行器（app-server 真流式）。
 *
 * 使用 `codex app-server`（stdio JSON-RPC / JSONL）：
 *   initialize → initialized → thread/start → turn/start
 * 正文通过通知 `item/agentMessage/delta` 增量推送；`turn/completed` 收尾。
 *
 * 旧版 `codex exec --json` 仅在 item.completed 整段吐出，续写无法边生成边显示。
 * app-server 与 VS Code 扩展同源，支持真实 delta 流。
 *
 * 认证靠本机 ChatGPT 登录（`codex login`）。
 * 每次调用独立 app-server 进程 + ephemeral thread，并发安全。
 */
export interface CodexOptions {
  /** 模型名（如 "gpt-5.5"）；空则走 config.toml 默认 */
  model?: string
  /** 超时（秒），默认 300 */
  timeoutSec?: number
  /** 流式 token 回调（按 item/agentMessage/delta 真流式喂回） */
  onToken?: (token: string) => void
  /** 中止信号（仅用户取消；超时由 timeoutSec 处理） */
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
  }
  return 'codex'
}

/** codex 可执行文件路径（Windows 用绝对路径，其他平台用 PATH 查找） */
const CODEX_BIN = resolveCodexBin()

/** Windows 上 .cmd 包装脚本需要 shell 执行 */
const CODEX_SHELL = CODEX_BIN.endsWith('.cmd')

/** 默认超时 5 分钟 */
const DEFAULT_TIMEOUT_SEC = 300

/** 认证失败后重试前的等待时间（让 codex 刷新登录态） */
const AUTH_RETRY_DELAY_MS = 1500

/** app-server 客户端标识（OpenAI compliance / 日志） */
const CLIENT_INFO = {
  name: 'ai_writer_desktop',
  title: '大神持笔 桌面版',
  version: '0.1.0'
}

type JsonRpcId = number

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

/**
 * 调用 codex app-server 执行单轮生成（真流式）。
 *
 * prompt 作为 turn/start 的 text input；
 * stdout 上的 item/agentMessage/delta 增量喂回 onToken。
 */
export function runCodex(prompt: string, opts: CodexOptions = {}): Promise<CodexResult> {
  let retried = false
  const exec = (): Promise<CodexResult> =>
    runCodexOnce(prompt, opts).catch((err) => {
      // 认证失败多为登录态的暂时性失效，等一下再跑一次，避免直接把错误抛给用户。
      // 认证失败时通常不会输出 agent_message，不会产生重复 token。
      if (!retried && err && /CODEX_AUTH_EXPIRED/.test(String((err as Error).message))) {
        retried = true
        return new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS)).then(() =>
          runCodexOnce(prompt, opts)
        )
      }
      throw err
    })
  return exec()
}

async function runCodexOnce(prompt: string, opts: CodexOptions): Promise<CodexResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

  return new Promise<CodexResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(CODEX_BIN, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: CODEX_SHELL
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      reject(new Error(`CODEX_SPAWN_FAILED: ${(err as Error).message}`))
      return
    }

    let stderrBuf = ''
    let lineBuf = ''
    let settled = false
    let timedOut = false
    let full = ''
    let streamedAny = false
    let usage: UsageInfo | null = null
    let nextId: JsonRpcId = 1
    const pending = new Map<JsonRpcId, PendingRequest>()
    let threadId: string | null = null
    let turnId: string | null = null
    let handshakeStarted = false

    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        if (!child.killed) child.kill('SIGTERM')
      } catch {
        // ignore
      }
      // 拒绝所有挂起请求，避免泄漏
      for (const [, p] of pending) p.reject(err)
      pending.clear()
      reject(err)
    }

    const succeed = (result: CodexResult): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        if (!child.killed) child.kill('SIGTERM')
      } catch {
        // ignore
      }
      for (const [, p] of pending) p.reject(new Error('CODEX_SESSION_CLOSED'))
      pending.clear()
      resolve(result)
    }

    const writeMsg = (msg: Record<string, unknown>): void => {
      if (settled || !child.stdin.writable) return
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    const request = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      return new Promise((res, rej) => {
        if (settled) {
          rej(new Error('CODEX_SESSION_CLOSED'))
          return
        }
        pending.set(id, { resolve: res, reject: rej })
        writeMsg({ method, id, params })
      })
    }

    const notify = (method: string, params: unknown = {}): void => {
      writeMsg({ method, params })
    }

    const mapErrorMessage = (msg: string): Error => {
      if (/auth|login|credential|401|403|not logged|sign in/i.test(msg)) {
        return new Error('CODEX_AUTH_EXPIRED')
      }
      if (/rate|quota|limit|429/i.test(msg)) {
        return new Error('LLM_RATE_LIMIT')
      }
      if (/model.*not supported|invalid_request/i.test(msg)) {
        return new Error(`CODEX_MODEL_ERROR: ${msg.slice(0, 200)}`)
      }
      return new Error(`CODEX_ERROR: ${msg.slice(0, 200)}`)
    }

    /** 服务端发起的审批/工具请求：写作场景一律拒绝，避免卡住 */
    const respondServerRequest = (id: JsonRpcId, method: string): void => {
      // 常见审批类：decision: decline / cancel
      if (
        /requestApproval|Approval|requestUserInput|elicitation/i.test(method) ||
        method === 'applyPatchApproval' ||
        method === 'execCommandApproval'
      ) {
        writeMsg({ id, result: { decision: 'decline' } })
        return
      }
      // 其它未知 server request：空结果兜底
      writeMsg({ id, result: {} })
    }

    const appendToken = (token: string): void => {
      if (!token) return
      full += token
      streamedAny = true
      opts.onToken?.(token)
    }

    const processMessage = (msg: Record<string, unknown>): void => {
      const id = msg.id as JsonRpcId | undefined
      const method = typeof msg.method === 'string' ? msg.method : undefined

      // 1) 响应：有 id + result/error
      if (id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        if (msg.error) {
          const errObj = msg.error as { message?: string; code?: number }
          const message = String(errObj.message ?? JSON.stringify(msg.error))
          p.reject(mapErrorMessage(message))
        } else {
          p.resolve(msg.result)
        }
        return
      }

      // 2) 服务端请求：有 id + method，需回包
      if (id != null && method && msg.result === undefined && msg.error === undefined) {
        respondServerRequest(id, method)
        return
      }

      // 3) 通知：有 method，无 id
      if (!method) return
      const params = (msg.params ?? {}) as Record<string, unknown>

      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : ''
        appendToken(delta)
        return
      }

      if (method === 'item/completed') {
        const item = params.item as { type?: string; text?: string } | undefined
        // 无 delta 时（旧行为/短路径）用完整 agent_message 兜底喂一次
        if (item?.type === 'agentMessage' && item.text) {
          if (!streamedAny) {
            appendToken(item.text)
          } else if (item.text.length >= full.length) {
            // delta 已喂过：仅对齐权威全文，不重复 onToken
            full = item.text
          }
        }
        return
      }

      if (method === 'thread/tokenUsage/updated') {
        const tokenUsage = params.tokenUsage as
          | {
              last?: {
                inputTokens?: number
                outputTokens?: number
                totalTokens?: number
              }
              total?: {
                inputTokens?: number
                outputTokens?: number
                totalTokens?: number
              }
            }
          | undefined
        const last = tokenUsage?.last ?? tokenUsage?.total
        if (last) {
          const inputTokens = Number(last.inputTokens ?? 0) || 0
          const outputTokens = Number(last.outputTokens ?? 0) || 0
          const totalTokens = Number(last.totalTokens ?? 0) || inputTokens + outputTokens
          usage = { inputTokens, outputTokens, totalTokens }
        }
        return
      }

      if (method === 'error') {
        const error = params.error as { message?: string } | undefined
        const willRetry = Boolean(params.willRetry)
        const message = String(error?.message ?? '')
        if (!willRetry && message) {
          // 可恢复错误交给 turn/completed；不可恢复且明显是鉴权/限流则尽早失败
          if (/auth|login|credential|401|403|rate|quota|limit|429/i.test(message)) {
            fail(mapErrorMessage(message))
          }
        }
        return
      }

      if (method === 'turn/completed') {
        const turn = params.turn as {
          id?: string
          status?: string
          error?: { message?: string } | null
        } | undefined
        const status = String(turn?.status ?? '')
        if (status === 'completed') {
          if (!usage) {
            const outputTokens = Math.ceil(full.length / 1.5)
            usage = { inputTokens: 0, outputTokens, totalTokens: outputTokens }
          }
          succeed({ full, usage })
          return
        }
        if (status === 'interrupted') {
          if (timedOut) {
            fail(new Error('LLM_TIMEOUT'))
          } else if (opts.signal?.aborted) {
            fail(new Error(LLM_ABORTED_ERROR))
          } else {
            fail(new Error('LLM_ABORTED'))
          }
          return
        }
        // failed 或其它
        const msgText = String(turn?.error?.message ?? 'turn failed')
        fail(mapErrorMessage(msgText))
      }
    }

    const processLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        return
      }
      processMessage(msg)
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      // 尽量优雅中断 turn；随后 kill
      if (threadId && turnId) {
        try {
          writeMsg({
            method: 'turn/interrupt',
            id: nextId++,
            params: { threadId, turnId }
          })
        } catch {
          // ignore
        }
      }
      try {
        if (!child.killed) child.kill('SIGTERM')
      } catch {
        // ignore
      }
      // 若 close 未触发 fail，兜底
      setTimeout(() => {
        if (!settled) fail(new Error('LLM_TIMEOUT'))
      }, 1500)
    }, timeoutSec * 1000)

    const onAbort = (): void => {
      if (settled) return
      if (threadId && turnId) {
        try {
          writeMsg({
            method: 'turn/interrupt',
            id: nextId++,
            params: { threadId, turnId }
          })
        } catch {
          // ignore
        }
      }
      try {
        if (!child.killed) child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8')
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      if (settled) return
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        fail(new Error('CODEX_NOT_FOUND'))
      } else {
        fail(new Error(`CODEX_SPAWN_FAILED: ${e.message}`))
      }
    })

    child.on('close', () => {
      if (lineBuf.trim()) processLine(lineBuf)
      if (settled) return
      if (timedOut) {
        fail(new Error('LLM_TIMEOUT'))
        return
      }
      if (opts.signal?.aborted) {
        fail(new Error(LLM_ABORTED_ERROR))
        return
      }
      if (stderrBuf.trim()) {
        console.warn('[codex] stderr:', stderrBuf.trim().slice(0, 200))
      }
      // 进程意外退出且未完成 turn
      fail(new Error(full ? 'LLM_OUTPUT_TRUNCATED' : 'CODEX_ERROR: app-server exited early'))
    })

    // 握手 + 开 thread + 开 turn
    ;(async () => {
      if (handshakeStarted) return
      handshakeStarted = true
      try {
        await request('initialize', {
          clientInfo: CLIENT_INFO,
          capabilities: {
            experimentalApi: false,
            requestAttestation: false
          }
        })
        notify('initialized', {})

        const threadParams: Record<string, unknown> = {
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          serviceName: 'ai_writer_desktop'
        }
        if (opts.model && opts.model.trim()) {
          threadParams.model = opts.model.trim()
        }

        const started = (await request('thread/start', threadParams)) as {
          thread?: { id?: string }
        }
        threadId = started?.thread?.id ?? null
        if (!threadId) throw new Error('CODEX_ERROR: thread/start missing thread id')

        const turnParams: Record<string, unknown> = {
          threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
          approvalPolicy: 'never'
        }
        if (opts.model && opts.model.trim()) {
          turnParams.model = opts.model.trim()
        }

        const turnRes = (await request('turn/start', turnParams)) as {
          turn?: { id?: string; status?: string }
        }
        turnId = turnRes?.turn?.id ?? null
        // 后续靠 turn/completed 通知收尾；若 turn 已立刻失败则检查 status
        if (turnRes?.turn?.status === 'failed') {
          throw new Error('CODEX_ERROR: turn failed immediately')
        }
      } catch (err) {
        if (!settled) {
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()
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
 * Codex CLI 当前常见模型 slug（来自 Codex 客户端模型目录）。
 * CLI 没有 `codex models` 命令，故维护一份可下拉选择的预设列表；
 * 新版本出现的模型可通过 UI「自定义」手动填入。
 */
export const CODEX_KNOWN_MODELS: readonly string[] = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2'
]

/** 展示名（设置页下拉用；缺省回退 slug 本身） */
export const CODEX_MODEL_LABELS: Readonly<Record<string, string>> = {
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.2': 'GPT-5.2'
}

/**
 * 列出 codex 可用模型（供设置页下拉）。
 * 合并：config.toml 默认 model（若有）+ 内置 GPT 预设。
 * @returns slug 数组；config 默认排在最前
 */
export async function listCodexModels(): Promise<string[]> {
  const configPath = join(homedir(), '.codex', 'config.toml')
  let configModel = ''
  try {
    const content = await readFile(configPath, 'utf8')
    const match = content.match(/^model\s*=\s*"([^"]+)"/m)
    if (match?.[1]?.trim()) configModel = match[1].trim()
  } catch {
    // 文件不存在或读取失败：仅返回预设
  }
  const seen = new Set<string>()
  const out: string[] = []
  const push = (m: string) => {
    if (!m || seen.has(m)) return
    seen.add(m)
    out.push(m)
  }
  push(configModel)
  for (const m of CODEX_KNOWN_MODELS) push(m)
  return out
}
