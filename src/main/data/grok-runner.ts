import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { writeFile, rm, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { UsageInfo } from './llm-service'
import { LLM_ABORTED_ERROR } from './agent-meta-detect'

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
  await writeFile(promptFile, PROSE_ONLY_PREAMBLE + prompt, 'utf8')

  const args: string[] = [
    '--prompt-file',
    promptFile,
    '--output-format',
    'streaming-json',
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
        windowsHide: true
      })

      let stderrBuf = ''
      let stdoutPending = Buffer.alloc(0)
      let settled = false
      let timedOut = false
      let full = ''
      let usage: UsageInfo | null = null
      let lineBuf = ''

      const timer = setTimeout(() => {
        if (!settled && !child.killed) {
          timedOut = true
          child.kill('SIGTERM')
        }
      }, timeoutSec * 1000)

      const onAbort = (): void => {
        if (!settled && !child.killed) child.kill('SIGTERM')
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
        if (stdoutPending.length > 0) {
          lineBuf += stdoutPending.toString('utf8')
          stdoutPending = Buffer.alloc(0)
        }
        if (lineBuf.trim()) processLine(lineBuf)

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
      windowsHide: true
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
      if (!child.killed) child.kill('SIGTERM')
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
