import { spawn } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import type { UsageInfo } from './llm-service'
import { LLM_ABORTED_ERROR } from './agent-meta-detect'
import { killProcessTree } from './kill-process-tree'

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
 * 超长 prompt（> 30000 字符）直接报错；调用层会先精简可省略的章节背景。
 *
 * 注意：不要加 `--sandbox`。该标志会让 agy 在受限沙箱里运行（无当前 workspace），
 * 触发 agy 内置的"是否创建 sandbox 目录"引导话术，被当成模型输出返回。
 * 每次使用独立临时目录，不继承软件仓库规则/钩子；主 agent 不开放工具。
 *
 * 当前默认使用 agy 1.4.5 的 stream-json：仅 result.status=SUCCESS 是生成完成凭据。
 * 完成后等待进程正常关闭；收尾卡住则清理进程树，close 后才释放队列。
 * 旧版 text 兼容路径行为（agy 1.1.1）：
 * - stdout 是纯净响应文本，无 agent 思考日志混入
 * - 正常生成：exit 0，stdout=模型输出，stderr 空
 * - 超时/错误：exit 1，stdout 部分内容或空，stderr="Error: ..."（错误在 stderr，不是 stdout）
 * - 认证失败：exit 1，stdout 空，stderr="Error: ...sign in..."
 * - 认证靠本机 Google OAuth（用户需先交互式 `agy` 登录一次）
 * - 并发不安全：多个 agy -p 同时跑会互相干扰（共享 brain 目录），需串行化
 * - `-p` 是单轮模式，不支持 sessionId 续聊
 */
/** 只分类 CLI 错误事件，不把正文中的网络/额度措辞当成运行错误。 */
export function classifyAntigravityFailure(message: string): 'output_limit' | 'stream_interrupted' | 'unknown' {
  if (/exceeded.{0,30}output.{0,20}token|output.{0,20}token.{0,20}limit|max(?:imum)?[_ ]output[_ ]tokens/i.test(message)) return 'output_limit'
  if (/stream.{0,30}interrupt|stream.{0,30}disconnect|connection.{0,20}(?:reset|lost|abort)|broken pipe|network is down|socket disconnect/i.test(message)) return 'stream_interrupted'
  return 'unknown'
}

function generationFailureMessage(kind: ReturnType<typeof classifyAntigravityFailure>, timedOut = false): string {
  if (kind === 'output_limit') return `AGY_ERROR: 模型输出额度超限，${timedOut ? '内部恢复仍未完成，已超时' : '未取得完整成功结果'}`
  if (kind === 'stream_interrupted') return `AGY_ERROR: 生成流中断，${timedOut ? '内部恢复仍未完成，已超时' : '未取得完整成功结果'}`
  return timedOut ? 'LLM_TIMEOUT' : 'AGY_ERROR: CLI 未成功完成生成'
}

const TEXT_AGENT_NAME = 'dscb-text-transport'
const TEXT_AGENT_PROFILE = `---
name: dscb-text-transport
description: Text generation and review engine for the desktop writing application.
mainAgent: true
subagent: false
model: inherit
tools: []
commandExecutionPolicy: off
---
The user prompt contains all required story facts, memory context, style preferences, constraints, and output format. Complete the requested writing or review directly from that supplied context. Do not create files, run scripts, delegate, or consult unrelated projects. Mechanical word counting, exact quote matching and JSON validation are performed by the application; focus on semantic accuracy, narrative quality, and the requested format. Preserve all specified facts, causal boundaries, character knowledge and unresolved details. Return only the requested final text or JSON, without process commentary.
`

function createTextWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'dscb-agy-'))
  const agentDir = join(workspace, '.agents', 'agents', TEXT_AGENT_NAME)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'agent.md'), TEXT_AGENT_PROFILE, 'utf8')
  return workspace
}

