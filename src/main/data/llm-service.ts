import type { SecretStore } from './secret-store'
import type { ProviderConfig, FeatureCategory, PingResult } from '../../shared/types'
import type { UsageRepository } from './usage-repository'
import { runAntigravity, probeAntigravity } from './antigravity-runner'
import { runCodex, probeCodex } from './codex-runner'
import { runGrok, probeGrok } from './grok-runner'

export interface GenerateOptions {
  onToken?: (token: string) => void
  signal?: AbortSignal
  /** 调用方上下文，用于用量归属 */
  meta?: { feature: string; projectId?: string; chapterNumber?: number }
  /**
   * 可选 system prompt。
   * - OpenAI 协议：作为 messages 数组首项 { role: 'system', content }
   * - Anthropic 协议：作为请求体顶层 system 字段
   * 未提供时退化为旧行为（仅 user 单条消息）。
   */
  systemPrompt?: string
  /** 临时续写上下文指导语 */
  tempContext?: string
  /** 本章已写正文前部（续写用） */
  existingText?: string

  /**
   * 生成上限 token 数。
   * - 不传时使用 DEFAULT_MAX_TOKENS
   * - 中文约 1 字 ≈ 1.5~2 token，章节目标字数需换算后留足空间，否则会被物理截断
   */
  maxTokens?: number
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

function protocolOf(p: ProviderConfig): 'openai' | 'anthropic' | 'antigravity' | 'codex' | 'grok' {
  return p.protocol ?? 'openai'
}

/**
 * 用量记录用的模型展示名。
 * CLI 协议在配置里常写 model="default"（走 CLI/config 默认），若原样入库则用量页只剩
 * 看不出通道的 "default"。拼上 provider 标签与协议，便于对照「正文生成」路由。
 */
function usageModelLabel(p: ProviderConfig): string {
  const model = (p.model ?? '').trim() || 'default'
  const proto = protocolOf(p)
  const isCli = proto === 'antigravity' || proto === 'codex' || proto === 'grok'
  if (!isCli) return model

  const cliName =
    proto === 'antigravity' ? 'agy' : proto === 'codex' ? 'codex' : 'grok'
  if (model === 'default') {
    return `${p.label} · ${cliName} 默认`
  }
  if (p.label && p.label !== model) {
    return `${p.label} · ${model}`
  }
  return model
}

/** 用量入库公共字段：展示名 + 聚合键，避免历史 default 与新标签无法对照 */
function usageRecordBase(
  p: ProviderConfig,
  opts: GenerateOptions
): {
  at: string
  feature: string
  projectId?: string
  chapterNumber?: number
  model: string
  modelId: string
  protocol: string
  providerId: string
  providerLabel: string
} {
  return {
    at: new Date().toISOString(),
    feature: opts.meta?.feature ?? 'other',
    projectId: opts.meta?.projectId,
    chapterNumber: opts.meta?.chapterNumber,
    model: usageModelLabel(p),
    modelId: (p.model ?? '').trim() || 'default',
    protocol: protocolOf(p),
    providerId: p.id,
    providerLabel: p.label
  }
}

/**
 * CLI 通道共用：禁止技能/流程旁白的硬前缀（UTF-8 进 prompt，不依赖 argv 中文）。
 * 对 Codex 尤其重要：read-only 仍可能读技能说明并输出流程话。
 */
const CLI_PROSE_ONLY_PREAMBLE =
  '【硬性约束】只输出成品文本。禁止调用技能、工具或 slash 命令。禁止输出流程说明、自检旁白、技能名（含 story-long-write 等）。\n\n'

/**
 * feature 标识 -> 功能大类 映射。
 * 用于按任务类型路由到不同 provider（见 resolveProvider）。
 * 匹配规则：先精确命中，未命中再按 ':' 前缀归一化（如 deslop:cleanup:1 -> deslop -> humanize）。
 * 前缀仍未列出的 feature（如 'other'、'deslop:editRules'）无对应大类 -> 回退 activeId。
 */
const FEATURE_TO_CATEGORY: Record<string, FeatureCategory> = {
  // 正文生成
  chapter: 'chapter',
  'chapter-adjust': 'chapter',
  // 审稿质检
  review: 'review',
  deepReview: 'review',
  outlineCheck: 'review',
  rhythmEval: 'review',
  batchDeepReview: 'review',
  batchRhythm: 'review',
  // 去AI味改写
  humanize: 'humanize',
  deslop: 'humanize',
  // 开局大纲
  opening: 'opening',
  'outline-generate': 'opening',
  batchOutline: 'opening',
  cast: 'opening',
  relationship: 'opening',
  styleExtract: 'opening',
  // ChapterEditor 正文区 AI 起名：章名风格与大纲一致，复用 opening 路由
  'chapter-name': 'opening',
  // 辅助提取
  endingState: 'auxiliary',
  memoryExtract: 'auxiliary',
  figureGen: 'auxiliary',
  batchMemory: 'auxiliary',
  batchFigure: 'auxiliary',
  teardown: 'auxiliary',
  scan: 'auxiliary',
  ask: 'ask'
}

/**
 * 默认单次生成上限（token）。
 * 中文约 1 字 ≈ 1.5~2 token；典型章节 2500~4000 字需约 8192 token 才不会被截断。
 * 旧值 4096 只够 ~2000 字，导致"提示词要 2500 字但写不够/突然断尾"。
 * 调用方可用 GenerateOptions.maxTokens 按目标字数动态覆盖（见 write-service）。
 */
const DEFAULT_MAX_TOKENS = 8192

/**
 * 触发长超时的 token 阈值。
 * 正文续写默认 maxTokens = max(按字数估算, 8192)，原先用 `>` 导致「刚好 8192」仍只等 2 分钟，
 * 整章生成经常被误杀。改为 `>=` 后，典型章节一律走 10 分钟。
 */
const LARGE_TOKEN_THRESHOLD = 8192
/** 大段生成的超时（10 分钟），避免长章节被默认超时误杀 */
const LARGE_STREAM_TIMEOUT_MS = 600_000
/** 短请求默认超时（2 分钟） */
const LLM_STREAM_TIMEOUT_MS = 120_000

/**
 * 需要长超时的分析类 feature（会塞整章正文/细纲，Kimi 等 API 经常 >2 分钟）。
 * 与正文续写一样走 10 分钟，避免「模型已切换但仍 aborted due to timeout」。
 */
const LONG_TIMEOUT_FEATURES = new Set([
  'chapter',
  'chapter-adjust',
  'outlineCheck',
  'review',
  'deepReview',
  'rhythmEval',
  'batchDeepReview',
  'batchRhythm',
  'ask',
  'memoryExtract',
  'figureGen',
  'batchMemory',
  'batchFigure',
  'humanize',
  'deslop'
])

/**
 * 解析本次流式生成的超时毫秒数。
 * - 正文 / 细纲对照 / 审稿 / 记忆等分析类 → 10 分钟
 * - maxTokens >= 8192 → 10 分钟
 * - 其余短请求 → 2 分钟
 * 导出供单测覆盖阈值边界。
 */
export function resolveStreamTimeoutMs(opts: GenerateOptions): number {
  const feature = opts.meta?.feature ?? ''
  const baseFeature = feature.split(':')[0]
  if (
    LONG_TIMEOUT_FEATURES.has(feature) ||
    LONG_TIMEOUT_FEATURES.has(baseFeature) ||
    feature.startsWith('chapter:')
  ) {
    return LARGE_STREAM_TIMEOUT_MS
  }
  if (opts.maxTokens != null && opts.maxTokens >= LARGE_TOKEN_THRESHOLD) {
    return LARGE_STREAM_TIMEOUT_MS
  }
  return LLM_STREAM_TIMEOUT_MS
}

function endpointOf(p: ProviderConfig): string {
  const base = p.baseUrl.replace(/\/+$/, '')
  if (protocolOf(p) === 'anthropic') {
    // Anthropic Messages API：baseUrl 结尾应为不带 /v1 的根，统一补 /v1/messages
    const hasV1 = base.endsWith('/v1')
    const v1Root = hasV1 ? base : `${base}/v1`
    return `${v1Root}/messages`
  }
  return `${base}/chat/completions`
}

function isRetryableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('terminated') ||
    msg.includes('aborted') ||
    msg.includes('socket') ||
    msg.includes('connection') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    (err instanceof TypeError && msg.includes('fetch'))
  )
}

