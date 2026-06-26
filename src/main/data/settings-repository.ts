import { readJson, writeJsonAtomic } from './atomic'
import type {
  WriteAuditConfig,
  WriteAuditMode,
  CostAlertConfig,
  AiHighFreqConfig,
  AiHighFreqWord,
  ReviewCheckId,
  ReviewRulesConfig,
  ReviewThresholds,
  ReviewWordLists
} from '../../shared/types'
import type { WritingRequirementTemplate } from '../../shared/writing-requirement-templates'
import {
  DEFAULT_WRITING_REQUIREMENT_TEMPLATES,
  cloneWritingRequirementTemplates,
  normalizeWritingRequirementLines
} from '../../shared/writing-requirement-templates'
import {
  CHAPTER_RULE_SECTIONS,
  REVIEW_CHECK_KEYS,
  DEFAULT_REVIEW_RULES,
  DEFAULT_REVIEW_THRESHOLDS,
  DEFAULT_REVIEW_WORD_LISTS
} from './skill-prompts'

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
  /** 审稿规则配置（按「正文审核」技能） */
  reviewRules?: Partial<ReviewRulesConfig>
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
  aiHighFreq: DEFAULT_AI_HIGH_FREQ,
  reviewRules: DEFAULT_REVIEW_RULES
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

/**
 * 阈值裁剪范围（防止用户填入导致引擎异常的值）。
 * minWords/maxWords/maxParagraphLen/maxSentenceLen/repetitionLen ≥ 1；
 * dashDensityPer100 允许小数，但 ≥ 0。
 */
function clampThresholds(raw: Partial<ReviewThresholds> | undefined): ReviewThresholds {
  const d = DEFAULT_REVIEW_THRESHOLDS
  const pick = (key: keyof ReviewThresholds, min: number): number => {
    const v = raw?.[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : d[key]
  }
  return {
    minWords: pick('minWords', 1),
    maxWords: pick('maxWords', 1),
    maxParagraphLen: pick('maxParagraphLen', 1),
    repetitionLen: pick('repetitionLen', 1),
    maxSentenceLen: pick('maxSentenceLen', 1),
    dashDensityPer100:
      typeof raw?.dashDensityPer100 === 'number' &&
      Number.isFinite(raw.dashDensityPer100) &&
      raw.dashDensityPer100 >= 0
        ? raw.dashDensityPer100
        : d.dashDensityPer100
  }
}

/** 过滤词表：去空白、去重，保留非空字符串。 */
function sanitizeWordList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of raw) {
    if (typeof w !== 'string') continue
    const t = w.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * 审稿规则清洗：
 * - checks：只保留白名单 checkId 的布尔值；
 * - thresholds：范围裁剪 + 缺省补默认；
 * - wordLists：过滤空串 + 去重；缺省补默认；
 * - enabled/autoDeepReview：缺省补默认。
 * 永远返回完整对象（不返回 Partial），保证下游引擎可直接用。
 */
function sanitizeReviewRules(raw: unknown): ReviewRulesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewRulesConfig>
  const checks: Partial<Record<ReviewCheckId, boolean>> = {}
  if (r.checks && typeof r.checks === 'object') {
    for (const [k, v] of Object.entries(r.checks)) {
      if (REVIEW_CHECK_KEYS.has(k as ReviewCheckId) && typeof v === 'boolean') {
        checks[k as ReviewCheckId] = v
      }
    }
  }
  const thresholds = clampThresholds(r.thresholds)
  const wordLists: ReviewWordLists = {
    metaBreak: sanitizeWordList(r.wordLists?.metaBreak).length
      ? sanitizeWordList(r.wordLists?.metaBreak)
      : [...DEFAULT_REVIEW_WORD_LISTS.metaBreak],
    sensitive: sanitizeWordList(r.wordLists?.sensitive).length
      ? sanitizeWordList(r.wordLists?.sensitive)
      : [...DEFAULT_REVIEW_WORD_LISTS.sensitive]
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_REVIEW_RULES.enabled,
    autoDeepReview:
      typeof r.autoDeepReview === 'boolean'
        ? r.autoDeepReview
        : DEFAULT_REVIEW_RULES.autoDeepReview,
    checks,
    thresholds,
    wordLists
  }
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
      chapterRuleOverrides: sanitizeChapterRuleOverrides(stored.chapterRuleOverrides),
      reviewRules: sanitizeReviewRules(stored.reviewRules)
    }
  }

  async update(
    patch: Partial<AppSettings> & {
      pricing?: Partial<PricingConfig>
      writeAudit?: Partial<WriteAuditConfig>
      costAlert?: Partial<CostAlertConfig>
      aiHighFreq?: Partial<AiHighFreqConfig>
      reviewRules?: Partial<ReviewRulesConfig>
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
          : current.chapterRuleOverrides,
      reviewRules:
        patch.reviewRules !== undefined ? sanitizeReviewRules(patch.reviewRules) : current.reviewRules
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

  /** 取审稿规则配置（清洗后；永远返回完整对象） */
  async getReviewRules(): Promise<ReviewRulesConfig> {
    const s = await this.get()
    return sanitizeReviewRules(s.reviewRules)
  }

  /** 增量更新审稿规则（patch 合并到当前值，整体清洗后落盘） */
  async setReviewRules(patch: Partial<ReviewRulesConfig>): Promise<ReviewRulesConfig> {
    const current = await this.getReviewRules()
    // checks：合并而非覆盖（用户改一项不应清空其他项）
    const mergedChecks: Partial<Record<ReviewCheckId, boolean>> = { ...current.checks }
    if (patch.checks) {
      for (const [k, v] of Object.entries(patch.checks)) {
        if (REVIEW_CHECK_KEYS.has(k as ReviewCheckId) && typeof v === 'boolean') {
          mergedChecks[k as ReviewCheckId] = v
        }
      }
    }
    const merged: Partial<ReviewRulesConfig> = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      autoDeepReview:
        typeof patch.autoDeepReview === 'boolean' ? patch.autoDeepReview : current.autoDeepReview,
      checks: mergedChecks,
      thresholds: patch.thresholds ? { ...current.thresholds, ...patch.thresholds } : current.thresholds,
      wordLists: patch.wordLists ? { ...current.wordLists, ...patch.wordLists } : current.wordLists
    }
    await this.update({ reviewRules: merged })
    return this.getReviewRules()
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
