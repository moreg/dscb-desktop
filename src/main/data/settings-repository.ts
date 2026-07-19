import { readJson, writeJsonAtomic } from './atomic'
import type {
  WriteAuditConfig,
  WriteAuditMode,
  CostAlertConfig,
  AiHighFreqConfig,
  AiHighFreqWord,
  AuditCategory,
  BuiltinCheckMeta,
  CustomReviewCheck,
  ReviewCheckId,
  ReviewRulesConfig,
  ReviewThresholds,
  ReviewWordLists,
  CoverImageConfigInput,
  CoverImageConfigSummary,
  DeslopRulesConfig
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
import {
  DESLOP_RULE_SECTIONS,
  DEFAULT_DESLOP_BANNED_WORDS
} from './skill-prompts/deslop/deslop-rules'

/** 比较两个禁用词表是否元素相同（忽略顺序与重复） */
function bannedWordsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const w of sa) if (!sb.has(w)) return false
  return true
}

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
  /** 去 AI 味规则配置（系统铁律/Gate 方法覆盖 + 禁用词表，保存后真正生效） */
  deslopRules?: DeslopRulesConfig
  /** 图像生成 API 配置（封面生成用，独立于文本 LLM provider） */
  coverImage?: Partial<CoverImageConfigInput>
  /**
   * 设定随书进化：off 关闭；confirm_all 全部手动确认；auto_high 高置信自动应用（默认）
   */
  settingsEvolution?: 'off' | 'confirm_all' | 'auto_high'
  /**
   * 续写完成后自动同步记忆与设定（extract → applyMemory → applySettingsPatches）。
   * 默认 true；与 settingsEvolution 独立。
   * 派生自 autoPostWritePipeline !== 'off'；保留以兼容旧设置与 IPC。
   */
  autoMemorySync?: boolean
  /**
   * 续写成功后的自动后处理：
   * - off：不自动同步
   * - memory_only：仅记忆/设定同步（默认，省 token）
   * - full：记忆同步 + 细纲/节奏/图解（不再二次 extract 记忆）
   */
  autoPostWritePipeline?: 'off' | 'memory_only' | 'full'
}

export type AutoPostWritePipeline = 'off' | 'memory_only' | 'full'

export function normalizeAutoPostWritePipeline(
  raw: unknown,
  autoMemorySyncFallback?: boolean
): AutoPostWritePipeline {
  if (raw === 'off' || raw === 'memory_only' || raw === 'full') return raw
  // 兼容仅有 autoMemorySync 的旧配置
  if (autoMemorySyncFallback === false) return 'off'
  return 'memory_only'
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
  reviewRules: DEFAULT_REVIEW_RULES,
  settingsEvolution: 'auto_high',
  autoMemorySync: true,
  autoPostWritePipeline: 'memory_only'
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

/** 去 AI 味文本规则覆盖白名单：只保留注册表内的 key、字符串值 */
const DESLOP_RULE_KEYS: Set<string> = new Set(DESLOP_RULE_SECTIONS.map((s) => s.key))
function sanitizeDeslopTextOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (DESLOP_RULE_KEYS.has(k) && typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * 去 AI 味禁用词表清洗：去空白、去重、限长（单词 ≤30 字、总数 ≤500）。
 * 与内置默认（DEFAULT_DESLOP_BANNED_WORDS）元素等价时返回 undefined（prune，不污染配置、回落默认）。
 * 返回 undefined 表示「未配置」，让下游回落到内置默认。
 */
function sanitizeDeslopBannedWords(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of raw) {
    if (typeof w !== 'string') continue
    const t = w.trim().slice(0, 30)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 500) break
  }
  // prune：清洗后与内置默认等价则不存（仍随内置升级，与文本规则覆盖的 prune 语义一致）
  if (bannedWordsEqual(out, DEFAULT_DESLOP_BANNED_WORDS)) return undefined
  return out
}

