import { readJson, writeJsonAtomic } from './atomic'
import type {
  WriteAuditConfig,
  WriteAuditMode,
  CostAlertConfig,
  AiHighFreqConfig,
  AiHighFreqWord
} from '../../shared/types'
import type { WritingRequirementTemplate } from '../../shared/writing-requirement-templates'
import {
  DEFAULT_WRITING_REQUIREMENT_TEMPLATES,
  cloneWritingRequirementTemplates,
  normalizeWritingRequirementLines
} from '../../shared/writing-requirement-templates'
import { CHAPTER_RULE_SECTIONS } from './skill-prompts'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface PricingConfig {
  /** 输入 token 价格（元 / 百万 token） */
  inputRate: number
  /** 输出 token 价格（元 / 百万 token） */
  outputRate: number
}

export interface AppSettings {
  projectsRoot?: string
  theme?: ThemeMode
  pricing?: Partial<PricingConfig>
  /** 每日写作字数目标 */
  dailyWordGoal?: number
  /** 番茄钟工作分钟数 */
  pomodoroFocus?: number
  /** 番茄钟休息分钟数 */
  pomodoroBreak?: number
  /** 续写质检（PR2） */
  writeAudit?: Partial<WriteAuditConfig>
  /** P13-C：用量预警配置 */
  costAlert?: Partial<CostAlertConfig>
  /** AI 高频词配置 */
  aiHighFreq?: Partial<AiHighFreqConfig>
  /** 长期写作要求模板 */
  writingRequirementTemplates?: WritingRequirementTemplate[]
  /** 续写规则分节覆盖：key→正文。缺 key = 用内置默认；空串 = 停用该节 */
  chapterRuleOverrides?: Record<string, string>
}

const DEFAULT_PRICING: PricingConfig = {
  inputRate: 1,
  outputRate: 3
}

const DEFAULT_WRITE_AUDIT: WriteAuditConfig = {
  enabled: true,
  mode: 'soft'
}

/** P13-C + P14-C：用量预警默认值。warning=10 元，exceeded=30 元。blockOnExceeded 默认 false（opt-in） */
const DEFAULT_COST_ALERT: CostAlertConfig = {
  enabled: true,
  warning: 10,
  exceeded: 30,
  blockOnExceeded: false
}

/** 默认 AI 高频词配置 */
const DEFAULT_AI_HIGH_FREQ: AiHighFreqConfig = {
  enabled: true,
  words: []
}

const DEFAULTS: AppSettings = {
  pricing: DEFAULT_PRICING,
  dailyWordGoal: 3000,
  pomodoroFocus: 25,
  pomodoroBreak: 5,
  writeAudit: DEFAULT_WRITE_AUDIT,
  costAlert: DEFAULT_COST_ALERT,
  aiHighFreq: DEFAULT_AI_HIGH_FREQ
}

/** 续写规则覆盖白名单：只保留注册表内的 key、字符串值（空串=停用该节，保留） */
const CHAPTER_RULE_KEYS: Set<string> = new Set(CHAPTER_RULE_SECTIONS.map((s) => s.key))
function sanitizeChapterRuleOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (CHAPTER_RULE_KEYS.has(k) && typeof v === 'string') out[k] = v
  }
  return out
}

function sanitizeWritingRequirementTemplates(
  templates: unknown
): WritingRequirementTemplate[] {
  if (!Array.isArray(templates)) {
    return cloneWritingRequirementTemplates(DEFAULT_WRITING_REQUIREMENT_TEMPLATES)
  }

  const out: WritingRequirementTemplate[] = []
  const seen = new Set<string>()

  for (const item of templates) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<WritingRequirementTemplate>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      requirements: normalizeWritingRequirementLines(
        Array.isArray(raw.requirements) ? raw.requirements.join('\n') : ''
      )
    })
  }

  return out.length > 0
    ? out
    : cloneWritingRequirementTemplates(DEFAULT_WRITING_REQUIREMENT_TEMPLATES)
}

