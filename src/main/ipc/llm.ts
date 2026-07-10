import { ipcMain, BrowserWindow } from 'electron'
import { safeHandle } from './safe-handle'
import { LlmService } from '../data/llm-service'
import { SecretStore } from '../data/secret-store'
import { listAntigravityModels } from '../data/antigravity-runner'
import { listCodexModels } from '../data/codex-runner'
import type { ProviderConfig, ListProvidersResult, ProviderSummary } from '../../shared/types'

/**
 * 渲染层向主进程发起 LLM 调用的入口。
 *
 * Provider 配置完全由用户控制：baseUrl / model / apiKey 都在设置页填写，
 * 主进程不再硬编码任何厂商。统一走 OpenAI Chat Completions 兼容协议。
 */

function maskKey(apiKey: string): string {
  const len = apiKey.length
  if (len === 0) return ''
  if (len <= 8) return '•'.repeat(len)
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`
}

function summarize(p: ProviderConfig): ProviderSummary {
  const proto = p.protocol ?? 'openai'
  const isCli = proto === 'antigravity' || proto === 'codex'
  return {
    id: p.id,
    label: p.label,
    homepage: p.homepage,
    baseUrl: p.baseUrl,
    model: p.model,
    protocol: proto,
    temperature: p.temperature,
    // CLI 协议靠本机登录态，无需 apiKey，视为已配置
    hasKey: isCli || Boolean(p.apiKey),
    keyMasked: proto === 'antigravity'
      ? 'agy 登录态'
      : proto === 'codex'
        ? 'codex 登录态'
        : maskKey(p.apiKey)
  }
}

/** 在 main 端对传入的 provider 做白名单字段校验，避免 preload 类型扩张攻击 */
function sanitizeProvider(input: unknown): ProviderConfig {
  if (!input || typeof input !== 'object') throw new Error('PROVIDER_INVALID')
  const o = input as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const label = typeof o.label === 'string' ? o.label.trim() : ''
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
  const model = typeof o.model === 'string' ? o.model.trim() : ''
  const apiKeyRaw = typeof o.apiKey === 'string' ? o.apiKey : ''
  const homepage = typeof o.homepage === 'string' ? o.homepage.trim() : undefined
  const protocolRaw = o.protocol
  const protocol: 'openai' | 'anthropic' | 'antigravity' | 'codex' =
    protocolRaw === 'anthropic' ? 'anthropic'
    : protocolRaw === 'antigravity' ? 'antigravity'
    : protocolRaw === 'codex' ? 'codex'
    : 'openai'
  if (!id) throw new Error('PROVIDER_INVALID: missing id')
  if (!label) throw new Error('PROVIDER_INVALID: missing label')
  // CLI 协议（antigravity/codex）：走本机 CLI，无需 baseUrl/apiKey，model 可空（走默认）
  if (protocol === 'antigravity' || protocol === 'codex') {
    let temperature: number | undefined
    if (
      typeof o.temperature === 'number' &&
      Number.isFinite(o.temperature) &&
      !Number.isNaN(o.temperature)
    ) {
      temperature = Math.min(2, Math.max(0, o.temperature))
    }
    const placeholderUrl = protocol === 'antigravity' ? 'antigravity://local' : 'codex://local'
    const out: ProviderConfig = {
      id,
      label,
      baseUrl: baseUrl || placeholderUrl,
      model: model || 'default',
      apiKey: apiKeyRaw,
      protocol,
      ...(homepage ? { homepage } : {}),
      ...(temperature !== undefined ? { temperature } : {})
    }
    return out
  }
  // 非 antigravity：要求合法 http(s) URL + model
  if (!baseUrl) throw new Error('PROVIDER_INVALID: missing baseUrl')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('PROVIDER_INVALID: baseUrl is not a valid URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('PROVIDER_INVALID: baseUrl must use http or https')
  }
  if (!model) throw new Error('PROVIDER_INVALID: missing model')
  // temperature：可选，仅接受有限数字，clamp 到 [0,2]；非数字/缺省则不设置（走模型默认）
  let temperature: number | undefined
  if (
    typeof o.temperature === 'number' &&
    Number.isFinite(o.temperature) &&
    !Number.isNaN(o.temperature)
  ) {
    temperature = Math.min(2, Math.max(0, o.temperature))
  }
  const out: ProviderConfig = {
    id,
    label,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: apiKeyRaw,
    protocol,
    ...(homepage ? { homepage } : {}),
    ...(temperature !== undefined ? { temperature } : {})
  }
  return out
}

export function registerLlmIpc(secret: SecretStore, service: LlmService): void {
  // 读取全部 provider（脱敏）+ 当前 active id
  safeHandle('llm:listProviders', async (): Promise<ListProvidersResult> => {
    const cfg = await secret.read()
    return {
      activeId: cfg.activeId,
      providers: cfg.providers.map(summarize)
    }
  })

  // 新增 / 更新 provider；空 apiKey 视为「保留旧 key 不变」
  safeHandle('llm:upsertProvider', async (_e, raw: unknown): Promise<ProviderConfig> => {
    const incoming = sanitizeProvider(raw)
    const cfg = await secret.read()
    const idx = cfg.providers.findIndex((x) => x.id === incoming.id)
    if (idx >= 0) {
      const prev = cfg.providers[idx]
      cfg.providers[idx] = {
        ...prev,
        ...incoming,
        apiKey: incoming.apiKey ? incoming.apiKey : prev.apiKey
      }
    } else {
      cfg.providers.push(incoming)
    }
    if (!cfg.activeId) cfg.activeId = incoming.id
    await secret.write(cfg)
    return incoming
  })

  // 删除 provider；若是 active 则 activeId 置空
  safeHandle('llm:deleteProvider', async (_e, id: string): Promise<void> => {
    if (typeof id !== 'string' || !id) throw new Error('PROVIDER_INVALID: id required')
    const cfg = await secret.read()
    cfg.providers = cfg.providers.filter((p) => p.id !== id)
    if (cfg.activeId === id) cfg.activeId = cfg.providers[0]?.id ?? ''
    await secret.write(cfg)
  })

  // 切换 active provider
  safeHandle('llm:setActive', async (_e, id: string): Promise<string> => {
    if (typeof id !== 'string' || !id) throw new Error('PROVIDER_INVALID: id required')
    const cfg = await secret.read()
    if (!cfg.providers.some((p) => p.id === id)) {
      throw new Error('PROVIDER_NOT_FOUND')
    }
    cfg.activeId = id
    await secret.write(cfg)
    return id
  })

  // 是否存在任意已配置 key（仅判断 active provider）
  // CLI 协议（antigravity/codex）靠本机登录态，无需 apiKey，视为已配置
  safeHandle('llm:hasKey', async (): Promise<boolean> => {
    const cfg = await secret.read()
    if (!cfg.activeId) return false
    const p = cfg.providers.find((x) => x.id === cfg.activeId)
    if (!p) return false
    if (p.protocol === 'antigravity' || p.protocol === 'codex') return true
    return Boolean(p.apiKey)
  })

  // 联通测试
  safeHandle('llm:ping', async () => {
    return service.ping()
  })

  // 列出 agy 可用模型（供前端做模型下拉选择）
  safeHandle('llm:listAntigravityModels', async (): Promise<string[]> => {
    return listAntigravityModels()
  })

  // 列出 codex 可用模型（读 config.toml，供前端做模型选择）
  safeHandle('llm:listCodexModels', async (): Promise<string[]> => {
    return listCodexModels()
  })

  // 流式生成（保持原协议：onToken + requestId）
  ipcMain.handle(
    'llm:generate',
    async (e, payload: { prompt: string; requestId: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      try {
        await service.generateStream(payload.prompt, {
          meta: { feature: 'other' },
          onToken: (token) =>
            win?.webContents.send('llm:token', {
              requestId: payload.requestId,
              token,
              done: false
            })
        })
        win?.webContents.send('llm:token', { requestId: payload.requestId, token: '', done: true })
        return { ok: true }
      } catch (err) {
        console.error('[ipc:llm:generate]', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // 旧 configureLlm：写默认 OpenAI provider（保持向后兼容）
  safeHandle('llm:configure', async (_e, apiKey: unknown): Promise<boolean> => {
    if (typeof apiKey !== 'string') throw new Error('PROVIDER_INVALID: apiKey required')
    const cfg = await secret.read()
    const id = 'p_openai_default'
    const idx = cfg.providers.findIndex((p: ProviderConfig) => p.id === id)
    const next: ProviderConfig = {
      id,
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey
    }
    if (idx >= 0) cfg.providers[idx] = next
    else cfg.providers.push(next)
    if (!cfg.activeId) cfg.activeId = id
    await secret.write(cfg)
    return true
  })
}