/** 完整清洗 DeslopRulesConfig（textOverrides + bannedWords）；返回 undefined 表示全用默认 */
function sanitizeDeslopRules(raw: unknown): DeslopRulesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeslopRulesConfig>
  const out: DeslopRulesConfig = {}
  const textOverrides = sanitizeDeslopTextOverrides(r.textOverrides)
  if (Object.keys(textOverrides).length > 0) out.textOverrides = textOverrides
  const bannedWords = sanitizeDeslopBannedWords(r.bannedWords)
  if (bannedWords !== undefined) out.bannedWords = bannedWords
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
/** 合法的检查项分组（= AuditCategory 闭合联合的镜像）。
 * 自定义项 group 必须落在此集合内，否则降级为 toxic，保证 AuditViolation.category 合法。 */
const VALID_GROUPS: ReadonlySet<string> = new Set([
  'ending', 'forbidden_word', 'word_count', 'rule', 'toxic',
  'quote', 'quality', 'paragraph', 'dialogue', 'sensitive', 'llm_review'
])

function sanitizeCustomChecks(raw: unknown): CustomReviewCheck[] {
  if (!Array.isArray(raw)) return []
  const out: CustomReviewCheck[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<CustomReviewCheck>
    // id：必须 custom_ 前缀 + 合法字符，且唯一；不得与内置 checkId 冲突
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!/^custom_[a-z0-9_]+$/.test(id) || seen.has(id)) continue
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    const hint = typeof r.hint === 'string' ? r.hint.trim() : ''
    if (!label) continue
    const severity = r.severity === 'error' || r.severity === 'warn' || r.severity === 'info' ? r.severity : 'warn'
    const type = r.type === 'keyword' || r.type === 'regex' || r.type === 'llm' ? r.type : 'keyword'
    // group 必须是合法 AuditCategory；否则降级 toxic，保证 AuditViolation.category 合法
    const group: AuditCategory =
      typeof r.group === 'string' && VALID_GROUPS.has(r.group)
        ? (r.group as AuditCategory)
        : 'toxic'
    const check: CustomReviewCheck = {
      id, label, hint, severity, type, group, enabled: typeof r.enabled === 'boolean' ? r.enabled : true
    }
    // 类型相关配置校验
    if (type === 'keyword') {
      const kw = sanitizeWordList(r.keywords)
      if (kw.length === 0) continue // 关键词项无词表 = 无意义，丢弃
      check.keywords = kw.slice(0, 500)
    } else if (type === 'regex') {
      const pat = typeof r.pattern === 'string' ? r.pattern.trim() : ''
      if (!pat) continue
      try {
        new RegExp(pat) // 非法正则抛错 → 丢弃
      } catch {
        continue
      }
      check.pattern = pat.slice(0, 500)
    } else {
      // llm
      const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : ''
      if (!prompt) continue
      check.prompt = prompt.slice(0, 2000)
    }
    seen.add(id)
    out.push(check)
    if (out.length >= 50) break // 上限 50 条
  }
  return out
}

function sanitizeBuiltinMeta(raw: unknown): Partial<Record<ReviewCheckId, BuiltinCheckMeta>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<ReviewCheckId, BuiltinCheckMeta>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!REVIEW_CHECK_KEYS.has(k as ReviewCheckId)) continue
    if (!v || typeof v !== 'object') continue
    const r = v as Partial<BuiltinCheckMeta>
    const meta: BuiltinCheckMeta = {}
    if (typeof r.label === 'string' && r.label.trim()) meta.label = r.label.trim().slice(0, 100)
    if (typeof r.hint === 'string') meta.hint = r.hint.trim().slice(0, 300)
    if (r.severity === 'error' || r.severity === 'warn' || r.severity === 'info') meta.severity = r.severity
    out[k as ReviewCheckId] = meta
  }
  return out
}

function sanitizeHiddenBuiltin(raw: unknown): ReviewCheckId[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewCheckId[] = []
  const seen = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string') continue
    if (!REVIEW_CHECK_KEYS.has(id as ReviewCheckId)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id as ReviewCheckId)
  }
  return out
}