export class SettingsRepository {
  constructor(private readonly settingsFile: string) {}

  async get(): Promise<AppSettings> {
    const stored = await readJson<AppSettings>(this.settingsFile, {})
    // 合并默认值（嵌套字段也要兜底）
    return {
      ...DEFAULTS,
      ...stored,
      pricing: { ...DEFAULT_PRICING, ...(stored.pricing ?? {}) },
      writeAudit: { ...DEFAULT_WRITE_AUDIT, ...(stored.writeAudit ?? {}) },
      costAlert: { ...DEFAULT_COST_ALERT, ...(stored.costAlert ?? {}) },
      aiHighFreq: {
        enabled: DEFAULT_AI_HIGH_FREQ.enabled,
        words: Array.isArray(stored.aiHighFreq?.words) ? stored.aiHighFreq!.words! : []
      },
      writingRequirementTemplates: sanitizeWritingRequirementTemplates(
        stored.writingRequirementTemplates
      ),
      chapterRuleOverrides: sanitizeChapterRuleOverrides(stored.chapterRuleOverrides)
    }
  }

  async update(
    patch: Partial<AppSettings> & {
      pricing?: Partial<PricingConfig>
      writeAudit?: Partial<WriteAuditConfig>
      costAlert?: Partial<CostAlertConfig>
      aiHighFreq?: Partial<AiHighFreqConfig>
    }
  ): Promise<AppSettings> {
    const current = await this.get()
    const next: AppSettings = {
      ...current,
      ...patch,
      pricing: patch.pricing
        ? { ...current.pricing, ...patch.pricing }
        : current.pricing,
      writeAudit: patch.writeAudit
        ? { ...current.writeAudit, ...patch.writeAudit }
        : current.writeAudit,
      costAlert: patch.costAlert
        ? { ...current.costAlert, ...patch.costAlert }
        : current.costAlert,
      aiHighFreq: patch.aiHighFreq
        ? { ...current.aiHighFreq, ...patch.aiHighFreq }
        : current.aiHighFreq,
      writingRequirementTemplates:
        patch.writingRequirementTemplates !== undefined
          ? sanitizeWritingRequirementTemplates(patch.writingRequirementTemplates)
          : current.writingRequirementTemplates,
      chapterRuleOverrides:
        patch.chapterRuleOverrides !== undefined
          ? sanitizeChapterRuleOverrides(patch.chapterRuleOverrides)
          : current.chapterRuleOverrides
    }
    await writeJsonAtomic(this.settingsFile, next)
    return next
  }

  async getWritingRequirementTemplates(): Promise<WritingRequirementTemplate[]> {
    const s = await this.get()
    return cloneWritingRequirementTemplates(
      s.writingRequirementTemplates ?? DEFAULT_WRITING_REQUIREMENT_TEMPLATES
    )
  }

  async setWritingRequirementTemplates(
    templates: WritingRequirementTemplate[]
  ): Promise<WritingRequirementTemplate[]> {
    const sanitized = sanitizeWritingRequirementTemplates(templates)
    await this.update({ writingRequirementTemplates: sanitized })
    return this.getWritingRequirementTemplates()
  }

  /** 取续写规则覆盖（清洗后；缺省为空对象，表示全用内置默认） */
  async getChapterRuleOverrides(): Promise<Record<string, string>> {
    const s = await this.get()
    return { ...sanitizeChapterRuleOverrides(s.chapterRuleOverrides) }
  }

  /** 整体替换续写规则覆盖（清洗：仅保留白名单 key） */
  async setChapterRuleOverrides(
    overrides: Record<string, string>
  ): Promise<Record<string, string>> {
    const sanitized = sanitizeChapterRuleOverrides(overrides)
    await this.update({ chapterRuleOverrides: sanitized })
    return this.getChapterRuleOverrides()
  }

