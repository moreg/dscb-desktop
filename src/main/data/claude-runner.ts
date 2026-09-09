import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile, writeFile, rm, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import type { UsageInfo } from './llm-service'
import type { ReasoningEffort } from '../../shared/types'
import { LLM_ABORTED_ERROR } from './agent-meta-detect'
import { killProcessTree } from './kill-process-tree'

/**
 * Claude Code CLI（`claude`）子进程执行器。
 *
 * 复用本机 `claude` 登录态（Claude 订阅 OAuth，或环境变量 ANTHROPIC_API_KEY），
 * 不需要在应用内单独填 API Key。headless 单轮纯文本生成：
 *   claude -p
 *       --output-format stream-json --verbose --include-partial-messages
 *       --mcp-config mcp-empty.json --strict-mcp-config
 *       --disallowedTools Bash Edit Write ...
 *       [--model <alias|id>]
 *
 * prompt 走 stdin（不进 argv），避开 Windows 命令行长度与中文编码问题。
 * 子进程 cwd 指向一个空临时目录，避免加载用户工程里的 CLAUDE.md / .claude 配置。
 * MCP 空配置写成 cwd 下的 mcp-empty.json 再按相对名传入：新版 CLI 要求该 JSON 含
 * mcpServers 记录，而内联 JSON 在 Windows .cmd + shell 下会被引号处理破坏，改用文件最稳。
 *
 * stream-json 事件（NDJSON，每行一个 JSON）：
 *   {"type":"system","subtype":"init",...}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":N}}}}
 *   {"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":N}}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],"usage":{...}}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"<全文>","usage":{...}}
 *   {"type":"result","subtype":"error_during_execution","is_error":true,...}
 *
 * 每次调用独立进程 + 独立 session，并发安全。
 */
export interface ClaudeOptions {
  /** 模型别名或全名（如 "sonnet" / "opus" / "claude-sonnet-5"）；空/"default" 则走 CLI 默认 */
  model?: string
  /**
   * 思考强度档位。映射到子进程 `MAX_THINKING_TOKENS` 环境变量控制扩展思考预算：
   * none=0（关闭）/ low=4k / medium=10k / high=24k / xhigh=32k / max=60k。
   * 缺省不注入，走 claude CLI 默认。
   */
  thinkingEffort?: ReasoningEffort
  /** 超时（秒），默认 300 */
  timeoutSec?: number
  /** 流式 token 回调（按 content_block_delta 真流式喂回） */
  onToken?: (token: string) => void
  /** 中止信号（仅用户取消；超时由 timeoutSec 处理） */
  signal?: AbortSignal
}

export interface ClaudeResult {
  full: string
  usage: UsageInfo | null
}

/**
 * 解析 claude 可执行文件路径。
 * - Windows：优先原生安装（%USERPROFILE%\.local\bin\claude.exe），其次 npm 全局（claude.cmd）。
 * - Unix：优先原生安装（~/.local/bin/claude），否则走 PATH。
 */
function resolveClaudeBin(): string {
  if (process.platform === 'win32') {
    const nativeExe = join(homedir(), '.local', 'bin', 'claude.exe')
    if (existsSync(nativeExe)) return nativeExe
    const npmCmd = join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd')
    if (existsSync(npmCmd)) return npmCmd
  } else {
    const nativeBin = join(homedir(), '.local', 'bin', 'claude')
    if (existsSync(nativeBin)) return nativeBin
  }
  return 'claude'
}

/** claude 可执行文件路径（Windows 用绝对路径，其他平台用 PATH 查找） */
const CLAUDE_BIN = resolveClaudeBin()

/** Windows 上 .cmd 包装脚本需要 shell 执行 */
const CLAUDE_SHELL = CLAUDE_BIN.endsWith('.cmd')

/** 默认超时 5 分钟 */
const DEFAULT_TIMEOUT_SEC = 300

/**
 * 思考强度档位 → `MAX_THINKING_TOKENS` 预算。
 * 0 关闭扩展思考；正值开启并作为上限。档位取值同 openai-responses / codex。
 */
