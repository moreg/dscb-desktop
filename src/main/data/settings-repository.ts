import { readJson, writeJsonAtomic } from './atomic'

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
}

const DEFAULT_PRICING: PricingConfig = {
  inputRate: 1,
  outputRate: 3
}

const DEFAULTS: AppSettings = {
  pricing: DEFAULT_PRICING,
  dailyWordGoal: 3000,
  pomodoroFocus: 25,
  pomodoroBreak: 5
}

export class SettingsRepository {
  constructor(private readonly settingsFile: string) {}

  async get(): Promise<AppSettings> {
    const stored = await readJson<AppSettings>(this.settingsFile, {})
    // 合并默认值（pricing 部分字段也要兜底）
    return {
      ...DEFAULTS,
      ...stored,
      pricing: { ...DEFAULT_PRICING, ...(stored.pricing ?? {}) }
    }
  }

  async update(patch: Partial<AppSettings> & { pricing?: Partial<PricingConfig> }): Promise<AppSettings> {
    const current = await this.get()
    const next: AppSettings = {
      ...current,
      ...patch,
      pricing: patch.pricing
        ? { ...current.pricing, ...patch.pricing }
        : current.pricing
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
}