export interface AntigravityOptions {
  /** 仅旧版 CLI 兼容使用；默认要求明确的结构化完成事件。 */
  outputFormat?: 'text' | 'stream-json'
  onDiagnostic?: (event: Record<string, unknown>) => void
  onStatus?: (status: import('../../shared/types').AgyGenerationStatus) => void
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
/** 认证失败后重试前的等待时间（让 agy 用 refresh token 刷新 access token） */
const AUTH_RETRY_DELAY_MS = 1500

export function runAntigravity(
  prompt: string,
  opts: AntigravityOptions = {}
): Promise<AntigravityResult> {
  let retried = false
  const exec = (): Promise<AntigravityResult> =>
    runAntigravityOnce(prompt, opts).catch((err) => {
      // 认证失败多为 access token 刚过期的暂时性失效，agy 会用 refresh token 自动刷新。
      // 第一次失败时等一下再跑一次（刷新通常在秒级完成），避免直接把错误抛给用户。
      // 认证失败时 stdout 为空，不会重复喂 token。
      if (!retried && err && /AGY_AUTH_EXPIRED/.test(err.message)) {
        if (opts.signal?.aborted) throw new Error(LLM_ABORTED_ERROR)
        retried = true
        opts.onStatus?.('retrying')
        return new Promise((resolve) =>
          setTimeout(resolve, AUTH_RETRY_DELAY_MS)
        ).then(() => runAntigravityOnce(prompt, opts))
      }
      throw err
    })
  // 串行化：前一个 agy 调用完成（或失败）后才跑下一个
  if (opts.signal?.aborted) return Promise.reject(new Error(LLM_ABORTED_ERROR))
  opts.onStatus?.('queued')
  const next = agyChain.then(exec, exec) // 即使前一个失败也继续
  agyChain = next.catch(() => {}) // 锁链不因业务错误断裂
  // 排队时取消也立即返回；轮到该任务时由 Once 的检查阻止启动进程。
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error(LLM_ABORTED_ERROR))
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    next.then(resolve, reject).finally(() => opts.signal?.removeEventListener('abort', onAbort))
  })
}