const THINKING_TOKENS_BY_EFFORT: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  low: 4000,
  medium: 10000,
  high: 24000,
  xhigh: 32000,
  max: 60000
}

/** cwd 下的空 MCP 配置文件名（相对名传给 --mcp-config，避免路径含空格 / 引号被 shell 破坏） */
const MCP_EMPTY_FILENAME = 'mcp-empty.json'
/** 空 mcpServers 记录：关闭所有 MCP server（配合 --strict-mcp-config） */
const MCP_EMPTY_CONTENT = '{"mcpServers":{}}'

/** 认证失败后重试前的等待时间（让 claude 用 refresh token 刷新登录态） */
const AUTH_RETRY_DELAY_MS = 1500

/** 探测子进程超时 */
const PROBE_TIMEOUT_MS = 30_000

/**
 * headless 场景禁用的内置工具清单。
 * 应用只要成品文本，不需要 agent 读写文件 / 跑命令 / 联网。
 * 逐个作为独立 argv 传给 `--disallowedTools`（commander 变长参数）。
 */
const DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'SlashCommand',
  'ExitPlanMode'
]

/**
 * Claude 常见模型别名 / 全名（CLI 无「列出模型」命令，维护一份可下拉的预设）。
 * 新版本出现的模型可在 UI「自定义」里手动填入。
 */
export const CLAUDE_KNOWN_MODELS: readonly string[] = [
  'sonnet',
  'opus',
  'haiku',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5-20251001'
]

/** 展示名（设置页下拉用；缺省回退别名本身） */
export const CLAUDE_MODEL_LABELS: Readonly<Record<string, string>> = {
  sonnet: 'Sonnet（最新）',
  opus: 'Opus（最新）',
  haiku: 'Haiku（最新）',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-fable-5': 'Claude Fable 5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5'
}

/**
 * 计算 Buffer 中最后一个完整 UTF-8 字符的结束位置。
 * 用于流式解码时防止多字节字符（如中文，3 字节）被 chunk 边界截断成乱码（�）。
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

/** 把 CLI 报错文本映射为统一错误码 */
function mapClaudeError(raw: string): Error {
  const msg = raw.slice(0, 400)
  if (
    /invalid api key|authentication_error|invalid_api_key|please run\s+\/login|please login|not logged in|no credentials|oauth token (?:has )?expired|401|unauthorized|run `claude(?: code)? login`/i.test(
      msg
    )
  ) {
    return new Error('CLAUDE_AUTH_EXPIRED')
  }
  if (/rate[ _-]?limit|429|overloaded|quota|usage limit|too many requests/i.test(msg)) {
    return new Error('LLM_RATE_LIMIT')
  }
  if (/credit balance is too low|insufficient credit/i.test(msg)) {
    return new Error('CLAUDE_ERROR: Claude 额度不足，请检查订阅或 API 余额')
  }
  return new Error(`CLAUDE_ERROR: ${msg.slice(0, 200)}`)
}

export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  let retried = false
  const exec = (): Promise<ClaudeResult> =>
    runClaudeOnce(prompt, opts).catch((err) => {
      // 认证失败多为登录态的暂时性失效，等一下再跑一次，避免直接把错误抛给用户。
      if (!retried && err && /CLAUDE_AUTH_EXPIRED/.test(String((err as Error).message))) {
        retried = true
        return new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS)).then(() =>
          runClaudeOnce(prompt, opts)
        )
      }
      throw err
    })
  return exec()
}

