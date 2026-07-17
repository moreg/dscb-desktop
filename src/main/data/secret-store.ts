import { safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { ProvidersConfig, ProviderConfig } from '../../shared/types'
import { z } from 'zod'
import { validateInput } from '../ipc/validation'

export type { ProviderConfig } from '../../shared/types'

const EMPTY: ProvidersConfig = { activeId: '', providers: [] }

// Provider 配置验证模式（类型/长度约束层）
// antigravity 协议：走本机 agy CLI，baseUrl 可为空/占位符、apiKey 可为空（靠 OAuth 登录）、model 可空。
// 必填校验（非 antigravity 时要求 baseUrl/model/apiKey）由 IPC 层 sanitizeProvider 统一把关。
const providerConfigSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  baseUrl: z.string().max(2048),
  model: z.string().max(255),
  apiKey: z.string().max(1000),
  protocol: z.enum(['openai', 'anthropic', 'antigravity', 'codex', 'grok']).optional(),
  homepage: z.string().max(2048).optional(),
  temperature: z.number().min(0).max(2).optional()
})

const featureRoutingEntrySchema = z.object({
  providerId: z.string().min(1).max(100),
  model: z.string().max(255).optional()
})

const providersConfigSchema = z.object({
  activeId: z.string().max(100),
  providers: z.array(providerConfigSchema),
  // 功能大类 -> provider 路由（可选）。每个大类独立可选，未列出的回退 activeId。
  featureRouting: z
    .object({
      chapter: featureRoutingEntrySchema.optional(),
      review: featureRoutingEntrySchema.optional(),
      humanize: featureRoutingEntrySchema.optional(),
      opening: featureRoutingEntrySchema.optional(),
      auxiliary: featureRoutingEntrySchema.optional(),
      ask: featureRoutingEntrySchema.optional()
    })
    .optional()
})

interface LegacyShape {
  activeProvider?: string
  providers?: Record<string, { apiKey?: string }>
}

function isNewShape(o: unknown): o is ProvidersConfig {
  if (!o || typeof o !== 'object') return false
  const p = o as Record<string, unknown>
  if (!Array.isArray(p.providers)) return false
  if (typeof p.activeId !== 'string') return false
  for (const item of p.providers) {
    if (!item || typeof item !== 'object') return false
    const it = item as Record<string, unknown>
    if (typeof it.id !== 'string') return false
    if (typeof it.baseUrl !== 'string') return false
    // model 必须为 string，但允许空串（antigravity provider 可不指定 model，走 agy 默认）
    if (typeof it.model !== 'string') return false
    if (typeof it.apiKey !== 'string') return false
  }
  return true
}

/**
 * 把旧 schema（minimax/openai/claude/deepseek 分桶）转成新 schema（数组）。
 * 若文件无法解析 / 损坏，调用方会拿到 SCHEMA_INVALID 错误（通过抛 Error）。
 */
function migrate(legacy: LegacyShape | unknown): ProvidersConfig {
  if (isNewShape(legacy)) return legacy as ProvidersConfig
  const providers: ProviderConfig[] = []
  const lp: Record<string, { apiKey?: string }> =
    legacy && typeof legacy === 'object' && (legacy as LegacyShape).providers
      ? (legacy as LegacyShape).providers!
      : {}
  if (lp.minimax?.apiKey) {
    providers.push({
      id: 'p_legacy_minimax',
      label: 'minimax（旧）',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M3',
      apiKey: lp.minimax.apiKey,
      protocol: 'anthropic' as const
    })
  }
  if (lp.openai?.apiKey) {
    providers.push({
      id: 'p_legacy_openai',
      label: 'OpenAI（旧）',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: lp.openai.apiKey
    })
  }
  if (lp.claude?.apiKey) {
    providers.push({
      id: 'p_legacy_claude',
      label: 'Claude（旧）',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3-5-sonnet-latest',
      apiKey: lp.claude.apiKey
    })
  }
  if (lp.deepseek?.apiKey) {
    providers.push({
      id: 'p_legacy_deepseek',
      label: 'DeepSeek（旧）',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: lp.deepseek.apiKey
    })
  }
  const activeId = providers[0]?.id ?? ''
  return { activeId, providers }
}

export class SecretStore {
  private writePromise: Promise<void> | null = null

  constructor(private readonly file: string) {}

  async read(): Promise<ProvidersConfig> {
    // 等待任何待处理的写操作完成
    if (this.writePromise) {
      await this.writePromise
    }

    let buf: Buffer
    try {
      buf = await fs.readFile(this.file)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return { ...EMPTY, providers: [] }
      throw err
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage unavailable')
    }
    let json: string
    let parsed: unknown
    try {
      json = safeStorage.decryptString(buf)
      parsed = JSON.parse(json)
    } catch (err) {
      // 解密失败 / JSON 损坏 → 视为不兼容，提示用户重新配置
      throw new Error('SCHEMA_INVALID: providers.enc is corrupted or unreadable')
    }
    if (isNewShape(parsed)) return parsed
    // 旧 schema：尝试迁移
    return migrate(parsed)
  }

  async write(config: ProvidersConfig): Promise<void> {
    // 验证输入
    const validated = validateInput(providersConfigSchema, config)

    // 额外验证：API 密钥非空（antigravity/codex/grok 协议豁免，靠本机登录态）
    for (const provider of validated.providers) {
      const isCli =
        provider.protocol === 'antigravity' ||
        provider.protocol === 'codex' ||
        provider.protocol === 'grok'
      if (!isCli) {
        if (!provider.apiKey || provider.apiKey.trim().length === 0) {
          throw new Error(`Provider ${provider.id} has empty API key`)
        }
      }
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS secure storage unavailable')
    }

    // 使用队列保证写操作顺序
    this.writePromise = (async () => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const encrypted = safeStorage.encryptString(JSON.stringify(validated))
      await fs.writeFile(this.file, encrypted)
    })()

    try {
      await this.writePromise
    } finally {
      this.writePromise = null
    }
  }
}