function sanitizeReviewRules(raw: unknown): ReviewRulesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewRulesConfig>
  // 先清洗自定义项（checks 白名单要含 custom id）
  const customChecks = sanitizeCustomChecks(r.customChecks)
  const customIds = new Set(customChecks.map((c) => c.id))
  const allCheckKeys = new Set<string>([...REVIEW_CHECK_KEYS, ...customIds])
  const checks: Partial<Record<string, boolean>> = {}
  if (r.checks && typeof r.checks === 'object') {
    for (const [k, v] of Object.entries(r.checks)) {
      if (allCheckKeys.has(k) && typeof v === 'boolean') {
        checks[k] = v
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
    wordLists,
    builtinMeta: sanitizeBuiltinMeta(r.builtinMeta),
    hiddenBuiltin: sanitizeHiddenBuiltin(r.hiddenBuiltin),
    customChecks
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

  getSettingsFile(): string {
    return this.settingsFile
  }

  async get(): Promise<AppSettings> {
    const stored = await readJson<AppSettings>(this.settingsFile, {})
    // 合并默认值（嵌套字段也要兜底）
    const se = stored.settingsEvolution
    const settingsEvolution =
      se === 'off' || se === 'confirm_all' || se === 'auto_high' ? se : DEFAULTS.settingsEvolution
    const autoPostWritePipeline = normalizeAutoPostWritePipeline(
      stored.autoPostWritePipeline,
      typeof stored.autoMemorySync === 'boolean' ? stored.autoMemorySync : undefined
    )
    // 与 pipeline 保持一致，供旧 IPC/调用方读取
    const autoMemorySync = autoPostWritePipeline !== 'off'
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
      reviewRules: sanitizeReviewRules(stored.reviewRules),
      deslopRules: sanitizeDeslopRules(stored.deslopRules),
      settingsEvolution,
      autoPostWritePipeline,
      autoMemorySync
    }
  }

  async update(
    patch: Partial<AppSettings> & {
      pricing?: Partial<PricingConfig>
      writeAudit?: Partial<WriteAuditConfig>
      costAlert?: Partial<CostAlertConfig>
      aiHighFreq?: Partial<AiHighFreqConfig>
      reviewRules?: Partial<ReviewRulesConfig>
      deslopRules?: DeslopRulesConfig
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
        patch.reviewRules !== undefined ? sanitizeReviewRules(patch.reviewRules) : current.reviewRules,
      deslopRules:
        patch.deslopRules !== undefined ? sanitizeDeslopRules(patch.deslopRules) : current.deslopRules
    }

    // 保持 autoPostWritePipeline 与 autoMemorySync 双向一致
    if (patch.autoPostWritePipeline !== undefined) {
      const p = normalizeAutoPostWritePipeline(patch.autoPostWritePipeline)
      next.autoPostWritePipeline = p
      next.autoMemorySync = p !== 'off'
    } else if (patch.autoMemorySync !== undefined) {
      next.autoMemorySync = patch.autoMemorySync
      if (!patch.autoMemorySync) {
        next.autoPostWritePipeline = 'off'
      } else if (current.autoPostWritePipeline === 'off' || !current.autoPostWritePipeline) {
        next.autoPostWritePipeline = 'memory_only'
      } else {
        next.autoPostWritePipeline = current.autoPostWritePipeline
      }
    }

    await writeJsonAtomic(this.settingsFile, next)
    return this.get()
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
    const mergedChecks: Partial<Record<string, boolean>> = { ...current.checks }
    if (patch.checks) {
      for (const [k, v] of Object.entries(patch.checks)) {
        const allKeys = new Set<string>([
          ...REVIEW_CHECK_KEYS,
          ...(current.customChecks ?? []).map((c) => c.id)
        ])
        if (allKeys.has(k) && typeof v === 'boolean') {
          mergedChecks[k] = v
        }
      }
    }
    const merged: Partial<ReviewRulesConfig> = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      autoDeepReview:
        typeof patch.autoDeepReview === 'boolean' ? patch.autoDeepReview : current.autoDeepReview,
      checks: mergedChecks,
      thresholds: patch.thresholds ? { ...current.thresholds, ...patch.thresholds } : current.thresholds,
      wordLists: patch.wordLists ? { ...current.wordLists, ...patch.wordLists } : current.wordLists,
      // builtinMeta 浅合并（同 key 覆盖）
      builtinMeta: patch.builtinMeta
        ? { ...current.builtinMeta, ...patch.builtinMeta }
        : current.builtinMeta,
      // hiddenBuiltin / customChecks 整体替换（CRUD 语义清晰）
      hiddenBuiltin: patch.hiddenBuiltin !== undefined ? patch.hiddenBuiltin : current.hiddenBuiltin,
      customChecks: patch.customChecks !== undefined ? patch.customChecks : current.customChecks
    }
    await this.update({ reviewRules: merged })
    return this.getReviewRules()
  }

  /** 取去 AI 味规则配置（清洗后；缺省为空对象，表示全用内置默认） */
  async getDeslopRules(): Promise<DeslopRulesConfig> {
    const s = await this.get()
    return sanitizeDeslopRules(s.deslopRules)
  }

  /**
   * 整体替换去 AI 味规则（文本覆盖 + 禁用词表）。
   * 前端传入完整的 textOverrides（已 prune 与默认相同的 key）+ bannedWords。
   */
  async setDeslopRules(cfg: DeslopRulesConfig): Promise<DeslopRulesConfig> {
    const sanitized = sanitizeDeslopRules(cfg)
    await this.update({ deslopRules: sanitized })
    return this.getDeslopRules()
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

  /** 图像生成 API 配置（封面用）。apiKey 空串=未配置（保留旧值由 update 处理） */
  async getCoverImageConfig(): Promise<{
    apiKey: string
    baseUrl: string
    model: string
  }> {
    const s = await this.get()
    const cfg = s.coverImage ?? {}
    return {
      apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
      baseUrl: cfg.baseUrl || 'https://api.openai.com/v1',
      model: cfg.model || 'gpt-image-2'
    }
  }

  /** 脱敏摘要（list 返回，不含明文 apiKey） */
  async getCoverImageConfigSummary(): Promise<CoverImageConfigSummary> {
    const cfg = await this.getCoverImageConfig()
    return {
      hasKey: cfg.apiKey.length > 0,
      keyMasked: cfg.apiKey ? maskKey(cfg.apiKey) : '',
      baseUrl: cfg.baseUrl,
      model: cfg.model
    }
  }

  /** 更新图像配置；apiKey 为空串时保留旧值（不覆盖） */
  async setCoverImageConfig(patch: Partial<CoverImageConfigInput>): Promise<CoverImageConfigSummary> {
    const current = await this.getCoverImageConfig()
    // baseUrl 校验：必须是 http/https 协议的合法 URL（防 SSRF）
    let baseUrl = current.baseUrl
    if (patch.baseUrl !== undefined) {
      const trimmed = patch.baseUrl.trim()
      if (trimmed) {
        try {
          const u = new URL(trimmed)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            throw new Error('仅支持 http/https 协议')
          }
          baseUrl = trimmed
        } catch (err) {
          throw new Error(`图像 API baseUrl 非法：${(err as Error).message}`)
        }
      }
    }
    const next: Partial<CoverImageConfigInput> = {
      baseUrl,
      model: patch.model?.trim() || current.model,
      // apiKey 空串=保留旧值；非空才覆盖
      apiKey: patch.apiKey && patch.apiKey.trim() ? patch.apiKey.trim() : current.apiKey
    }
    await this.update({ coverImage: next })
    return this.getCoverImageConfigSummary()
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

/** apiKey 脱敏：只保留首尾 4 字符，中间用 · 替换 */
function maskKey(key: string): string {
  if (key.length <= 8) return '····'
  return `${key.slice(0, 4)}··${key.slice(-4)}`
}