/**
 * 识别超时/中止类错误。
 * Node/Electron 的 AbortSignal.timeout 常见为：
 * - DOMException name=TimeoutError，message="The operation was aborted due to timeout"
 * - DOMException name=AbortError
 * - 部分环境抛普通 Error，仅靠 message 匹配
 * 旧逻辑只认 AbortError，导致超时原文泄漏到 UI。
 */
function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true
  if (typeof e.message === 'string') {
    if (/aborted due to timeout/i.test(e.message)) return true
    if (/^The operation was aborted/i.test(e.message)) return true
  }
  return false
}

export class LlmService {
  constructor(
    private readonly secret: SecretStore,
    private readonly usage?: UsageRepository
  ) {}

  /**
   * 解析本次调用应使用的 provider。
   * 路由优先级：feature -> 功能大类 -> featureRouting -> 对应 provider（含模型覆盖）
   * 回退条件：无 feature / feature 未映射 / 路由未配置 / 路由指向的 provider 已删除 -> activeId
   * 模型覆盖：routing.model 非空时覆盖 provider.model，返回新对象（下游无感知）。
   */
  private async resolveProvider(feature?: string): Promise<ProviderConfig | null> {
    const cfg = await this.secret.read()
    // 精确匹配优先；未命中时按 ':' 前缀归一化（如 deslop:cleanup:1 -> deslop -> humanize）
    const category = feature
      ? FEATURE_TO_CATEGORY[feature] ?? FEATURE_TO_CATEGORY[feature.split(':')[0]]
      : undefined
    const routing = category ? cfg.featureRouting?.[category] : undefined
    const routed = routing ? cfg.providers.find((x) => x.id === routing.providerId) : undefined
    if (routed) {
      const modelOverride = routing!.model?.trim()
      return modelOverride ? { ...routed, model: modelOverride } : routed
    }
    return cfg.providers.find((x) => x.id === cfg.activeId) ?? null
  }

