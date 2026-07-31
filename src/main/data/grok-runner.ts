import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { writeFile, rm, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { UsageInfo } from './llm-service'
import { LLM_ABORTED_ERROR } from './agent-meta-detect'
import { killProcessTree } from './kill-process-tree'

/**
 * Grok CLI 子进程执行器。
 *
 * 复用本机 `grok login` 登录态（~/.grok/auth.json），不需要 API Key。
 * headless 单轮纯文本生成（桌面应用场景：正文/细纲等，不需要 agent 工具）：
 *   grok --prompt-file <file> --output-format streaming-json
 *       --max-turns 1 --no-subagents --no-memory --no-plan
 *       --tools "" --permission-mode dontAsk
 *       --cwd <temp>
 *       [-m <model>]
 *
 * 为何 `--tools ""`：
 *   本机常装有 story-long-write 等全局技能。若保留默认工具集，模型会先 read 技能文件；
 *   在 max-turns=1 下读技能占满唯一一轮，stdout 只剩「我会调用技能…正在补读…」流程旁白，
 *   被当成正文塞进编辑器。空 allowlist 禁止一切内置工具，强制纯文本出稿。
 *   注意：不要用部分 `--disallowed-tools` 列表——实测会破坏工具依赖图，
 *   触发 `Couldn't create session: ... scheduler_list ... unsatisfied requirements`。
 *
 * 成品约束写入 prompt 文件（UTF-8），避免 Windows argv 中文编码问题。
 *
 * streaming-json 事件（NDJSON）：
 *   {"type":"text","data":"..."}
 *   {"type":"thought","data":"..."}   // 忽略
 *   {"type":"end","usage":{...},...}
 *   {"type":"error","message":"..."}
 *
 * 结构化模式（opts.jsonSchema，见 GrokOptions）：
 *   追加 `--json-schema <ascii-json>`，CLI 强制 `--output-format json`，
 *   stdout 变成**单个多行 pretty JSON 对象**（非 NDJSON）：
 *   { "text": "{...}", "structuredOutput": {...}, "usage": {...}, "stopReason": "end_turn" }
 *   由服务端保证输出符合 schema，不必再靠提示词约定「只输出 JSON」。
 *
 * 每次调用独立 session，并发安全（无需串行化）。
 * 用临时文件传 prompt，避开 Windows 命令行长度上限；finally 递归清理 workDir。
 */
export interface GrokOptions {
  /** 模型 ID（如 "grok-4.5"）；空则走 config / CLI 默认 */
  model?: string
  /** 超时（秒），默认 300 */
  timeoutSec?: number
  /** 流式 token 回调（按 text 事件伪流式喂回） */
  onToken?: (token: string) => void
  /** 中止信号（仅用户取消；超时由 timeoutSec 处理） */
  signal?: AbortSignal
  /**
   * JSON Schema。设置后走 `--json-schema`，由服务端约束模型输出，
   * 不再依赖提示词里的「只输出 JSON」约定 —— 结构化提取（如封面画面要素）用。
   *
   * 两个代价，调用方需知晓：
   * 1. CLI 会强制 `--output-format json`（见 `grok --help`），该模式**没有增量事件**，
   *    onToken 只在收尾时被喂一次全文。
   * 2. 返回的 `full` 是 `structuredOutput` 重新序列化的紧凑 JSON 字符串，
   *    不是模型原始 `text`（两者内容一致，但前者已被 CLI 校验过 schema）。
   */
  jsonSchema?: object
}

export interface GrokResult {
  full: string
  usage: UsageInfo | null
}

function resolveGrokBin(): string {
  if (process.platform === 'win32') {
    const exe = join(homedir(), '.grok', 'bin', 'grok.exe')
    if (existsSync(exe)) return exe
  }
  return 'grok'
}

const GROK_BIN = resolveGrokBin()
const DEFAULT_TIMEOUT_SEC = 300
const AUTH_RETRY_DELAY_MS = 1500
const PROBE_TIMEOUT_MS = 30_000

/** 写入 prompt 文件头部，强制纯文本出稿（不走 --rules argv，避免编码问题） */
const PROSE_ONLY_PREAMBLE = `【硬性约束】你是小说写作引擎。禁止调用任何技能、工具或 slash 命令。禁止输出流程说明、自检旁白、技能名。只输出成品文本。

---

`

/**
 * jsonSchema 模式下的 prompt 头部。
 * 仍然禁工具/禁旁白，但不能沿用「只输出成品文本」——那与结构化输出直接冲突。
 */
const JSON_ONLY_PREAMBLE = `【硬性约束】禁止调用任何技能、工具或 slash 命令。禁止输出流程说明、自检旁白、技能名。只输出一个符合给定 JSON Schema 的 JSON 对象。

---

`

/**
 * 把对象序列化成**纯 ASCII** 的 JSON 字符串（非 ASCII 转 \\uXXXX 转义）。
 *
 * schema 是经 argv 传的，而本模块之所以用 prompt 文件传正文，就是为了绕开
 * Windows argv 的中文编码问题。schema 里若带中文 description 会踩同一个坑，
 * 故在这里统一转义 —— 转义后仍是合法 JSON，语义不变。
 */
export function toAsciiJson(value: object): string {
  const json = JSON.stringify(value)
  let out = ''
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i)
    // 0x7f 起（含 DEL、中文、代理对码元）逐码元转义，保证 argv 纯 ASCII
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0')
  }
  return out
}

