import { readJson, writeJsonAtomic } from './atomic'
import type { WriteAuditConfig, WriteAuditMode, CostAlertConfig } from '../../shared/types'

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

const DEFAULTS: AppSettings = {
  pricing: DEFAULT_PRICING,
  dailyWordGoal: 3000,
  pomodoroFocus: 25,
  pomodoroBreak: 5,
  writeAudit: DEFAULT_WRITE_AUDIT,
  costAlert: DEFAULT_COST_ALERT
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
      costAlert: { ...DEFAULT_COST_ALERT, ...(stored.costAlert ?? {}) }
    }
  }

  async update(
    patch: Partial<AppSettings> & {
      pricing?: Partial<PricingConfig>
      writeAudit?: Partial<WriteAuditConfig>
      costAlert?: Partial<CostAlertConfig>
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
        : current.costAlert
    }
    await writeJsonAtomic(this.settingsFile, next)
    return next
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