  /**
   * 轻量连通测试：发送 1 token 的请求，成功即返回模型名。
   * @param providerId 可选；传入时精确测试该 provider（不影响 active），
   *   用于设置页「每张 provider 卡片独立测试」场景。
   *   不传则保持原有行为：走 feature 路由 + activeId 解析（向后兼容全局测试按钮）。
   */
  async ping(providerId?: string): Promise<PingResult> {
    let p: ProviderConfig | null = null
    if (providerId) {
      const cfg = await this.secret.read()
      p = cfg.providers.find((x) => x.id === providerId) ?? null
    } else {
      p = await this.resolveProvider()
    }
    if (!p) return { ok: false, error: 'NO_KEY' }
    return this.pingOne(p)
  }

  /**
   * 针对单个 provider 的连通探测。被 ping() 复用。
   * 协议分支：antigravity → 本机 agy CLI；codex → 本机 codex CLI；
   * grok → 本机 grok CLI；openai/anthropic → HTTP 1 token 请求。
   */
  private async pingOne(p: ProviderConfig): Promise<PingResult> {
    const proto = protocolOf(p)
    // antigravity 协议：走本机 agy CLI，无需 apiKey
    if (proto === 'antigravity') {
      const version = await probeAntigravity()
      if (!version) return { ok: false, error: 'AGY_NOT_FOUND' }
      try {
        // runAntigravity 内部已做 Error: 前缀检测与错误码映射，抛错即失败
        await runAntigravity('回复一个字：好', {
          model: p.model && p.model !== 'default' ? p.model : undefined,
          timeoutSec: 60,
          signal: AbortSignal.timeout(70_000)
        })
        return { ok: true, model: p.model, providerLabel: p.label }
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'AGY_ERROR' }
      }
    }
    // codex 协议：走本机 codex CLI，无需 apiKey（靠 ChatGPT 登录）
    if (proto === 'codex') {
      const version = await probeCodex()
      if (!version) return { ok: false, error: 'CODEX_NOT_FOUND' }
      try {
        await runCodex('回复一个字：好', {
          model: p.model && p.model !== 'default' ? p.model : undefined,
          timeoutSec: 60,
          signal: AbortSignal.timeout(70_000)
        })
        return { ok: true, model: p.model, providerLabel: p.label }
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'CODEX_ERROR' }
      }
    }
    // grok 协议：走本机 grok CLI，无需 apiKey（靠 grok login）
    if (proto === 'grok') {
      const version = await probeGrok()
      if (!version) return { ok: false, error: 'GROK_NOT_FOUND' }
      try {
        await runGrok('回复一个字：好', {
          model: p.model && p.model !== 'default' ? p.model : undefined,
          timeoutSec: 90,
          signal: AbortSignal.timeout(100_000)
        })
        return { ok: true, model: p.model, providerLabel: p.label }
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'GROK_ERROR' }
      }
    }
    if (!p.apiKey) return { ok: false, error: 'NO_KEY' }
    try {
      const { url, init } = buildPingRequest(p)
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
      if (res.status === 401 || res.status === 403)
        return { ok: false, error: 'LLM_AUTH_FAILED' }
      if (res.status === 429) return { ok: false, error: 'LLM_RATE_LIMIT' }
      if (!res.ok) return { ok: false, error: 'LLM_REQUEST_FAILED' }
      return { ok: true, model: p.model, providerLabel: p.label }
    } catch (err) {
      if (isAbortError(err)) return { ok: false, error: 'LLM_TIMEOUT' }
      return { ok: false, error: (err as Error).message || 'NETWORK_ERROR' }
    }
  }

  async generateStream(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const p = await this.resolveProvider(opts.meta?.feature)
    if (!p) throw new Error('LLM_NOT_CONFIGURED')
    const proto = protocolOf(p)
    // antigravity 协议：走本机 agy CLI 子进程，不需 apiKey（靠本机 OAuth 登录）
    if (proto === 'antigravity') {
      return this.generateViaAntigravity(p, prompt, opts)
    }
    // codex 协议：走本机 codex CLI 子进程，不需 apiKey（靠 ChatGPT 登录）
    if (proto === 'codex') {
      return this.generateViaCodex(p, prompt, opts)
    }
    // grok 协议：走本机 grok CLI 子进程，不需 apiKey（靠 grok login）
    if (proto === 'grok') {
      return this.generateViaGrok(p, prompt, opts)
    }
    if (!p.apiKey) throw new Error('LLM_NOT_CONFIGURED')

    const MAX_RETRIES = 2
    const RETRY_DELAYS_MS = [1000, 2000]
    let hasReceivedTokens = false
    const wrappedOnToken = opts.onToken
      ? (token: string) => {
          hasReceivedTokens = true
          opts.onToken!(token)
        }
      : undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const timeoutMs = resolveStreamTimeoutMs(opts)
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const combinedSignal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal

        const { url, init } = buildStreamRequest(
          p,
          prompt,
          combinedSignal,
          opts.systemPrompt,
          opts.maxTokens
        )
        const res = await fetch(url, init)

        if (!res.ok) {
          if (res.status === 401 || res.status === 403) throw new Error('LLM_AUTH_FAILED')
          if (res.status === 429) throw new Error('LLM_RATE_LIMIT')
          if (res.status >= 500 && attempt < MAX_RETRIES && !hasReceivedTokens) {
            console.warn(`[llm-service] Server error ${res.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms...`)
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
            continue
          }
          throw new Error(`LLM_REQUEST_FAILED_${res.status}`)
        }

        const proto = protocolOf(p)
        const { full, usage } =
          proto === 'anthropic'
            ? await parseAnthropicSse(res.body as ReadableStream<Uint8Array>, wrappedOnToken)
            : await parseOpenAiSse(res.body as ReadableStream<Uint8Array>, wrappedOnToken)

        if (this.usage && usage) {
          try {
            await this.usage.add({
              ...usageRecordBase(p, opts),
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens
            })
          } catch (err) {
            console.error('[llm-service] Failed to record usage:', err)
          }
        }
        return full
      } catch (err) {
        if (isAbortError(err)) {
          // 用户取消 vs 超时：combined signal 时优先认用户 signal
          if (opts.signal?.aborted) throw new Error('LLM_ABORTED')
          throw new Error(hasReceivedTokens ? 'LLM_OUTPUT_TRUNCATED' : 'LLM_TIMEOUT')
        }
        if (!hasReceivedTokens && isRetryableStreamError(err) && attempt < MAX_RETRIES) {
          console.warn(`[llm-service] Stream error (${(err as Error).message}), retrying in ${RETRY_DELAYS_MS[attempt]}ms...`)
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
          continue
        }
        if (hasReceivedTokens && isRetryableStreamError(err)) {
          throw new Error('LLM_OUTPUT_TRUNCATED')
        }
        throw err
      }
    }
    throw new Error('LLM_REQUEST_FAILED')
  }

  /**
   * antigravity 协议调用：委托 antigravity-runner 跑 `agy -p` 子进程。
   * systemPrompt 与 user prompt 合并为单条（agy -p 是单轮，不支持 system role）。
   * 复用调用方的 onToken 回调（伪流式：agy 实际非流式，按 stdout 数据块喂回）。
   * 用量记录与 HTTP 路径一致。
   */
  private async generateViaAntigravity(
    p: ProviderConfig,
    prompt: string,
    opts: GenerateOptions
  ): Promise<string> {
    // 合并 system + user：agy -p 单轮，把 system 作为前置指令
    const body =
      opts.systemPrompt && opts.systemPrompt.trim()
        ? `${opts.systemPrompt}\n\n---\n\n${prompt}`
        : prompt
    const merged = CLI_PROSE_ONLY_PREAMBLE + body

    const timeoutMs = resolveStreamTimeoutMs(opts)
    // 仅传用户 signal；超时由 runner 的 timeoutSec / agy --print-timeout 负责，
    // 以便区分 LLM_ABORTED 与 LLM_TIMEOUT
    const { full, usage } = await runAntigravity(merged, {
      model: p.model && p.model !== 'default' ? p.model : undefined,
      timeoutSec: Math.ceil(timeoutMs / 1000),
      onToken: opts.onToken,
      signal: opts.signal
    })

    if (this.usage && usage) {
      try {
        await this.usage.add({
          ...usageRecordBase(p, opts),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens
        })
      } catch (err) {
        console.error('[llm-service] Failed to record antigravity usage:', err)
      }
    }
    return full
  }

  /**
   * codex 协议调用：委托 codex-runner 跑 `codex exec` 子进程。
   * systemPrompt 与 user prompt 合并为单条（codex exec 单轮，不支持 system role）。
   * codex 返回精确 token 用量（turn.completed.usage），比 agy 估算更准。
   * 不需串行化（--ephemeral session 隔离，并发安全）。
   */
  private async generateViaCodex(
    p: ProviderConfig,
    prompt: string,
    opts: GenerateOptions
  ): Promise<string> {
    const body =
      opts.systemPrompt && opts.systemPrompt.trim()
        ? `${opts.systemPrompt}\n\n---\n\n${prompt}`
        : prompt
    // Codex read-only 仍可能读技能说明；前缀硬约束 + write-service assertNovelProse
    const merged = CLI_PROSE_ONLY_PREAMBLE + body

    const timeoutMs = resolveStreamTimeoutMs(opts)
    const { full, usage } = await runCodex(merged, {
      model: p.model && p.model !== 'default' ? p.model : undefined,
      timeoutSec: Math.ceil(timeoutMs / 1000),
      onToken: opts.onToken,
      signal: opts.signal
    })

    if (this.usage && usage) {
      try {
        await this.usage.add({
          ...usageRecordBase(p, opts),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens
        })
      } catch (err) {
        console.error('[llm-service] Failed to record codex usage:', err)
      }
    }
    return full
  }

  /**
   * grok 协议调用：委托 grok-runner 跑 `grok --prompt-file` headless。
   * systemPrompt 与 user prompt 合并为单条（CLI 单轮，不支持 system role）。
   * 用量优先用 streaming-json end 事件的真实 token 数。
   */
  private async generateViaGrok(
    p: ProviderConfig,
    prompt: string,
    opts: GenerateOptions
  ): Promise<string> {
    const body =
      opts.systemPrompt && opts.systemPrompt.trim()
        ? `${opts.systemPrompt}\n\n---\n\n${prompt}`
        : prompt
    // grok-runner 也会在 prompt 文件头加约束；此处再叠一层保证与其它 CLI 一致
    const merged = CLI_PROSE_ONLY_PREAMBLE + body

    const timeoutMs = resolveStreamTimeoutMs(opts)
    const { full, usage } = await runGrok(merged, {
      model: p.model && p.model !== 'default' ? p.model : undefined,
      timeoutSec: Math.ceil(timeoutMs / 1000),
      onToken: opts.onToken,
      signal: opts.signal
    })

    if (this.usage && usage) {
      try {
        await this.usage.add({
          ...usageRecordBase(p, opts),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens
        })
      } catch (err) {
        console.error('[llm-service] Failed to record grok usage:', err)
      }
    }
    return full
  }
}