async function runClaudeOnce(prompt: string, opts: ClaudeOptions): Promise<ClaudeResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const workDir = await mkdtemp(join(tmpdir(), 'aw-claude-'))
  // 空 MCP 配置写入 cwd（workDir），按相对名传入，规避内联 JSON 在 Windows shell 下被破坏
  await writeFile(join(workDir, MCP_EMPTY_FILENAME), MCP_EMPTY_CONTENT, 'utf8')

  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 关闭一切 MCP server（空 mcpServers 记录 + strict），避免加载用户全局 MCP。
    // 用 cwd 下的相对文件名而非内联 JSON：新版 CLI 要求含 mcpServers 记录，
    // 且内联 JSON 在 Windows .cmd + shell 下会被引号处理破坏、退化成找不到的路径。
    '--mcp-config',
    MCP_EMPTY_FILENAME,
    '--strict-mcp-config'
  ]
  if (opts.model && opts.model.trim() && opts.model.trim() !== 'default') {
    args.push('--model', opts.model.trim())
  }
  args.push('--disallowedTools', ...DISALLOWED_TOOLS)

  // 思考强度：注入 MAX_THINKING_TOKENS 环境变量控制扩展思考预算
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (opts.thinkingEffort && opts.thinkingEffort in THINKING_TOKENS_BY_EFFORT) {
    childEnv.MAX_THINKING_TOKENS = String(THINKING_TOKENS_BY_EFFORT[opts.thinkingEffort])
  }

  const cleanupWorkDir = async (): Promise<void> => {
    try {
      await rm(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  try {
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: CLAUDE_SHELL,
        cwd: workDir,
        env: childEnv,
        detached: process.platform !== 'win32'
      })

      let stderrBuf = ''
      let stdoutPending = Buffer.alloc(0)
      let lineBuf = ''
      let settled = false
      let timedOut = false
      let full = ''
      let streamedAny = false
      let inputTokens = 0
      let outputTokens = 0
      let usage: UsageInfo | null = null

      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true
          killProcessTree(child)
        }
      }, timeoutSec * 1000)

      const onAbort = (): void => {
        if (!settled) killProcessTree(child)
      }
      if (opts.signal) {
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }

      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        killProcessTree(child)
        reject(err)
      }

      const appendToken = (token: string): void => {
        if (!token) return
        full += token
        streamedAny = true
        opts.onToken?.(token)
      }

      const setUsageFrom = (u: Record<string, unknown> | undefined): void => {
        if (!u) return
        const inTok = Number(u.input_tokens ?? 0) || 0
        const outTok = Number(u.output_tokens ?? 0) || 0
        const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0
        const cacheCreate = Number(u.cache_creation_input_tokens ?? 0) || 0
        if (inTok || cacheRead || cacheCreate) inputTokens = inTok + cacheRead + cacheCreate
        if (outTok) outputTokens = outTok
      }

      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        let json: Record<string, unknown>
        try {
          json = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          return
        }
        const type = String(json.type ?? '')

        if (type === 'stream_event') {
          const event = (json.event ?? {}) as Record<string, unknown>
          const et = String(event.type ?? '')
          if (et === 'content_block_delta') {
            const delta = (event.delta ?? {}) as { type?: string; text?: string }
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              appendToken(delta.text)
            }
            return
          }
          if (et === 'message_start') {
            const message = (event.message ?? {}) as { usage?: Record<string, unknown> }
            setUsageFrom(message.usage)
            return
          }
          if (et === 'message_delta') {
            setUsageFrom(event.usage as Record<string, unknown> | undefined)
            return
          }
          return
        }

        if (type === 'assistant') {
          const message = (json.message ?? {}) as {
            content?: Array<{ type?: string; text?: string }>
            usage?: Record<string, unknown>
          }
          setUsageFrom(message.usage)
          const text = Array.isArray(message.content)
            ? message.content
                .filter((b) => b?.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join('')
            : ''
          if (text) {
            // 无增量事件时兜底喂全文；已流式则仅对齐权威全文，不重复 onToken
            if (!streamedAny) appendToken(text)
            else if (text.length >= full.length) full = text
          }
          return
        }

        if (type === 'result') {
          const isError = json.is_error === true || /^error/i.test(String(json.subtype ?? ''))
          setUsageFrom(json.usage as Record<string, unknown> | undefined)
          if (isError) {
            const detail =
              typeof json.result === 'string' && json.result
                ? json.result
                : String(json.subtype ?? 'error')
            fail(mapClaudeError(detail))
            return
          }
          if (!streamedAny && typeof json.result === 'string' && json.result) {
            appendToken(json.result)
          } else if (typeof json.result === 'string' && json.result.length >= full.length) {
            full = json.result
          }
          if (settled) return
          settled = true
          cleanup()
          if (inputTokens > 0 || outputTokens > 0) {
            usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
          } else {
            const out = Math.ceil(full.length / 1.5)
            usage = { inputTokens: 0, outputTokens: out, totalTokens: out }
          }
          killProcessTree(child)
          resolve({ full, usage })
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        const combined = Buffer.concat([stdoutPending, chunk])
        const completeLen = utf8CompleteLength(combined)
        const text = combined.subarray(0, completeLen).toString('utf8')
        stdoutPending = combined.subarray(completeLen)
        lineBuf += text
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8')
      })

      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') fail(new Error('CLAUDE_NOT_FOUND'))
        else fail(new Error(`CLAUDE_SPAWN_FAILED: ${e.message}`))
      })

      child.on('close', (code) => {
        if (stdoutPending.length > 0) {
          lineBuf += stdoutPending.toString('utf8')
          stdoutPending = Buffer.alloc(0)
        }
        if (lineBuf.trim()) processLine(lineBuf)
        if (settled) return
        settled = true
        cleanup()

        if (timedOut) {
          reject(new Error('LLM_TIMEOUT'))
          return
        }
        if (opts.signal?.aborted) {
          reject(new Error(LLM_ABORTED_ERROR))
          return
        }

        const stderr = stderrBuf.trim()
        if (stderr && process.env.NODE_ENV === 'development') {
          console.warn('[claude] stderr:', stderr.slice(0, 300))
        }
        if (code !== 0 && !full) {
          reject(mapClaudeError(stderr || `claude exited with code ${code}`))
          return
        }
        if (!full) {
          reject(new Error('CLAUDE_ERROR: 无输出'))
          return
        }
        // 有部分文本但进程异常退出：当作截断
        if (code !== 0) {
          reject(new Error('LLM_OUTPUT_TRUNCATED'))
          return
        }
        const out = Math.ceil(full.length / 1.5)
        resolve({
          full,
          usage:
            inputTokens > 0 || outputTokens > 0
              ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
              : { inputTokens: 0, outputTokens: out, totalTokens: out }
        })
      })

      // prompt 走 stdin（不进 argv，避开长度 / 中文编码问题）
      child.stdin.on('error', () => {
        /* EPIPE：进程已退出，close 分支会处理 */
      })
      child.stdin.write(prompt)
      child.stdin.end()
    })
  } finally {
    await cleanupWorkDir()
  }
}

