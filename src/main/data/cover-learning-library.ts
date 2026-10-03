import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import type {
  CoverGenre,
  CoverLearningIssue,
  CoverLearningLibrarySummary,
  CoverLearningOptions,
  CoverLearningRuleSummary,
  CoverLearningRunResult,
  CoverLearningTaskState,
  CoverStylePreset
} from '../../shared/types'
import { writeJsonAtomic } from './atomic'
import type { SettingsRepository } from './settings-repository'
import type { LlmService } from './llm-service'
import {
  COVER_STYLE_PRESETS,
  migrateBuiltinCoverStyle,
  type CoverStyleDefinition
} from './skill-prompts/cover/cover-styles'
import { LEGACY_COVER_FINGERPRINT_PREFIXES } from './cover-legacy-fingerprints'
import { analyzeCover, coverRejectionReason, type CoverVisualMetrics } from './cover-learning-analysis'

export const COVER_LEARNING_LIBRARY_FILE = 'cover-learning-library.json'

type ConcreteStylePreset = Exclude<CoverStylePreset, 'auto'>

interface LearnedCoverSample {
  fingerprint: string
  relativePath: string
  sourceDirectory: string
  learnedAt: string
  metrics: CoverVisualMetrics
  genre?: CoverGenre
  legacy?: boolean
}

type StoredLearningRun = Omit<CoverLearningRunResult, 'summary'>

interface LearningFeedback {
  id: string
  genre: CoverGenre
  status: 'adopted' | 'rejected' | 'unrated'
  reason: string
  libraryVersion: string
  rules: string[]
  updatedAt: string
}

interface CoverLearningState {
  /** 旧版学习结果只有总数、没有单图指纹，单独保留，避免错误宣称可以追溯。 */
  legacyUntrackedSampleCount: number
  /** 已学过但没有逐图视觉指标的旧样本内容指纹。 */
  knownFingerprints: string[]
  samples: LearnedCoverSample[]
  runs: StoredLearningRun[]
  totalRunCount: number
  observedRules: string[]
  generatedRules: CoverLearningRuleSummary[]
  ruleOverrides: Record<string, boolean>
  ruleHistory: Array<{ updatedAt: string; rules: CoverLearningRuleSummary[] }>
  feedback: LearningFeedback[]
  lastTask?: Omit<CoverLearningTaskState, 'result'>
}

export interface CoverLearningLibrary {
  version: 1
  name: string
  updatedAt: string
  source: {
    platform: string
    sampleCount: number
    categoryCount: number
    note: string
  }
  globalRules: string[]
  genreRecommendations: Record<CoverGenre, ConcreteStylePreset>
  styles: Record<ConcreteStylePreset, CoverStyleDefinition>
  learning: CoverLearningState
}

export interface LoadedCoverLearningLibrary {
  library: CoverLearningLibrary
  summary: CoverLearningLibrarySummary
}

const GENRE_RECOMMENDATIONS: Record<CoverGenre, ConcreteStylePreset> = {
  xianxia: 'epic_fantasy',
  urban: 'urban_cinematic',
  ancient_romance: 'ancient_romance',
  modern_romance: 'glamour_romance',
  mystery: 'dark_suspense',
  scifi: 'game_neon',
  western_fantasy: 'western_adventure',
  historical: 'war_spy_epic',
  supernatural: 'folk_horror',
  light_novel: 'anime_light'
}

/** 仅精确匹配旧内置规则；作者改过的英文原文不参与迁移。顺序也用于保持旧规则 ID。 */
const LEGACY_BUILTIN_RULES = [
  'Use a portrait 3:4 master canvas and keep essential text inside the central 85% safe area.',
  'Design for mobile thumbnail recognition with one dominant focal point and a clear silhouette.',
  'Make the Chinese title the primary visual layer, normally occupying 20 to 35 percent of the cover.',
  'For long titles, group the exact text into 2 to 4 semantic lines instead of shrinking it.',
  'Render the exact Simplified Chinese title and author name once only; do not invent extra text or logos.',
  'Keep faces and signature props clear of the title; preserve strong foreground-background contrast.'
] as const

export const DEFAULT_COVER_LEARNING_LIBRARY: CoverLearningLibrary = {
  version: 1,
  name: '番茄小说封面学习库',
  updatedAt: '2026-07-31',
  source: {
    platform: '番茄小说公开榜单',
    sampleCount: 138,
    categoryCount: 23,
    note: '提炼构图、色彩、字体层级和媒介质感等共性，不复刻具体作品。'
  },
  globalRules: [
    '封面成品采用竖版 3:4 比例，关键文字遵守当前画布的裁剪安全区。',
    '为手机缩略图设计一个明确的视觉焦点，保持主体轮廓清晰。',
    '中文书名是最主要的文字层级，通常占封面面积的 20% 至 35%。',
    '长书名按语义分组，并遵守选定的横排或竖排方向，避免一味缩小字号。',
    '准确呈现简体中文书名与作者署名，各出现一次，不增加其他文字或标志。',
    '书名避开人物面部与标志性道具，保持前景和背景的清晰对比。'
  ],
  genreRecommendations: GENRE_RECOMMENDATIONS,
  styles: COVER_STYLE_PRESETS,
  learning: {
    legacyUntrackedSampleCount: 138,
    knownFingerprints: [],
    samples: [],
    runs: [],
    totalRunCount: 0,
    observedRules: [],
    generatedRules: [],
    ruleOverrides: {},
    ruleHistory: [],
    feedback: []
  }
}

const BUILTIN_RULE_TRANSLATIONS = new Map(LEGACY_BUILTIN_RULES.map((text, index) => [text as string, DEFAULT_COVER_LEARNING_LIBRARY.globalRules[index]]))
const BUILTIN_RULE_IDENTITIES = new Map(DEFAULT_COVER_LEARNING_LIBRARY.globalRules.map((text, index) => [text, LEGACY_BUILTIN_RULES[index]]))