  /** 获取 AI 高频词配置 */
  async getAiHighFreq(): Promise<AiHighFreqConfig> {
    const s = await this.get()
    return {
      enabled: s.aiHighFreq?.enabled ?? DEFAULT_AI_HIGH_FREQ.enabled,
      words: Array.isArray(s.aiHighFreq?.words) ? s.aiHighFreq!.words! : []
    }
  }

  /** 更新 AI 高频词配置（过滤非法词条） */
  async setAiHighFreq(patch: Partial<AiHighFreqConfig>): Promise<AiHighFreqConfig> {
    const sanitized: Partial<AiHighFreqConfig> = {}
    if (typeof patch.enabled === 'boolean') sanitized.enabled = patch.enabled
    if (Array.isArray(patch.words)) {
      sanitized.words = patch.words
        .filter(
          (w): w is AiHighFreqWord =>
            !!w && typeof w.word === 'string' && w.word.trim().length > 0
        )
        .map((w) => ({
          word: w.word.trim(),
          ...(typeof w.example === 'string' && w.example.trim().length > 0
            ? { example: w.example.trim() }
            : {})
        }))
    }
    await this.update({ aiHighFreq: sanitized })
    return this.getAiHighFreq()
  }

  async getProjectsRoot(fallback: string): Promise<string> {
    const settings = await this.get()
    return settings.projectsRoot ?? fallback
  }

  async getTheme(): Promise<ThemeMode> {
    const settings = await this.get()
    return settings.theme ?? 'system'
  }

  async setTheme(theme: ThemeMode): Promise<ThemeMode> {
    await this.update({ theme })
    return theme
  }

  async getPricing(): Promise<PricingConfig> {
    const s = await this.get()
    return { ...DEFAULT_PRICING, ...(s.pricing ?? {}) }
  }

  async getWriteAudit(): Promise<WriteAuditConfig> {
    const s = await this.get()
    return { ...DEFAULT_WRITE_AUDIT, ...(s.writeAudit ?? {}) }
  }

  async setWriteAudit(patch: Partial<WriteAuditConfig>): Promise<WriteAuditConfig> {
    const sanitized: Partial<WriteAuditConfig> = {}
    if (typeof patch.enabled === 'boolean') sanitized.enabled = patch.enabled
    if (patch.mode === 'soft' || patch.mode === 'strict') {
      sanitized.mode = patch.mode as WriteAuditMode
    }
    await this.update({ writeAudit: sanitized })
    return this.getWriteAudit()
  }

  /**
   * P13-C：读取用量预警配置。
   * 非法值兜底：warning < 0 / warning >= exceeded → 强制恢复默认值。
   */
  async getCostAlert(): Promise<CostAlertConfig> {
    const s = await this.get()
    const merged = { ...DEFAULT_COST_ALERT, ...(s.costAlert ?? {}) }
    // 校验：warning 必须 < exceeded 且 ≥ 0
    if (merged.warning < 0 || merged.warning >= merged.exceeded) {
      return DEFAULT_COST_ALERT
    }
    return merged
  }

  /**
   * P13-C + P14-C：更新用量预警配置。
   * 校验：warning 必须 < exceeded 且 ≥ 0，exceeded 必须 > 0；非法值会被静默丢弃。
   */
  async setCostAlert(patch: Partial<CostAlertConfig>): Promise<CostAlertConfig> {
    const sanitized: Partial<CostAlertConfig> = {}
    if (typeof patch.enabled === 'boolean') sanitized.enabled = patch.enabled
    if (typeof patch.warning === 'number' && Number.isFinite(patch.warning) && patch.warning >= 0) {
      sanitized.warning = patch.warning
    }
    if (typeof patch.exceeded === 'number' && Number.isFinite(patch.exceeded) && patch.exceeded > 0) {
      sanitized.exceeded = patch.exceeded
    }
    if (typeof patch.blockOnExceeded === 'boolean') {
      sanitized.blockOnExceeded = patch.blockOnExceeded
    }
    await this.update({ costAlert: sanitized })
    return this.getCostAlert()
  }
}