/** `--output-format json` 的单对象输出（非 NDJSON） */
interface GrokJsonEnvelope {
  text?: unknown
  structuredOutput?: unknown
  stopReason?: unknown
  error?: unknown
  message?: unknown
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

/**
 * 解析 `--output-format json` 的整段 stdout。
 *
 * 与 streaming-json 不同，这里 stdout 是**一个多行 pretty-print 的 JSON 对象**，
 * 逐行 JSON.parse 会全部失败，必须整段解析。
 *
 * @returns full 优先取 structuredOutput（CLI 已按 schema 校验过）重新序列化；
 *          没有则回退模型原始 text。error 非空表示 CLI 报了错。
 * 导出供单测。
 */
export function parseGrokJsonOutput(raw: string): {
  full: string
  usage: UsageInfo | null
  error?: string
} {
  const text = raw.trim()
  if (!text) return { full: '', usage: null }

  // 容错：CLI 偶尔在 JSON 前后夹杂日志行
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { full: '', usage: null }

  let env: GrokJsonEnvelope
  try {
    env = JSON.parse(text.slice(start, end + 1)) as GrokJsonEnvelope
  } catch {
    return { full: '', usage: null }
  }

  let usage: UsageInfo | null = null
  if (env.usage) {
    const inputTokens = Number(env.usage.input_tokens ?? 0) || 0
    const outputTokens = Number(env.usage.output_tokens ?? 0) || 0
    const totalTokens = Number(env.usage.total_tokens ?? 0) || inputTokens + outputTokens
    usage = { inputTokens, outputTokens, totalTokens }
  }

  // structuredOutput 已过 schema 校验，优先于 text
  const full =
    env.structuredOutput != null && typeof env.structuredOutput === 'object'
      ? JSON.stringify(env.structuredOutput)
      : typeof env.text === 'string'
        ? env.text
        : ''

  const errText =
    typeof env.error === 'string'
      ? env.error
      : env.stopReason === 'error' && typeof env.message === 'string'
        ? env.message
        : undefined

  return { full, usage, ...(errText ? { error: errText } : {}) }
}

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

export function runGrok(prompt: string, opts: GrokOptions = {}): Promise<GrokResult> {
  let retried = false
  const exec = (): Promise<GrokResult> =>
    runGrokOnce(prompt, opts).catch((err) => {
      if (!retried && err && /GROK_AUTH_EXPIRED/.test(err.message)) {
        retried = true
        return new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAY_MS)).then(() =>
          runGrokOnce(prompt, opts)
        )
      }
      throw err
    })
  return exec()
}