async function runAntigravityOnce(
  prompt: string,
  opts: AntigravityOptions
): Promise<AntigravityResult> {
  if (opts.signal?.aborted) throw new Error(LLM_ABORTED_ERROR)
  opts.onStatus?.('waiting')
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

  const structured = opts.outputFormat !== 'text'
  const workspace = createTextWorkspace()
  const args: string[] = [
    '-p',
    prompt,
    '--agent', TEXT_AGENT_NAME,
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${timeoutSec}s`
  ]
  if (structured) args.push('--output-format', 'stream-json', '--disable-slash-commands')
  const sanitizedModel = sanitizeAgyModel(opts.model)
  if (sanitizedModel) {
    args.push('--model', sanitizedModel)
  }

  return new Promise<AntigravityResult>((resolve, reject) => {
    const child = spawn(AGY_BIN, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

      const startedAt = Date.now()
      let lastOutputMs: number | null = null
      let resultReceived = false
      let forcedCleanup = false
      let jsonBuffer = ''
      let protocolError = ''
      let resultStatus = ''
      let cliUsage: UsageInfo | null = null
      let failureKind: ReturnType<typeof classifyAntigravityFailure> = 'unknown'
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      let reapTimer: ReturnType<typeof setTimeout> | undefined
      const diagnostic = (event: string, extra: Record<string, unknown> = {}): void => {
        const detail = { event, elapsedMs: Date.now() - startedAt, lastOutputMs, resultReceived, resultStatus, failureKind, pid: child.pid, ...extra }
        opts.onDiagnostic?.(detail)
        if (event === 'timeout' || event === 'cleanup_stalled') console.warn('[antigravity]', detail)
      }
      diagnostic('spawn')
      let stdoutBuf = ''
      let stderrBuf = ''
      let stdoutPending = Buffer.alloc(0) // 跨 chunk 的不完整 UTF-8 尾部字节
      let stderrPending = Buffer.alloc(0)
      let settled = false
      let streaming = false
      // CLI 自身可能在会话结束后仍不退出，不能只依赖 --print-timeout。
      const timeout = setTimeout(() => {
        if (settled) return
        diagnostic('timeout', { stdoutChars: stdoutBuf.length, resultStatus })
        settled = true
        cleanup()
        killProcessTree(child)
        reject(new Error(generationFailureMessage(failureKind, true)))
      }, timeoutSec * 1000)

      // 中止信号：杀整棵进程树（Windows 上 SIGTERM 常杀不干净孙进程）
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        killProcessTree(child)
        reject(new Error(LLM_ABORTED_ERROR))
      }
      // 即使取消或超时后 CLI 不发送 close，也要释放串行队列。
      const cleanup = (): void => {
        clearTimeout(timeout)
        clearTimeout(closeTimer)
        clearTimeout(reapTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort()
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return
        // 防止 UTF-8 多字节字符被 chunk 边界截断导致乱码（�）：
        // 中文字符占 3 字节，若 chunk 恰好在字符中间断开，toString('utf8') 会输出 U+FFFD。
        // 方案：拼上前一个 chunk 的尾部残留，按完整字符边界截取，不完整的尾部留给下一个 chunk。
        const combined = Buffer.concat([stdoutPending, chunk])
        const completeLen = utf8CompleteLength(combined)
        const decoded = combined.subarray(0, completeLen).toString('utf8')
        stdoutPending = combined.subarray(completeLen)
        if (lastOutputMs === null) diagnostic('first_stdout')
        lastOutputMs = Date.now() - startedAt
        if (!structured) {
          stdoutBuf += decoded
          if (decoded && !streaming) { streaming = true; opts.onStatus?.('streaming') }
          opts.onToken?.(decoded)
          return
        }
        jsonBuffer += decoded
        let newline: number
        while ((newline = jsonBuffer.indexOf('\n')) >= 0) {
          const line = jsonBuffer.slice(0, newline).trim()
          jsonBuffer = jsonBuffer.slice(newline + 1)
          if (!line) continue
          try {
            const message = JSON.parse(line)
            if (message.event === 'step_update') {
              const step = message.step_update
              if (step?.step_type === 'error_message') {
                const kind = classifyAntigravityFailure(JSON.stringify(step))
                if (kind !== 'unknown') failureKind = kind
                diagnostic('generation_error', { failureKind, fields: Object.keys(step) })
              }
              if (step?.state === 'DONE') diagnostic('step_done', { stepType: step.step_type, stepIndex: step.step_index })
              if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && !resultReceived) {
                if (!streaming && step.text_delta) { streaming = true; opts.onStatus?.('streaming') }
                opts.onToken?.(step.text_delta)
              }
            } else if (message.event === 'result') {
              if (resultReceived) throw new Error('duplicate result')
              resultReceived = true
              resultStatus = message.result?.status
              if (resultStatus !== 'SUCCESS' || typeof message.result?.response !== 'string' || !message.result.response.trim()) {
                const kind = classifyAntigravityFailure(typeof message.result?.error === 'string' ? message.result.error : '')
                if (kind !== 'unknown') failureKind = kind
                protocolError = generationFailureMessage(failureKind)
              } else {
                stdoutBuf = message.result.response
              }
              const usage = message.result?.usage
              if (usage && [usage.input_tokens, usage.output_tokens, usage.total_tokens].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
                cliUsage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens }
              }
              diagnostic('result', { status: resultStatus, responseChars: stdoutBuf.length, usage: cliUsage,
                thinkingTokens: typeof usage?.thinking_tokens === 'number' ? usage.thinking_tokens : undefined })
              // 官方 result 是生成完成边界。只给 CLI 收尾宽限，不再等待模型超时。
              clearTimeout(timeout)
              closeTimer = setTimeout(() => {
                diagnostic('cleanup_stalled')
                forcedCleanup = true
                reapTimer = setTimeout(() => {
                  if (settled) return
                  settled = true
                  cleanup()
                  reject(new Error('AGY_ERROR: CLI 清理未完成'))
                }, 5000)
                killProcessTree(child)
              }, 1500)
            }
          } catch {
            protocolError = 'AGY_ERROR: CLI 结构化输出损坏'
          }
        }
      })
      child.on('exit', (code, signal) => diagnostic('exit', { code, signal }))
      child.stdout.on('end', () => diagnostic('stdout_end'))

      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return
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
        diagnostic('close', { code, forcedCleanup })
        if (settled) return
        settled = true
        cleanup()

        // flush 残留的不完整 UTF-8 尾部字节（正常情况应为空，防御性处理）
        if (stdoutPending.length > 0) {
          const rest = stdoutPending.toString('utf8')
          if (structured) jsonBuffer += rest
          else { stdoutBuf += rest; opts.onToken?.(rest) }
          stdoutPending = Buffer.alloc(0)
        }

        // 用户取消（超时由 --print-timeout / 上层 timeoutSec 处理）
        if (opts.signal?.aborted) {
          reject(new Error(LLM_ABORTED_ERROR))
          return
        }

        if (structured && (protocolError || !resultReceived || jsonBuffer.trim() || stdoutPending.length)) {
          // 非零退出仍交由下面的 stderr 分类（认证/限流等）。
          if (code === 0 || resultReceived) {
            reject(new Error(protocolError || 'AGY_ERROR: CLI 缺少完整成功结果'))
            return
          }
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
          /^Error:/i.test(trimmed) || /^Error:/i.test(stderrTrimmed) || (code !== 0 && !(forcedCleanup && resultReceived && !protocolError))

        if (hasError) {
          // 优先取 stderr 的 Error 行，其次 stdout
          const errorSource = stderrTrimmed || trimmed
          const msg = errorSource.split('\n')[0].replace(/^Error:\s*/i, '')
          // 仅开发环境记录详细诊断信息，生产环境避免敏感信息泄露
          if (process.env.NODE_ENV === 'development') {
            console.error('[antigravity] execution failed.', {
              code,
              msg,
              hint:
                /Agent execution terminated/i.test(msg) ? 'agent 内部调用失败，通常是模型超时/限流或网络问题' :
                /timeout/i.test(msg) ? '打印超时，可尝试在设置中增大 --print-timeout' :
                code !== 0 && !errorSource ? '进程异常退出，无错误输出，可能是被系统杀死或内存不足' :
                '检查网络连接或 CLI 登录状态'
            })
          }
          if (/authenticat|sign\s*in|credential|unauthorized|401|403/i.test(msg)) {
            // 仅开发环境记录认证失败上下文
            if (process.env.NODE_ENV === 'development') {
              console.error('[antigravity] auth failed.', {
                cwd: process.cwd(),
                APPDATA: process.env.APPDATA,
                USERPROFILE: process.env.USERPROFILE,
                LOCALAPPDATA: process.env.LOCALAPPDATA
              })
            }
            // agy 靠本机 Google OAuth，access token 过期会自动用 refresh token 刷新，
            // 通常无需手动重新登录。此处认证失败多为刷新瞬间的暂时性失效。
            // runAntigravity 层会自动重试一次（等 1.5s 让 token 刷新），此处仅在重试仍失败时抛出。
            // 用独立错误码 AGY_AUTH_EXPIRED 与 HTTP API Key 失效（LLM_AUTH_FAILED）区分，
            // 前端据此给出"稍后重试"而非"检查 API Key"的提示。
            reject(new Error('AGY_AUTH_EXPIRED'))
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
        // 截断 200 字符；仅含 CLI 诊断信息（非密钥），保留生产日志便于排障
        if (stderrTrimmed) {
          console.warn('[antigravity] stderr:', stderrTrimmed.slice(0, 200))
        }

        // 优先使用 CLI 真实用量（含思考消耗）；旧版缺失时才按字数估算。
        const outputTokens = Math.ceil(full.length / 1.5)
        const usage: UsageInfo = cliUsage ?? {
          inputTokens: 0,
          outputTokens,
          totalTokens: outputTokens
        }
        resolve({ full, usage })
      })

      // stdin 立即关闭（prompt 已作为 -p 参数传入，不再走 stdin）
      child.stdin.end()
    }).finally(async () => {
      // Only the fresh directory created above is removed; no novel or user CLI configuration is touched.
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
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
 * 净化 agy 模型参数。
 * 1. 若传入 undefined、空串或 'default'，返回 undefined（走 agy 默认模型）。
 * 2. 若传入制表符混杂串（例如从旧版直接存入的 "gemini-3.8-flash-high\tGemini 3.8 Flash (High)"），
 *    自动剥离，提取有效显示名 "Gemini 3.8 Flash (High)" 或 slug。
 * 3. 去除 ANSI 转义字符与首尾空白。
 */
export function sanitizeAgyModel(raw?: string): string | undefined {
  if (!raw) return undefined
  let clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim()
  clean = clean.replace(/^['"]+|['"]+$/g, '').trim()
  if (!clean || clean === 'default') return undefined

  if (clean.includes('\t')) {
    const parts = clean.split('\t').map((s) => s.trim()).filter(Boolean)
    clean = parts[1] || parts[0] || ''
  } else if (/\s{2,}/.test(clean)) {
    const parts = clean.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2 && /^[a-z0-9-_.]+$/i.test(parts[0])) {
      clean = parts[1] || parts[0] || ''
    }
  }
  return clean || undefined
}

/**
 * 解析 `agy models` 输出中的单行。
 * agy CLI 输出格式（实测）：
 * - 第 1 行为提示信息：`Fetching available models...`（需丢弃）
 * - 随后为各模型行，采用制表符分隔：`[slug]\t[Display Name]`
 *   例如：`gemini-3.8-flash-high\tGemini 3.8 Flash (High)`
 * - 失败时可能输出：`Error: Please sign in...`
 *
 * 本函数提取用户可读的显示名（含档位信息，如 `Gemini 3.8 Flash (High)`），
 * 兼容无制表符的纯显示名行，并自动剔除提示行与空行。
 */
export function parseAgyModelLine(line: string): string | null {
  const clean = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim()
  if (!clean) return null
  // 过滤提示信息与错误行
  if (/^(?:Fetching|Loading|Checking|Updating|Error:)/i.test(clean)) return null

  if (clean.includes('\t')) {
    const parts = clean.split('\t').map((s) => s.trim()).filter(Boolean)
    // parts[0] 为 slug，parts[1] 为显示名；优先返回显示名
    return parts[1] || parts[0] || null
  }
  if (/\s{2,}/.test(clean)) {
    const parts = clean.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2 && /^[a-z0-9-_.]+$/i.test(parts[0])) {
      return parts[1] || parts[0] || null
    }
  }
  return clean
}

/**
 * agy / Google 侧常见模型显示名（`agy --model` 用显示名，不是 slug）。
 * 当 `agy models` 因未登录/未安装失败时，作为设置页下拉兜底，
 * 避免只能手输；真实列表仍以 `agy models` 为准并优先展示。
 */
export const ANTIGRAVITY_KNOWN_MODELS: readonly string[] = [
  'Gemini 3.8 Flash (High)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (Low)',
  'Gemini 3.7 Flash (High)',
  'Gemini 3.7 Flash (Medium)',
  'Gemini 3.7 Flash (Low)',
  'Gemini 3.6 Flash (High)',
  'Gemini 3.6 Flash (Medium)',
  'Gemini 3.6 Flash (Low)',
  'Gemini 3.6 Flash (Minimal)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)'
]

/**
 * 列出 agy 可用模型（`agy models` 输出，每行一个显示名）。
 * 优先返回 CLI 实时列表；未登录/未安装/失败时回退到内置 Gemini 等预设（不抛错）。
 *
 * 实测 `agy models` 输出格式（agy 1.1.0+）：
 *   Fetching available models...
 *   gemini-3.8-flash-high\tGemini 3.8 Flash (High)
 *   ...
 * 认证失败时输出 `Error: Please sign in...`（exit 0）。
 */
export async function listAntigravityModels(): Promise<string[]> {
  const live = await listAntigravityModelsLive()
  if (live.length > 0) return live
  return [...ANTIGRAVITY_KNOWN_MODELS]
}

/** 仅调用 `agy models`，失败返回空（供测试与内部合并逻辑） */
export async function listAntigravityModelsLive(): Promise<string[]> {
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
        .map(parseAgyModelLine)
        .filter((l): l is string => Boolean(l))
      resolve(models)
    })
  })
}