const STYLE_KEYS = Object.keys(COVER_STYLE_PRESETS) as ConcreteStylePreset[]
const GENRE_KEYS = Object.keys(GENRE_RECOMMENDATIONS) as CoverGenre[]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStyleDefinition(value: unknown): value is CoverStyleDefinition {
  if (!isObject(value)) return false
  return ['label', 'description', 'prompt', 'colorPalette', 'lighting', 'titleFont', 'authorFont']
    .every((key) => typeof value[key] === 'string' && (value[key] as string).trim().length > 0)
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function validateMetrics(raw: unknown): CoverVisualMetrics | null {
  if (!isObject(raw) || !Array.isArray(raw.averageRgb) || !Array.isArray(raw.detailByBand)) return null
  if (raw.averageRgb.length !== 3 || raw.detailByBand.length !== 3) return null
  if (!(finiteNumber(raw.width) > 0) || !(finiteNumber(raw.height) > 0) || !(finiteNumber(raw.aspectRatio) > 0)) return null
  if (!raw.averageRgb.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255)) return null
  if (!raw.detailByBand.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return null
  return {
    width: finiteNumber(raw.width),
    height: finiteNumber(raw.height),
    aspectRatio: finiteNumber(raw.aspectRatio),
    averageRgb: raw.averageRgb.map((value) => finiteNumber(value)) as [number, number, number],
    luminance: finiteNumber(raw.luminance),
    saturation: finiteNumber(raw.saturation),
    contrast: finiteNumber(raw.contrast),
    warmth: finiteNumber(raw.warmth),
    detailByBand: raw.detailByBand.map((value) => finiteNumber(value)) as [number, number, number],
    dominantColor: typeof raw.dominantColor === 'string' ? raw.dominantColor : 'neutral',
    ...(Array.isArray(raw.colorFamilies) ? {
      colorFamilies: raw.colorFamilies.filter(isObject)
        .filter((entry) => typeof entry.color === 'string' && typeof entry.share === 'number' && entry.share > 0 && entry.share <= 1)
        .map((entry) => ({ color: entry.color as string, share: entry.share as number }))
    } : {}),
    perceptualHash: typeof raw.perceptualHash === 'string' ? raw.perceptualHash : '',
    visualFingerprint: typeof raw.visualFingerprint === 'string' ? raw.visualFingerprint : ''
  }
}

function validateLearning(raw: unknown, sourceSampleCount: number): CoverLearningState {
  if (!isObject(raw)) {
    return {
      legacyUntrackedSampleCount: sourceSampleCount,
      knownFingerprints: [],
      samples: [],
      runs: [],
      totalRunCount: 0,
      observedRules: [],
      generatedRules: [],
      ruleOverrides: {},
      ruleHistory: [],
      feedback: []
    }
  }
  const samples: LearnedCoverSample[] = []
  if (Array.isArray(raw.samples)) {
    for (const candidate of raw.samples) {
      if (!isObject(candidate) || typeof candidate.fingerprint !== 'string') continue
      const metrics = validateMetrics(candidate.metrics)
      if (!metrics || !/^[a-f0-9]{64}$/i.test(candidate.fingerprint)) continue
      samples.push({
        fingerprint: candidate.fingerprint.toLowerCase(),
        relativePath: typeof candidate.relativePath === 'string' ? candidate.relativePath : '',
        sourceDirectory: typeof candidate.sourceDirectory === 'string' ? candidate.sourceDirectory : '',
        learnedAt: typeof candidate.learnedAt === 'string' ? candidate.learnedAt : '',
        metrics,
        ...(typeof candidate.genre === 'string' && GENRE_KEYS.includes(candidate.genre as CoverGenre)
          ? { genre: candidate.genre as CoverGenre } : {}),
        ...(candidate.legacy === true ? { legacy: true } : {})
      })
    }
  }
  const runs: StoredLearningRun[] = Array.isArray(raw.runs)
    ? raw.runs.filter(isStoredLearningRun).slice(-100)
    : []
  const observedRules = Array.isArray(raw.observedRules)
    ? strings(raw.observedRules)
    : []
  return {
    legacyUntrackedSampleCount: Math.max(0, Math.floor(finiteNumber(raw.legacyUntrackedSampleCount, sourceSampleCount))),
    knownFingerprints: Array.isArray(raw.knownFingerprints)
      ? raw.knownFingerprints.filter((fingerprint): fingerprint is string =>
        typeof fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(fingerprint)).map((fingerprint) => fingerprint.toLowerCase())
      : [],
    samples,
    runs,
    totalRunCount: Math.max(runs.length, Math.floor(finiteNumber(raw.totalRunCount, runs.length))),
    observedRules,
    generatedRules: validateRules(raw.generatedRules).map((rule) => rule.source === 'statistics'
      ? { ...rule, text: localizeStatisticRule(rule.text) } : rule),
    ruleOverrides: isObject(raw.ruleOverrides)
      ? Object.fromEntries(Object.entries(raw.ruleOverrides).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
      : {},
    ruleHistory: Array.isArray(raw.ruleHistory) ? raw.ruleHistory.filter(isObject).slice(-10)
      .map((entry) => ({ updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '', rules: validateRules(entry.rules) })) : [],
    feedback: Array.isArray(raw.feedback) ? raw.feedback.filter(isObject)
      .filter((entry) => typeof entry.id === 'string' && GENRE_KEYS.includes(entry.genre as CoverGenre) && ['adopted', 'rejected', 'unrated'].includes(entry.status as string))
      .slice(-500).map((entry) => ({
        id: entry.id as string, genre: entry.genre as CoverGenre, status: entry.status as LearningFeedback['status'],
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        libraryVersion: typeof entry.libraryVersion === 'string' ? entry.libraryVersion : '',
        rules: strings(entry.rules), updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
      })) : [],
    ...(isObject(raw.lastTask) && typeof raw.lastTask.id === 'string' && typeof raw.lastTask.directory === 'string'
      ? { lastTask: raw.lastTask as unknown as Omit<CoverLearningTaskState, 'result'> } : {})
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
}

function validateRules(value: unknown): CoverLearningRuleSummary[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject)
    .filter((entry) => typeof entry.id === 'string' && typeof entry.text === 'string' && ['statistics', 'ai'].includes(entry.source as string))
    .map((entry) => ({
      id: entry.id as string, text: entry.text as string, source: entry.source as 'statistics' | 'ai',
      sampleCount: Math.max(0, Math.floor(finiteNumber(entry.sampleCount))), enabled: entry.enabled !== false,
      ...(GENRE_KEYS.includes(entry.genre as CoverGenre) ? { genre: entry.genre as CoverGenre } : {}),
      ...(Array.isArray(entry.evidence) ? { evidence: strings(entry.evidence) } : {})
    }))
}

function isStoredLearningRun(value: unknown): value is StoredLearningRun {
  return isObject(value) &&
    typeof value.directory === 'string' &&
    typeof value.scanned === 'number' &&
    typeof value.learned === 'number' &&
    typeof value.duplicates === 'number' &&
    typeof value.failed === 'number' &&
    typeof value.startedAt === 'string' &&
    typeof value.completedAt === 'string' &&
    Array.isArray(value.observations)
}

function validateLibrary(raw: unknown): CoverLearningLibrary {
  if (!isObject(raw) || raw.version !== 1) throw new Error('学习库 version 必须为 1')
  if (!isObject(raw.source) || !isObject(raw.styles) || !isObject(raw.genreRecommendations)) {
    throw new Error('学习库缺少 source、styles 或 genreRecommendations')
  }

  const styles = {} as Record<ConcreteStylePreset, CoverStyleDefinition>
  for (const key of STYLE_KEYS) {
    const candidate = raw.styles[key]
    styles[key] = isStyleDefinition(candidate) ? migrateBuiltinCoverStyle(key, candidate) : COVER_STYLE_PRESETS[key]
  }

  const genreRecommendations = {} as Record<CoverGenre, ConcreteStylePreset>
  for (const genre of GENRE_KEYS) {
    const candidate = raw.genreRecommendations[genre]
    genreRecommendations[genre] = typeof candidate === 'string' && STYLE_KEYS.includes(candidate as ConcreteStylePreset)
      ? candidate as ConcreteStylePreset
      : GENRE_RECOMMENDATIONS[genre]
  }

  const learning = validateLearning(raw.learning, finiteNumber(raw.source.sampleCount))
  // Only known mechanically generated legacy rules may be migrated automatically.
  // Unattributed old AI prose stays user-owned so migration never discards edits.
  const legacyRules = new Set(learning.observedRules)
  const globalRules = strings(raw.globalRules).filter((rule) => !legacyRules.has(rule))
    .map((rule) => BUILTIN_RULE_TRANSLATIONS.get(rule) ?? rule)

  const sourceSampleCount = Math.max(0, Math.floor(finiteNumber(raw.source.sampleCount)))
  const library: CoverLearningLibrary = {
    version: 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : DEFAULT_COVER_LEARNING_LIBRARY.name,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    source: {
      platform: typeof raw.source.platform === 'string' ? raw.source.platform : '',
      sampleCount: sourceSampleCount,
      categoryCount: typeof raw.source.categoryCount === 'number' ? raw.source.categoryCount : 0,
      note: typeof raw.source.note === 'string' ? raw.source.note : ''
    },
    globalRules,
    genreRecommendations,
    styles,
    learning
  }
  if (learning.observedRules.length && isObject(raw.learning) && !Array.isArray(raw.learning.generatedRules)) {
    const genres = new Set(learning.samples.map((sample) => sample.genre))
    for (const genre of genres) {
      const eligible = learning.samples.filter((sample) => sample.genre === genre && !coverRejectionReason(sample.metrics))
      learning.generatedRules.push(...buildStatisticRules(eligible, genre))
    }
  }
  return library
}

/**
 * 可迁移的本地封面学习库。每次 load 都从磁盘读取，因此用户手工更新 JSON 后，
 * 下一次提炼提示词或生成图片会立即生效，不需要重启应用。
 */
export class CoverLearningLibraryService {
  private learningTail: Promise<void> = Promise.resolve()
  private taskState: CoverLearningTaskState | null = null
  private abortController: AbortController | null = null

  constructor(
    private readonly settings: SettingsRepository,
    private readonly defaultDirectory: string,
    private readonly llm?: LlmService
  ) {}

  async initialize(): Promise<CoverLearningLibrarySummary> { return (await this.load()).summary }

  async load(): Promise<LoadedCoverLearningLibrary> {
    const directory = await this.settings.getCoverLearningLibraryDir(this.defaultDirectory)
    const filePath = join(directory, COVER_LEARNING_LIBRARY_FILE)
    try {
      await fs.mkdir(directory, { recursive: true })
      try { await fs.access(filePath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeJsonAtomic(filePath, DEFAULT_COVER_LEARNING_LIBRARY)
      }
      const library = validateLibrary(JSON.parse(await fs.readFile(filePath, 'utf-8')))
      if (!this.taskState && library.learning.lastTask) {
        this.taskState = structuredClone(library.learning.lastTask)
        if (!isTerminal(this.taskState.phase)) {
          this.taskState.phase = 'cancelled'
          this.taskState.error = '上次学习被中断，已保存的样本仍可使用；重新选择相同目录可继续。'
        }
      }
      const summary = this.summary(directory, filePath, library, 'ready')
      if (this.taskState && !this.taskState.result && isTerminal(this.taskState.phase)) {
        const run = [...library.learning.runs].reverse().find((entry) => entry.startedAt === this.taskState!.startedAt && entry.directory === this.taskState!.directory)
        if (run) this.taskState.result = { ...run, summary }
      }
      return { library, summary }
    } catch (error) {
      const library = structuredClone(DEFAULT_COVER_LEARNING_LIBRARY)
      return { library, summary: this.summary(directory, filePath, library, 'fallback', (error as Error).message) }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.learningTail.then(operation)
    this.learningTail = task.then(() => undefined, () => undefined)
    return task
  }

  setDirectory(directory: string): Promise<CoverLearningLibrarySummary> {
    return this.enqueue(async () => {
      const normalized = absoluteDirectory(directory, '学习库')
      const filePath = join(normalized, COVER_LEARNING_LIBRARY_FILE)
      await fs.mkdir(normalized, { recursive: true })
      let exists = true
      try {
        validateLibrary(JSON.parse(await fs.readFile(filePath, 'utf-8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`目标学习库无法使用，当前目录保持不变：${(error as Error).message}`, { cause: error })
        exists = false
      }
      const probe = join(normalized, `.cover-learning-write-check-${randomUUID()}`)
      await fs.writeFile(probe, '', { flag: 'wx' })
      await fs.unlink(probe)
      if (!exists) {
        const current = await this.requireReady()
        await writeJsonAtomic(filePath, current.library)
      }
      await this.settings.setCoverLearningLibraryDir(normalized)
      return (await this.load()).summary
    })
  }

  learnFolder(directory: string, options: CoverLearningOptions = {}): Promise<CoverLearningRunResult> {
    return this.enqueue(() => this.performLearnFolder(directory, options))
  }

  getTaskState(): CoverLearningTaskState | null {
    return this.taskState ? structuredClone(this.taskState) : null
  }

  cancelLearning(): { ok: boolean } {
    if (!this.taskState || isTerminal(this.taskState.phase) || this.taskState.phase === 'saving') return { ok: false }
    this.abortController?.abort()
    return { ok: true }
  }

  async rollbackLastLearningRules(): Promise<CoverLearningLibrarySummary> {
    return this.enqueue(async () => {
      const loaded = await this.requireReady()
      const previous = loaded.library.learning.ruleHistory.pop()
      if (!previous) throw new Error('没有可回退的学习规则版本')
      loaded.library.learning.generatedRules = previous.rules
      loaded.library.updatedAt = new Date().toISOString()
      await this.persist(loaded)
      return (await this.load()).summary
    })
  }

  setRuleEnabled(id: string, enabled: boolean): Promise<CoverLearningLibrarySummary> {
    return this.enqueue(async () => {
      const loaded = await this.requireReady()
      if (!this.rulePreview(loaded.library).some((rule) => rule.id === id)) throw new Error('找不到这条学习规则，请刷新后重试')
      loaded.library.learning.ruleOverrides[id] = enabled
      await this.persist(loaded)
      return (await this.load()).summary
    })
  }

  recordFeedback(input: Omit<LearningFeedback, 'updatedAt'>): Promise<void> {
    return this.enqueue(async () => {
      const loaded = await this.requireReady()
      const feedback = { ...input, rules: [...input.rules], updatedAt: new Date().toISOString() }
      loaded.library.learning.feedback = [...loaded.library.learning.feedback.filter((entry) => entry.id !== input.id), feedback].slice(-500)
      await this.persist(loaded)
    })
  }

  getRulesForGenre(library: CoverLearningLibrary, genre: CoverGenre): string[] {
    return [...new Set(this.rulePreview(library)
      .filter((rule) => rule.enabled && (!rule.genre || rule.genre === genre))
      .map((rule) => rule.text))]
  }

  private rulePreview(library: CoverLearningLibrary): CoverLearningRuleSummary[] {
    const defaults = new Set(DEFAULT_COVER_LEARNING_LIBRARY.globalRules)
    const base = library.globalRules.map((text): CoverLearningRuleSummary => {
      const source = defaults.has(text) ? 'builtin' : 'user'
      const identity = source === 'builtin' ? BUILTIN_RULE_IDENTITIES.get(text) ?? text : text
      const id = `${source}:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
      return { id, text, source, sampleCount: source === 'builtin' ? 138 : 0, enabled: library.learning.ruleOverrides[id] !== false }
    })
    const generated = library.learning.generatedRules.map((rule) => ({
      ...rule,
      enabled: rule.enabled && library.learning.ruleOverrides[rule.id] !== false && this.samplesForGroup(library, rule.genre).length >= MIN_RULE_SAMPLES
    }))
    return [...base, ...generated]
  }

  private samplesForGroup(library: CoverLearningLibrary, genre?: CoverGenre): LearnedCoverSample[] {
    return library.learning.samples.filter((sample) => sample.genre === genre && !coverRejectionReason(sample.metrics))
  }

  private async requireReady(): Promise<LoadedCoverLearningLibrary> {
    const loaded = await this.load()
    if (loaded.summary.status !== 'ready') throw new Error(`学习库当前无法写入：${loaded.summary.error ?? '文件格式异常'}`)
    return loaded
  }

  /** Keep manual prompt/style edits made while the scan was running. */
  private async persist(loaded: LoadedCoverLearningLibrary): Promise<void> {
    const library = loaded.library
    const current = validateLibrary(JSON.parse(await fs.readFile(loaded.summary.filePath, 'utf-8')))
    library.globalRules = current.globalRules
    library.name = current.name
    library.styles = current.styles
    library.genreRecommendations = current.genreRecommendations
    library.source.platform = current.source.platform
    library.source.note = current.source.note
    library.source.categoryCount = current.source.categoryCount
    const canonicalVisuals = new Map(library.learning.samples.filter((sample) => sample.metrics.visualFingerprint)
      .map((sample) => [sample.metrics.visualFingerprint, sample.fingerprint]))
    const samples = new Map(current.learning.samples
      .filter((sample) => !sample.metrics.visualFingerprint || !canonicalVisuals.has(sample.metrics.visualFingerprint) || canonicalVisuals.get(sample.metrics.visualFingerprint) === sample.fingerprint)
      .map((sample) => [sample.fingerprint, sample]))
    for (const sample of library.learning.samples) samples.set(sample.fingerprint, sample)
    library.learning.samples = [...samples.values()]
    library.learning.knownFingerprints = [...new Set([...current.learning.knownFingerprints, ...library.learning.knownFingerprints])]
    library.source.sampleCount = library.learning.legacyUntrackedSampleCount + library.learning.samples.length
    await writeJsonAtomic(loaded.summary.filePath, library)
  }

  private async performLearnFolder(directory: string, options: CoverLearningOptions): Promise<CoverLearningRunResult> {
    const normalized = absoluteDirectory(directory, '封面文件夹')
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('选择的封面文件夹不存在或无法读取')
    if (options.genre && !GENRE_KEYS.includes(options.genre)) throw new Error('封面题材无效')
    if (options.aiMode && !['off', 'summary', 'vision'].includes(options.aiMode)) throw new Error('AI 学习模式无效')
    const loaded = await this.requireReady()
    const controller = new AbortController()
    this.abortController = controller
    const startedAt = new Date().toISOString()
    this.taskState = {
      id: randomUUID(), phase: 'scanning', directory: normalized,
      scanned: 0, processed: 0, learned: 0, duplicates: 0, rejected: 0, failed: 0, startedAt
    }
    const task = this.taskState
    const issues: CoverLearningIssue[] = []
    try {
      loaded.library.learning.lastTask = { ...task }
      await this.persist(loaded)
      const files = await collectImageFiles(normalized, issues, controller.signal)
      task.scanned = files.length
      task.failed = issues.length
      task.phase = 'analyzing'
      const byFingerprint = new Map(loaded.library.learning.samples.map((sample) => [sample.fingerprint, sample]))
      const known = new Set([...loaded.library.learning.knownFingerprints, ...byFingerprint.keys()])
      const legacyPrefixes = new Set(LEGACY_COVER_FINGERPRINT_PREFIXES)
      const visualIndex = new Map(loaded.library.learning.samples.filter((sample) => sample.metrics.visualFingerprint)
        .map((sample) => [sample.metrics.visualFingerprint, sample]))
      let changed = false
      let backfilled = 0
      let movedToGenre = false
      for (const filePath of files) {
        if (controller.signal.aborted) break
        task.currentFile = relative(normalized, filePath).replace(/\\/g, '/')
        try {
          const buffer = await fs.readFile(filePath)
          const fingerprint = createHash('sha256').update(buffer).digest('hex')
          const existing = byFingerprint.get(fingerprint)
          if (existing) {
            task.duplicates++
            existing.sourceDirectory = normalized
            existing.relativePath = task.currentFile
            if (!existing.genre && options.genre) {
              existing.genre = options.genre
              changed = true
              movedToGenre = true
            }
          } else {
            const isLegacy = known.has(fingerprint) || (loaded.library.learning.legacyUntrackedSampleCount > 0 && legacyPrefixes.has(fingerprint.slice(0, 24)))
            const metrics = await analyzeCover(filePath)
            const rejection = coverRejectionReason(metrics)
            if (rejection) {
              task.rejected++
              issues.push({ path: task.currentFile, reason: rejection, kind: 'rejected' })
            } else if (visualIndex.has(metrics.visualFingerprint)) {
              task.duplicates++
              const visual = visualIndex.get(metrics.visualFingerprint)!
              // Keep a readable source after moving a folder or choosing a resized encoding.
              const previousFingerprint = visual.fingerprint
              visual.sourceDirectory = normalized
              visual.relativePath = task.currentFile
              visual.fingerprint = fingerprint
              visual.metrics = metrics
              byFingerprint.delete(previousFingerprint)
              byFingerprint.set(fingerprint, visual)
              if (!loaded.library.learning.knownFingerprints.includes(previousFingerprint)) loaded.library.learning.knownFingerprints.push(previousFingerprint)
              if (!visual.genre && options.genre) { visual.genre = options.genre; changed = true; movedToGenre = true }
              if (!known.has(fingerprint)) {
                loaded.library.learning.knownFingerprints.push(fingerprint)
                known.add(fingerprint)
              }
            } else {
              const sample: LearnedCoverSample = {
                fingerprint, relativePath: task.currentFile, sourceDirectory: normalized,
                learnedAt: new Date().toISOString(), metrics,
                ...(options.genre ? { genre: options.genre } : {}),
                ...(isLegacy ? { legacy: true } : {})
              }
              loaded.library.learning.samples.push(sample)
              byFingerprint.set(fingerprint, sample)
              visualIndex.set(metrics.visualFingerprint, sample)
              known.add(fingerprint)
              changed = true
              if (isLegacy) {
                task.duplicates++
                backfilled++
                loaded.library.learning.legacyUntrackedSampleCount = Math.max(0, loaded.library.learning.legacyUntrackedSampleCount - 1)
              } else { task.learned++ }
            }
          }
        } catch (error) {
          task.failed++
          issues.push({ path: task.currentFile, reason: (error as Error).message || '图片分析失败', kind: 'failed' })
        }
        task.processed++
        if (task.processed % 10 === 0) {
          loaded.library.learning.lastTask = { ...task }
          loaded.library.updatedAt = new Date().toISOString()
          await this.persist(loaded)
        }
      }
      delete task.currentFile
      task.phase = 'summarizing'
      const group = this.samplesForGroup(loaded.library, options.genre)
      const observations = group.length >= MIN_RULE_SAMPLES
        ? deriveChineseObservations(group)
        : [`本组已有 ${group.length} 张合格封面，满 ${MIN_RULE_SAMPLES} 张后才提炼并启用学习规则。`]
      if (backfilled) observations.push(`已补充 ${backfilled} 张旧样本的视觉指标，来源总数不重复增加。`)
      const previousRules = structuredClone(loaded.library.learning.generatedRules)
      if (changed) {
        this.updateStatisticRules(loaded.library, options.genre)
        if (movedToGenre) this.updateStatisticRules(loaded.library, undefined)
      }
      let ai: AiRefinement = { rules: [], observations: [], status: (options.aiMode ?? 'off') === 'off' ? 'off' : 'skipped' }
      if (options.aiMode && options.aiMode !== 'off' && group.length >= MIN_RULE_SAMPLES && !controller.signal.aborted) {
        ai = await this.refineWithLlm(group, options.aiMode, options.genre, controller.signal)
        if (controller.signal.aborted) {
          ai = { rules: [], observations: [], status: 'skipped', message: 'AI 分析已取消，已保存本地样本。' }
        }
        if (!controller.signal.aborted && ai.status === 'completed') {
          loaded.library.learning.generatedRules = loaded.library.learning.generatedRules.filter((rule) => rule.source !== 'ai' || rule.genre !== options.genre)
          loaded.library.learning.generatedRules.push(...ai.rules)
        }
      } else if (options.aiMode && options.aiMode !== 'off') {
        ai.message = controller.signal.aborted ? '学习已取消，未继续 AI 分析。'
          : `本组不足 ${MIN_RULE_SAMPLES} 张合格封面，跳过 AI 分析。`
      }
      if (JSON.stringify(previousRules) !== JSON.stringify(loaded.library.learning.generatedRules)) {
        loaded.library.learning.ruleHistory = [...loaded.library.learning.ruleHistory, { updatedAt: loaded.library.updatedAt, rules: previousRules }].slice(-10)
      }
      loaded.library.learning.observedRules = []
      loaded.library.updatedAt = new Date().toISOString()
      const completedAt = new Date().toISOString()
      const storedRun: StoredLearningRun = {
        directory: normalized, scanned: files.length, learned: task.learned, duplicates: task.duplicates,
        rejected: task.rejected, failed: task.failed, issues, startedAt, completedAt,
        observations: [...observations, ...ai.observations], cancelled: controller.signal.aborted,
        aiStatus: ai.status, ...(ai.message ? { aiMessage: ai.message } : {})
      }
      task.phase = 'saving'
      loaded.library.learning.totalRunCount++
      loaded.library.learning.runs = [...loaded.library.learning.runs, storedRun].slice(-100)
      loaded.library.learning.lastTask = { ...task, phase: controller.signal.aborted ? 'cancelled' : 'completed' }
      await this.persist(loaded)
      const result = { ...storedRun, summary: (await this.load()).summary }
      task.phase = controller.signal.aborted ? 'cancelled' : 'completed'
      task.result = result
      return result
    } catch (error) {
      task.phase = 'failed'
      task.error = (error as Error).message
      throw error
    } finally {
      this.abortController = null
    }
  }

  private updateStatisticRules(library: CoverLearningLibrary, genre?: CoverGenre): void {
    const samples = this.samplesForGroup(library, genre)
    library.learning.generatedRules = library.learning.generatedRules.filter((rule) => rule.source !== 'statistics' || rule.genre !== genre)
    if (samples.length < MIN_RULE_SAMPLES) {
      library.learning.generatedRules = library.learning.generatedRules.filter((rule) => rule.genre !== genre)
      return
    }
    library.learning.generatedRules.push(...buildStatisticRules(samples, genre))
  }

  private async refineWithLlm(samples: LearnedCoverSample[], mode: 'summary' | 'vision', genre: CoverGenre | undefined, signal: AbortSignal): Promise<AiRefinement> {
    if (!this.llm) return { rules: [], observations: [], status: 'unsupported', message: '未配置学习模型，已保存本地分析结果。' }
    const stats = aggregateMetrics(samples)
    const representatives = selectRepresentativeSamples(samples)
    const evidence = representatives.map(sampleEvidence)
    const prompt = [
      '你正在提炼小说封面设计规律。只学习共性，不复制具体人物、书名或标志。',
      mode === 'vision'
        ? '查看提供的封面缩略图，只提炼有视觉证据支持的构图、标题位置、字体层级和配色规律，不临摹具体画面。'
        : '你只有汇总后的像素统计，没有看到图片。不要推测人物、文字排版、字体、文字位置或构图意图。仅提出统计数据能够支持的谨慎配色、明暗建议。',
      `适用题材：${genre ?? '通用／未分类'}；样本数：${samples.length}。`,
      `统计数据：${JSON.stringify({ ...stats, topColors: stats.topColors.map(chineseColorName) })}`,
      `已有统计规则：${JSON.stringify(deriveLearnedRules(samples))}`,
      `证据编号：${JSON.stringify(evidence)}`,
      '只输出 JSON：{"extraGlobalRules": ["2至4条简短的中文设计规则"], "observations": ["1至3条简短的中文观察"]}。两组字符串全部使用自然简体中文，不附英文翻译；字段名保持不变。不得补充无法观察到的事实。'
    ].join('\n')
    try {
      const images: string[] = []
      if (mode === 'vision') {
        const { Canvas, loadImage } = await import('skia-canvas')
        for (const sample of representatives) {
          if (signal.aborted) throw new Error('LLM_ABORTED')
          const image = await loadImage(sampleAbsolutePath(sample))
          const scale = Math.min(1, 512 / Math.max(image.width, image.height))
          const canvas = new Canvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
          images.push(`data:image/jpeg;base64,${(await canvas.toBuffer('jpg', { quality: 0.82 })).toString('base64')}`)
        }
      }
      const options = {
        meta: { feature: 'coverLearn' as const }, maxTokens: 1200, signal,
        ...(images.length ? { images } : {}),
        jsonSchema: { type: 'object', properties: { extraGlobalRules: { type: 'array', items: { type: 'string', description: '一条自然简体中文设计规则，不附英文翻译。' } }, observations: { type: 'array', items: { type: 'string', description: '一条有证据支持的自然简体中文观察。' } } }, required: ['extraGlobalRules', 'observations'], additionalProperties: false }
      }
      const raw = await this.llm.generateStream(prompt, options)
      const parsed = parseAiRefinement(raw)
      if (!parsed.extraGlobalRules.length) return { rules: [], observations: [], status: 'failed', message: 'AI 未返回有效中文规则，已保留本地分析结果。' }
      return {
        rules: parsed.extraGlobalRules.map((text, index) => ({
          id: `ai:${genre ?? 'general'}:${index + 1}`, text, source: 'ai', sampleCount: samples.length,
          enabled: true, ...(genre ? { genre } : {}), evidence: mode === 'vision' ? evidence : [`aggregate:${samples.length}`]
        })),
        observations: parsed.observations, status: 'completed'
      }
    } catch (error) {
      const message = (error as Error).message
      return { rules: [], observations: [], status: message.includes('LLM_VISION_UNSUPPORTED') ? 'unsupported' : 'failed',
        message: signal.aborted ? 'AI 分析已取消，已保存本地样本。' : `AI 分析未完成：${message}；已保存本地结果。` }
    }
  }

  resolveStyle(library: CoverLearningLibrary, requested: CoverStylePreset | undefined, genre: CoverGenre): { key: ConcreteStylePreset; definition: CoverStyleDefinition } {
    const key = requested && requested !== 'auto' ? requested : library.genreRecommendations[genre]
    return { key, definition: library.styles[key] ?? COVER_STYLE_PRESETS[key] }
  }

  private summary(directory: string, filePath: string, library: CoverLearningLibrary, status: 'ready' | 'fallback', error?: string): CoverLearningLibrarySummary {
    const genreSampleCounts: Partial<Record<CoverGenre, number>> = {}
    for (const sample of library.learning.samples) if (sample.genre) genreSampleCounts[sample.genre] = (genreSampleCounts[sample.genre] ?? 0) + 1
    const feedbackSummary = { adopted: 0, rejected: 0, unrated: 0 }
    for (const feedback of library.learning.feedback) feedbackSummary[feedback.status]++
    return {
      directory, filePath, status, styleCount: Object.keys(library.styles).length,
      sampleCount: library.source.sampleCount, categoryCount: library.source.categoryCount, updatedAt: library.updatedAt,
      // Alternate encodings in knownFingerprints are not additional analyzed samples.
      trackedSampleCount: library.learning.samples.length,
      analyzedSampleCount: library.learning.samples.length,
      legacySampleCount: library.learning.legacyUntrackedSampleCount + library.learning.samples.filter((sample) => sample.legacy).length,
      genreSampleCounts, learningRunCount: library.learning.totalRunCount,
      rules: this.rulePreview(library), canRollbackRules: library.learning.ruleHistory.length > 0,
      feedbackSummary,
      ...(library.learning.runs.length ? { lastLearnedAt: library.learning.runs[library.learning.runs.length - 1].completedAt } : {}),
      ...(error ? { error } : {})
    }
  }
}

const MIN_RULE_SAMPLES = 5
const COVER_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

function absoluteDirectory(directory: string, name: string): string {
  if (typeof directory !== 'string' || !directory.trim() || !isAbsolute(directory.trim())) throw new Error(`${name}必须使用本地绝对路径`)
  return resolve(directory.trim())
}

function isTerminal(phase: CoverLearningTaskState['phase']): boolean {
  return ['completed', 'cancelled', 'failed'].includes(phase)
}

async function collectImageFiles(root: string, issues: CoverLearningIssue[], signal: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    if (signal.aborted) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) {
      issues.push({ path: relative(root, directory) || root, reason: (error as Error).message, kind: 'failed' })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const entry of entries) {
      if (signal.aborted) break
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && COVER_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(fullPath)
    }
  }
  await visit(root)
  return files
}

function sampleEvidence(sample: LearnedCoverSample): string { return `${sample.fingerprint}:${sample.relativePath}` }

function sampleAbsolutePath(sample: LearnedCoverSample): string {
  const absolutePath = resolve(sample.sourceDirectory, sample.relativePath)
  const relativePath = relative(resolve(sample.sourceDirectory), absolutePath)
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('样本图片路径超出原始封面目录')
  return absolutePath
}

function selectRepresentativeSamples(samples: LearnedCoverSample[]): LearnedCoverSample[] {
  const selected: LearnedCoverSample[] = []
  const colors = new Set<string>()
  for (const sample of [...samples].reverse()) {
    if (colors.has(sample.metrics.dominantColor)) continue
    selected.push(sample)
    colors.add(sample.metrics.dominantColor)
    if (selected.length === 6) return selected
  }
  for (const sample of [...samples].reverse()) {
    if (!selected.includes(sample)) selected.push(sample)
    if (selected.length === 6) break
  }
  return selected
}

function statisticRuleKey(text: string): string {
  if (text.includes('% of tracked covers') || text.includes('采用竖版构图')) return 'portrait'
  if (text.includes('cluster near 9:16') || text.includes('接近 9:16')) return 'ratio'
  if (text.includes('saturation') || text.includes('saturated color') || text.includes('饱和')) return 'saturation'
  if (text.includes('tonal') || text.includes('明暗')) return 'contrast'
  if (text.includes('visual-detail') || text.includes('视觉细节密度')) return 'quiet-band'
  return 'palette'
}

/** 旧统计句型由程序生成，只有完整句型及参数合法时才迁移，不改写用户扩写的规则。 */
function localizeStatisticRule(text: string): string {
  const fixed = new Map([
    ['Observed local library favors saturated color separation; keep the focal subject and typography strongly differentiated.', '本地样本观察：较多封面使用高饱和色彩区分层次，注意拉开主体与文字的视觉差异。'],
    ['Observed local library favors restrained saturation; create hierarchy through value, texture and controlled accent color.', '本地样本观察：较多封面使用克制的低饱和配色，可通过亮度、质感与少量点缀色建立层次。'],
    ['Observed local library favors strong tonal contrast that remains legible at thumbnail size.', '本地样本观察：较多封面使用鲜明的明暗对比，缩略图下仍需保持清晰。'],
    ['Observed local library favors soft tonal transitions; reserve a cleaner text field to protect readability.', '本地样本观察：较多封面使用柔和的明暗过渡，宜为文字留出干净区域以保证可读性。']
  ])
  if (fixed.has(text)) return fixed.get(text)!
  const portrait = text.match(/^Observed local library: (\d{1,3})% of tracked covers use portrait composition; prioritize a tall mobile-first silhouette\.$/)
  if (portrait && Number(portrait[1]) <= 100) return `本地样本观察：${portrait[1]}% 的已追踪封面采用竖版构图，可优先采用适合手机展示的纵向主体轮廓。`
  const ratio = text.match(/^Observed local library: (\d{1,3})% cluster near 9:16; adapt those composition patterns to the required 3:4 master ratio and central safe area\.$/)
  if (ratio && Number(ratio[1]) <= 100) return `本地样本观察：${ratio[1]}% 的封面比例接近 9:16；借鉴其构图时，应适配当前 3:4 成品比例和裁剪安全区。`
  const band = text.match(/^Observed local library has the lowest average visual-detail density in the (upper|middle|lower) third; consider it as the first typography candidate when it does not cover a face\.$/)
  if (band) return `本地样本观察：${({ upper: '上', middle: '中', lower: '下' } as Record<string, string>)[band[1]]}三分之一的平均视觉细节密度最低，在不遮挡人物面部时，可作为文字排版的优先候选区域。`
  const palette = text.match(/^Observed recurring dominant color families: ([a-z]+(?:, [a-z]+){0,2}); use them as evidence, not as a mandatory palette\.$/)
  const colors = palette?.[1].split(', ')
  if (colors?.every((color) => chineseColorName(color) !== color)) return `本地样本观察：反复出现的主色族为${colors.map(chineseColorName).join('、')}，仅作为配色参考，不强制套用。`
  return text
}

function buildStatisticRules(samples: LearnedCoverSample[], genre?: CoverGenre): CoverLearningRuleSummary[] {
  if (samples.length < MIN_RULE_SAMPLES) return []
  const evidence = samples.slice(-6).map(sampleEvidence)
  return deriveLearnedRules(samples).map((text) => ({
    id: `statistics:${genre ?? 'general'}:${statisticRuleKey(text)}`, text, source: 'statistics',
    ...(genre ? { genre } : {}), sampleCount: samples.length, enabled: true, evidence
  }))
}

interface AiRefinement {
  rules: CoverLearningRuleSummary[]
  observations: string[]
  status: NonNullable<CoverLearningRunResult['aiStatus']>
  message?: string
}

function aggregateMetrics(samples: LearnedCoverSample[]): {
  portraitShare: number
  nineSixteenShare: number
  saturation: number
  contrast: number
  warmth: number
  quietBand: number
  topColors: string[]
} {
  const total = Math.max(1, samples.length)
  const bandTotals = [0, 0, 0]
  const colors = new Map<string, number>()
  let portrait = 0
  let nineSixteen = 0
  let saturation = 0
  let contrast = 0
  let warmth = 0
  for (const sample of samples) {
    const metric = sample.metrics
    if (metric.aspectRatio < 0.9) portrait++
    if (Math.abs(metric.aspectRatio - 9 / 16) <= 0.08) nineSixteen++
    saturation += metric.saturation
    contrast += metric.contrast
    warmth += metric.warmth
    metric.detailByBand.forEach((value, index) => { bandTotals[index] += value })
    if (metric.colorFamilies?.length) {
      for (const family of metric.colorFamilies) colors.set(family.color, (colors.get(family.color) ?? 0) + family.share)
    } else {
      colors.set(metric.dominantColor, (colors.get(metric.dominantColor) ?? 0) + 1)
    }
  }
  return {
    portraitShare: portrait / total,
    nineSixteenShare: nineSixteen / total,
    saturation: saturation / total,
    contrast: contrast / total,
    warmth: warmth / total,
    quietBand: bandTotals.indexOf(Math.min(...bandTotals)),
    topColors: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([color]) => color)
  }
}

function deriveLearnedRules(samples: LearnedCoverSample[]): string[] {
  if (samples.length === 0) return []
  const aggregate = aggregateMetrics(samples)
  const rules: string[] = []
  if (aggregate.portraitShare >= 0.7) {
    rules.push(`本地样本观察：${Math.round(aggregate.portraitShare * 100)}% 的已追踪封面采用竖版构图，可优先采用适合手机展示的纵向主体轮廓。`)
  }
  if (aggregate.nineSixteenShare >= 0.45) {
    rules.push(`本地样本观察：${Math.round(aggregate.nineSixteenShare * 100)}% 的封面比例接近 9:16；借鉴其构图时，应适配当前 3:4 成品比例和裁剪安全区。`)
  }
  rules.push(aggregate.saturation >= 0.45
    ? '本地样本观察：较多封面使用高饱和色彩区分层次，注意拉开主体与文字的视觉差异。'
    : '本地样本观察：较多封面使用克制的低饱和配色，可通过亮度、质感与少量点缀色建立层次。')
  rules.push(aggregate.contrast >= 0.22
    ? '本地样本观察：较多封面使用鲜明的明暗对比，缩略图下仍需保持清晰。'
    : '本地样本观察：较多封面使用柔和的明暗过渡，宜为文字留出干净区域以保证可读性。')
  const band = ['上三分之一', '中三分之一', '下三分之一'][aggregate.quietBand]
  rules.push(`本地样本观察：${band}的平均视觉细节密度最低，在不遮挡人物面部时，可作为文字排版的优先候选区域。`)
  if (aggregate.topColors.length > 0) {
    rules.push(`本地样本观察：反复出现的主色族为${aggregate.topColors.map(chineseColorName).join('、')}，仅作为配色参考，不强制套用。`)
  }
  return rules.slice(0, 8)
}

function chineseColorName(color: string): string {
  const names: Record<string, string> = { black: '黑色', white: '白色', grey: '灰色', gray: '灰色', neutral: '中性色', red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', cyan: '青色', blue: '蓝色', purple: '紫色', pink: '粉色', magenta: '品红色', brown: '棕色' }
  return names[color] ?? color
}

function parseAiRefinement(raw: string): { extraGlobalRules: string[]; observations: string[] } {
  const empty = { extraGlobalRules: [], observations: [] }
  if (!raw) return empty
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return empty
  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!isObject(parsed)) return empty
    const rules = Array.isArray(parsed.extraGlobalRules)
      ? parsed.extraGlobalRules
        .filter((rule): rule is string => typeof rule === 'string' && /\p{Script=Han}/u.test(rule))
        .map((rule) => rule.trim())
        .slice(0, 6)
      : []
    const observations = Array.isArray(parsed.observations)
      ? parsed.observations
        .filter((line): line is string => typeof line === 'string' && /\p{Script=Han}/u.test(line))
        .map((line) => line.trim())
        .slice(0, 4)
      : []
    return { extraGlobalRules: rules, observations }
  } catch {
    return empty
  }
}

function deriveChineseObservations(samples: LearnedCoverSample[]): string[] {
  if (samples.length === 0) return ['目前没有可汇总的新增封面。']
  const aggregate = aggregateMetrics(samples)
  const band = ['上三分之一', '中部', '下三分之一'][aggregate.quietBand]
  const palette = aggregate.topColors.map(chineseColorName).join('、')
  return [
    `已建立内容指纹的封面中，${Math.round(aggregate.portraitShare * 100)}% 为竖版构图，${Math.round(aggregate.nineSixteenShare * 100)}% 接近 9:16。`,
    `整体更偏${aggregate.saturation >= 0.45 ? '高饱和' : '克制低饱和'}、${aggregate.contrast >= 0.22 ? '强对比' : '柔和对比'}。`,
    `平均视觉细节最少的区域在${band}，可优先作为标题候选位置。`,
    palette ? `最常出现的主色族：${palette}。` : '暂未形成稳定的主色倾向。'
  ]
}