async function runGrokOnce(prompt: string, opts: GrokOptions): Promise<GrokResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const workDir = await mkdtemp(join(tmpdir(), 'aw-grok-'))
  const promptFile = join(workDir, `prompt-${randomUUID()}.txt`)
  // 结构化模式走 JSON 头部；沿用「只输出成品文本」会与 schema 输出直接打架
  const jsonMode = Boolean(opts.jsonSchema)
  const preamble = jsonMode ? JSON_ONLY_PREAMBLE : PROSE_ONLY_PREAMBLE
  await writeFile(promptFile, preamble + prompt, 'utf8')

  const args: string[] = [
    '--prompt-file',
    promptFile,
    // --json-schema 会强制 --output-format json（单个 pretty JSON 对象，无增量事件）
    '--output-format',
    jsonMode ? 'json' : 'streaming-json',
    '--max-turns',
    '1',
    '--no-subagents',
    '--no-memory',
    '--no-plan',
    // 空 allowlist：禁止 read/skill 等工具，避免全局技能抢占唯一 turn
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    // 隔离到空临时目录，避免 agent 改写用户工程 / 加载项目技能
    '--cwd',
    workDir
  ]
  if (jsonMode) {
    args.push('--json-schema', toAsciiJson(opts.jsonSchema!))
  }
  if (opts.model && opts.model.trim() && opts.model.trim() !== 'default') {
    args.push('-m', opts.model.trim())
  }

  const cleanupWorkDir = async (): Promise<void> => {
    try {
      await rm(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  try {
    return await new Promise<GrokResult>((resolve, reject) => {
      const child = spawn(GROK_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      })

      let stderrBuf = ''
      let stdoutPending = Buffer.alloc(0)
      let settled = false
      let timedOut = false
      let full = ''
      let usage: UsageInfo | null = null
      let lineBuf = ''
      /** json 模式下缓冲的完整 stdout（收尾时整段解析） */
      const jsonChunks: Buffer[] = []

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
        reject(err)
      }

      const processLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        let json: Record<string, unknown>
        try {
          json = JSON.parse(trimmed)
        } catch {
          return
        }
        const type = String(json.type ?? '')

        if (type === 'text') {
          const data = typeof json.data === 'string' ? json.data : ''
          if (data) {
            full += data
            opts.onToken?.(data)
          }
          return
        }

        if (type === 'end') {
          const u = json.usage as
            | {
                input_tokens?: number
                output_tokens?: number
                total_tokens?: number
              }
            | undefined
          if (u) {
            const inputTokens = Number(u.input_tokens ?? 0) || 0
            const outputTokens = Number(u.output_tokens ?? 0) || 0
            const totalTokens =
              Number(u.total_tokens ?? 0) || inputTokens + outputTokens
            usage = { inputTokens, outputTokens, totalTokens }
          }
          if (!full && typeof json.text === 'string' && json.text) {
            full = json.text
            opts.onToken?.(json.text)
          }
          return
        }

        if (type === 'error') {
          const msg = String(json.message ?? json.error ?? 'unknown error')
          if (/auth|login|credential|401|403|sign in|not logged/i.test(msg)) {
            fail(new Error('GROK_AUTH_EXPIRED'))
          } else if (/rate|quota|limit|429/i.test(msg)) {
            fail(new Error('LLM_RATE_LIMIT'))
          } else {
            fail(new Error(`GROK_ERROR: ${msg.slice(0, 200)}`))
          }
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        // json 模式：输出是一个多行 pretty JSON 对象，逐行解析必然全部失败，
        // 只能整段缓冲、收尾时一次解析（也就没有增量事件可喂）
        if (jsonMode) {
          jsonChunks.push(chunk)
          return
        }
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
        if (e.code === 'ENOENT') fail(new Error('GROK_NOT_FOUND'))
        else fail(new Error(`GROK_SPAWN_FAILED: ${e.message}`))
      })

      child.on('close', (code) => {
        if (jsonMode) {
          const parsed = parseGrokJsonOutput(Buffer.concat(jsonChunks).toString('utf8'))
          if (parsed.error) {
            const msg = parsed.error
            if (/auth|login|credential|401|403|sign in|not logged/i.test(msg)) {
              fail(new Error('GROK_AUTH_EXPIRED'))
            } else if (/rate|quota|limit|429/i.test(msg)) {
              fail(new Error('LLM_RATE_LIMIT'))
            } else {
              fail(new Error(`GROK_ERROR: ${msg.slice(0, 200)}`))
            }
          } else if (parsed.full) {
            // 该模式没有增量事件，收尾时一次性喂回，保持 onToken 契约
            full = parsed.full
            usage = parsed.usage
            opts.onToken?.(parsed.full)
          } else {
            usage = parsed.usage
          }
        } else {
          if (stdoutPending.length > 0) {
            lineBuf += stdoutPending.toString('utf8')
            stdoutPending = Buffer.alloc(0)
          }
          if (lineBuf.trim()) processLine(lineBuf)
        }

        if (settled) return
        settled = true
        cleanup()

        // 超时优先于 abort（timer 先触发时 timedOut=true）
        if (timedOut) {
          reject(new Error('LLM_TIMEOUT'))
          return
        }
        if (opts.signal?.aborted) {
          reject(new Error(LLM_ABORTED_ERROR))
          return
        }

        const stderr = stderrBuf.trim()
        if (stderr) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[grok] stderr:', stderr.slice(0, 300))
          }
          if (code !== 0 && !full) {
            if (/auth|login|credential|sign in|not logged/i.test(stderr)) {
              reject(new Error('GROK_AUTH_EXPIRED'))
              return
            }
            reject(new Error(`GROK_ERROR: ${stderr.slice(0, 200)}`))
            return
          }
        }

        if (code !== 0 && !full) {
          reject(new Error(`GROK_ERROR: exited with code ${code}`))
          return
        }

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
    })
  } finally {
    await cleanupWorkDir()
  }
}

function spawnWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    let out = ''
    let settled = false
    const finish = (code: number | null, text: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out: text })
    }
    const timer = setTimeout(() => {
      killProcessTree(child)
      finish(null, out)
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => finish(null, ''))
    child.on('close', (code) => finish(code, out))
  })
}

/**
 * 探测 grok 是否已安装（不触发模型调用）。
 * `grok --version` 不需要认证。带超时，避免 CLI 挂起卡死设置页。
 */
export async function probeGrok(): Promise<string | null> {
  const { code, out } = await spawnWithTimeout(GROK_BIN, ['--version'], PROBE_TIMEOUT_MS)
  if (code === 0 && out.trim()) return out.trim()
  return null
}

/**
 * 列出 grok 可用模型。
 * 解析 `grok models` 输出中的模型 ID 行。带超时。
 */
export async function listGrokModels(): Promise<string[]> {
  const { out } = await spawnWithTimeout(GROK_BIN, ['models'], PROBE_TIMEOUT_MS)
  const models: string[] = []
  const re = /^\s*[*+-]\s+([a-zA-Z0-9._-]+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(out)) !== null) {
    if (m[1] && !models.includes(m[1])) models.push(m[1])
  }
  if (models.length === 0) {
    const dm = out.match(/Default model:\s*([a-zA-Z0-9._-]+)/i)
    if (dm?.[1]) models.push(dm[1])
  }
  return models
}