/**
 * 探测 claude 是否已安装（不触发模型调用）。
 * `claude --version` 不需要认证。
 * @returns 版本号或 null（未安装）
 */
export async function probeClaude(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: CLAUDE_SHELL
    })
    let out = ''
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve(v)
    }
    const t = setTimeout(() => {
      killProcessTree(child)
      finish(null)
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 && out.trim() ? out.trim() : null))
  })
}

/** claude 全局配置里可能记录的默认模型（~/.claude/settings.json 的 "model" 字段） */
function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/**
 * 列出 claude 可选模型（供设置页下拉）。
 * 合并：settings.json 里配置的默认 model（若有，且不是别名）+ 内置预设。
 * @returns 模型名数组；配置的默认模型排在最前
 */
export async function listClaudeModels(path = claudeSettingsPath()): Promise<string[]> {
  let configModel = ''
  try {
    const content = await readFile(path, 'utf8')
    const parsed = JSON.parse(content) as { model?: unknown }
    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      configModel = parsed.model.trim()
    }
  } catch {
    // 文件不存在 / 非法 JSON：仅返回预设
  }
  const seen = new Set<string>()
  const out: string[] = []
  const push = (m: string): void => {
    if (!m || seen.has(m)) return
    seen.add(m)
    out.push(m)
  }
  push(configModel)
  for (const m of CLAUDE_KNOWN_MODELS) push(m)
  return out
}