/* =========================================================
   请求构造：按协议分流
   ========================================================= */

function buildPingRequest(p: ProviderConfig): { url: string; init: RequestInit } {
  const url = endpointOf(p)
  if (protocolOf(p) === 'anthropic') {
    return {
      url,
      init: {
        method: 'POST',
        headers: anthropicHeaders(p.apiKey),
        body: JSON.stringify({
          model: p.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      }
    }
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      })
    }
  }
}

function buildStreamRequest(
  p: ProviderConfig,
  prompt: string,
  signal?: AbortSignal,
  systemPrompt?: string,
  maxTokens?: number
): { url: string; init: RequestInit } {
  const url = endpointOf(p)
  const init: RequestInit = { method: 'POST', signal }
  const hasSystem = !!systemPrompt && systemPrompt.trim().length > 0
  // 单次生成上限。中文 1 字 ≈ 1.5~2 token；章节正文约 2500~4000 字，需 8192 才不致截断。
  const cap = maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS
  // 采样温度：仅在 provider 显式配置时透传，否则走模型默认
  const hasTemp = typeof p.temperature === 'number' && Number.isFinite(p.temperature)
  if (protocolOf(p) === 'anthropic') {
    init.headers = anthropicHeaders(p.apiKey)
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: cap,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    }
    if (hasSystem) body.system = systemPrompt
    if (hasTemp) body.temperature = p.temperature
    init.body = JSON.stringify(body)
  } else {
    init.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`
    }
    const messages: Array<{ role: string; content: string }> = []
    if (hasSystem) messages.push({ role: 'system', content: systemPrompt as string })
    messages.push({ role: 'user', content: prompt })
    const body: Record<string, unknown> = {
      model: p.model,
      messages,
      max_tokens: cap,
      stream: true
    }
    if (hasTemp) body.temperature = p.temperature
    init.body = JSON.stringify(body)
  }
  return { url, init }
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'api-key': apiKey,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-15'
  }
}

/* =========================================================
   SSE 解析：OpenAI / Anthropic 两种格式
   ========================================================= */

/**
 * LLM 响应最大字符数。
 * 防止恶意或错误的 LLM 响应导致内存耗尽。
 * 基于典型章节长度（约 5000 字符）的 40 倍安全边际。
 */
const MAX_RESPONSE_CHARS = 200_000

async function parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<{ full: string; usage: UsageInfo | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let usage: UsageInfo | null = null
  let finishReason = ''
  const MAX = MAX_RESPONSE_CHARS
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        const choice = json.choices?.[0]
        const token = choice?.delta?.content
        if (token) {
          full += token
          if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
          onToken?.(token)
        }
        if (choice?.finish_reason) finishReason = String(choice.finish_reason)
        const u = json.usage
        if (u && typeof u === 'object') {
          usage = {
            inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
            outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
            totalTokens: Number(u.total_tokens ?? 0) || 0
          }
        }
      } catch (err) {
        console.warn('[llm-service] Failed to parse SSE chunk:', data.substring(0, 100), err)
        // skip malformed chunk
      }
    }
  }
  if (finishReason === 'length') throw new Error('LLM_OUTPUT_TRUNCATED')
  if (!usage) {
    const out = Math.ceil(full.length / 1.5)
    usage = { inputTokens: 0, outputTokens: out, totalTokens: out }
  }
  return { full, usage }
}

/**
 * Anthropic Messages API 流式事件格式：
 *   event: message_start     data: { message: { usage: { input_tokens, output_tokens } } }
 *   event: content_block_start
 *   event: content_block_delta data: { delta: { type: 'text_delta', text: '...' } }
 *   event: content_block_stop
 *   event: message_delta     data: { usage: { output_tokens } }
 *   event: message_stop
 */
async function parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (t: string) => void
): Promise<{ full: string; usage: UsageInfo | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = ''
  const MAX = MAX_RESPONSE_CHARS

  const flushEvent = (eventLines: string[]): void => {
    if (eventLines.length === 0) return
    let eventName = ''
    const dataLines: string[] = []
    for (const line of eventLines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    const dataStr = dataLines.join('\n')
    if (!dataStr) return
    let json: Record<string, unknown>
    try {
      json = JSON.parse(dataStr)
    } catch (err) {
      console.warn('[llm-service] Failed to parse Anthropic SSE event:', dataStr.substring(0, 100), err)
      return
    }
    // token 文本：content_block_delta.delta.text
    if (eventName === 'content_block_delta') {
      const delta = json.delta as { text?: string } | undefined
      const token = delta?.text
      if (token) {
        full += token
        if (full.length > MAX) throw new Error('LLM_RESPONSE_TOO_LARGE')
        onToken?.(token)
      }
    }
    // 用量：message_start 拿 input_tokens；message_delta 累加 output_tokens
    if (eventName === 'message_start') {
      const msg = json.message as { usage?: { input_tokens?: number } } | undefined
      inputTokens = Number(msg?.usage?.input_tokens ?? 0) || 0
    }
    if (eventName === 'message_delta') {
      const u = json.usage as { output_tokens?: number } | undefined
      outputTokens = Number(u?.output_tokens ?? 0) || outputTokens
      const reason = json.stop_reason
      if (reason) stopReason = String(reason)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Anthropic 用 \r\n\r\n 分隔 event
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const ev of events) {
      const lines = ev.split(/\r?\n/).filter(Boolean)
      flushEvent(lines)
    }
  }
  // 残留 buffer 也尝试 flush
  if (buffer.trim()) flushEvent(buffer.split(/\r?\n/).filter(Boolean))

  if (stopReason === 'max_tokens') throw new Error('LLM_OUTPUT_TRUNCATED')

  const usage: UsageInfo | null =
    inputTokens > 0 || outputTokens > 0
      ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
      : {
          inputTokens: 0,
          outputTokens: Math.ceil(full.length / 1.5),
          totalTokens: Math.ceil(full.length / 1.5)
        }
  return { full, usage }
}
