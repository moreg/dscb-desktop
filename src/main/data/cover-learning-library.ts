import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { extname, isAbsolute, join, relative, resolve } from 'path'
import type {
  CoverGenre,
  CoverLearningLibrarySummary,
  CoverLearningRunResult,
  CoverStylePreset
} from '../../shared/types'
import { writeJsonAtomic } from './atomic'
import type { SettingsRepository } from './settings-repository'
import {
  COVER_STYLE_PRESETS,
  type CoverStyleDefinition
} from './skill-prompts/cover/cover-styles'
import { LEGACY_COVER_FINGERPRINT_PREFIXES } from './cover-legacy-fingerprints'

export const COVER_LEARNING_LIBRARY_FILE = 'cover-learning-library.json'

type ConcreteStylePreset = Exclude<CoverStylePreset, 'auto'>

interface CoverVisualMetrics {
  width: number
  height: number
  aspectRatio: number
  averageRgb: [number, number, number]
  luminance: number
  saturation: number
  contrast: number
  warmth: number
  detailByBand: [number, number, number]
  dominantColor: string
  perceptualHash: string
  visualFingerprint: string
}

interface LearnedCoverSample {
  fingerprint: string
  relativePath: string
  sourceDirectory: string
  learnedAt: string
  metrics: CoverVisualMetrics
}

interface StoredLearningRun {
  directory: string
  scanned: number
  learned: number
  duplicates: number
  failed: number
  startedAt: string
  completedAt: string
  observations: string[]
}

interface CoverLearningState {
  /** 旧版学习结果只有总数、没有单图指纹，单独保留，避免错误宣称可以追溯。 */
  legacyUntrackedSampleCount: number
  /** 已学过但没有逐图视觉指标的旧样本内容指纹。 */
  knownFingerprints: string[]
  samples: LearnedCoverSample[]
  runs: StoredLearningRun[]
  observedRules: string[]
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
    'Use a portrait 9:16 master canvas and keep essential text inside the central 85% safe area.',
    'Design for mobile thumbnail recognition with one dominant focal point and a clear silhouette.',
    'Make the Chinese title the primary visual layer, normally occupying 20 to 35 percent of the cover.',
    'For long titles, group the exact text into 2 to 4 semantic lines instead of shrinking it.',
    'Render the exact Simplified Chinese title and author name once only; do not invent extra text or logos.',
    'Keep faces and signature props clear of the title; preserve strong foreground-background contrast.'
  ],
  genreRecommendations: GENRE_RECOMMENDATIONS,
  styles: COVER_STYLE_PRESETS,
  learning: {
    legacyUntrackedSampleCount: 138,
    knownFingerprints: [],
    samples: [],
    runs: [],
    observedRules: []
  }
}

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
      observedRules: []
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
        metrics
      })
    }
  }
  const runs: StoredLearningRun[] = Array.isArray(raw.runs)
    ? raw.runs.filter(isStoredLearningRun).slice(-100)
    : []
  const observedRules = Array.isArray(raw.observedRules)
    ? raw.observedRules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0).slice(0, 20)
    : []
  return {
    legacyUntrackedSampleCount: Math.max(0, Math.floor(finiteNumber(raw.legacyUntrackedSampleCount, sourceSampleCount))),
    knownFingerprints: Array.isArray(raw.knownFingerprints)
      ? raw.knownFingerprints.filter((fingerprint): fingerprint is string =>
        typeof fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(fingerprint))
      : [],
    samples,
    runs,
    observedRules
  }
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
    styles[key] = isStyleDefinition(candidate) ? candidate : COVER_STYLE_PRESETS[key]
  }

  const genreRecommendations = {} as Record<CoverGenre, ConcreteStylePreset>
  for (const genre of GENRE_KEYS) {
    const candidate = raw.genreRecommendations[genre]
    genreRecommendations[genre] = typeof candidate === 'string' && STYLE_KEYS.includes(candidate as ConcreteStylePreset)
      ? candidate as ConcreteStylePreset
      : GENRE_RECOMMENDATIONS[genre]
  }

  const globalRules = Array.isArray(raw.globalRules)
    ? raw.globalRules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0).slice(0, 50)
    : []

  const sourceSampleCount = typeof raw.source.sampleCount === 'number' ? raw.source.sampleCount : 0
  return {
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
    learning: validateLearning(raw.learning, sourceSampleCount)
  }
}

/**
 * 可迁移的本地封面学习库。每次 load 都从磁盘读取，因此用户手工更新 JSON 后，
 * 下一次提炼提示词或生成图片会立即生效，不需要重启应用。
 */
export class CoverLearningLibraryService {
  private learningTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly settings: SettingsRepository,
    private readonly defaultDirectory: string
  ) {}

  async initialize(): Promise<CoverLearningLibrarySummary> {
    return (await this.load()).summary
  }

  async load(): Promise<LoadedCoverLearningLibrary> {
    const directory = await this.settings.getCoverLearningLibraryDir(this.defaultDirectory)
    const filePath = join(directory, COVER_LEARNING_LIBRARY_FILE)
    try {
      await fs.mkdir(directory, { recursive: true })
      try {
        await fs.access(filePath)
      } catch {
        await writeJsonAtomic(filePath, DEFAULT_COVER_LEARNING_LIBRARY)
      }
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown
      const library = validateLibrary(raw)
      return { library, summary: this.summary(directory, filePath, library, 'ready') }
    } catch (err) {
      const library = DEFAULT_COVER_LEARNING_LIBRARY
      return {
        library,
        summary: this.summary(directory, filePath, library, 'fallback', (err as Error).message)
      }
    }
  }

  setDirectory(directory: string): Promise<CoverLearningLibrarySummary> {
    const task = this.learningTail.then(() => this.performSetDirectory(directory))
    this.learningTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async performSetDirectory(directory: string): Promise<CoverLearningLibrarySummary> {
    const normalized = resolve(directory.trim())
    if (!directory.trim() || !isAbsolute(directory)) throw new Error('学习库必须使用本地绝对路径')
    const current = await this.load()
    const destinationFile = join(normalized, COVER_LEARNING_LIBRARY_FILE)
    await fs.mkdir(normalized, { recursive: true })
    try {
      await fs.access(destinationFile)
    } catch {
      await writeJsonAtomic(
        destinationFile,
        current.summary.status === 'ready' ? current.library : DEFAULT_COVER_LEARNING_LIBRARY
      )
    }
    await this.settings.setCoverLearningLibraryDir(normalized)
    return (await this.load()).summary
  }

  learnFolder(directory: string): Promise<CoverLearningRunResult> {
    const task = this.learningTail.then(() => this.performLearnFolder(directory))
    this.learningTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async performLearnFolder(directory: string): Promise<CoverLearningRunResult> {
    const normalized = resolve(directory.trim())
    if (!directory.trim() || !isAbsolute(directory)) throw new Error('封面文件夹必须使用本地绝对路径')
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('选择的封面文件夹不存在或无法读取')

    const startedAt = new Date().toISOString()
    const loaded = await this.load()
    if (loaded.summary.status !== 'ready') {
      throw new Error(`学习库当前无法写入：${loaded.summary.error ?? '文件格式异常'}`)
    }

    const files = await collectImageFiles(normalized)
    const known = new Set([
      ...loaded.library.learning.knownFingerprints,
      ...loaded.library.learning.samples.map((sample) => sample.fingerprint)
    ])
    const legacyPrefixes = loaded.library.learning.legacyUntrackedSampleCount === 138
      ? new Set(LEGACY_COVER_FINGERPRINT_PREFIXES)
      : new Set<string>()
    const visualIndex = new Map<string, LearnedCoverSample[]>()
    for (const sample of loaded.library.learning.samples) {
      if (!sample.metrics.visualFingerprint) continue
      const bucket = visualIndex.get(sample.metrics.visualFingerprint) ?? []
      bucket.push(sample)
      visualIndex.set(sample.metrics.visualFingerprint, bucket)
    }
    let learned = 0
    let duplicates = 0
    let failed = 0

    for (const filePath of files) {
      try {
        const buffer = await fs.readFile(filePath)
        const fingerprint = createHash('sha256').update(buffer).digest('hex')
        if (known.has(fingerprint) || legacyPrefixes.has(fingerprint.slice(0, 24))) {
          duplicates++
          continue
        }
        const metrics = await analyzeCover(filePath)
        const visualMatches = visualIndex.get(metrics.visualFingerprint) ?? []
        if (visualMatches.length > 0) {
          duplicates++
          continue
        }
        const learnedSample: LearnedCoverSample = {
          fingerprint,
          relativePath: relative(normalized, filePath).replace(/\\/g, '/'),
          sourceDirectory: normalized,
          learnedAt: new Date().toISOString(),
          metrics
        }
        loaded.library.learning.samples.push(learnedSample)
        known.add(fingerprint)
        visualIndex.set(metrics.visualFingerprint, [...visualMatches, learnedSample])
        learned++
      } catch {
        failed++
      }
    }

    const learnedRules = deriveLearnedRules(loaded.library.learning.samples)
    const observations = deriveChineseObservations(loaded.library.learning.samples)
    const previousRules = new Set(loaded.library.learning.observedRules)
    loaded.library.globalRules = [
      ...loaded.library.globalRules.filter((rule) => !previousRules.has(rule)),
      ...learnedRules
    ].slice(0, 50)
    loaded.library.learning.observedRules = learnedRules
    loaded.library.source.sampleCount =
      loaded.library.learning.legacyUntrackedSampleCount + loaded.library.learning.samples.length
    loaded.library.updatedAt = new Date().toISOString()

    const completedAt = new Date().toISOString()
    const storedRun: StoredLearningRun = {
      directory: normalized,
      scanned: files.length,
      learned,
      duplicates,
      failed,
      startedAt,
      completedAt,
      observations
    }
    loaded.library.learning.runs = [...loaded.library.learning.runs, storedRun].slice(-100)
    await writeJsonAtomic(loaded.summary.filePath, loaded.library)

    const refreshed = await this.load()
    return {
      ...storedRun,
      summary: refreshed.summary
    }
  }

  resolveStyle(
    library: CoverLearningLibrary,
    requested: CoverStylePreset | undefined,
    genre: CoverGenre
  ): { key: ConcreteStylePreset; definition: CoverStyleDefinition } {
    const key = requested && requested !== 'auto'
      ? requested
      : library.genreRecommendations[genre]
    return { key, definition: library.styles[key] ?? COVER_STYLE_PRESETS[key] }
  }

  private summary(
    directory: string,
    filePath: string,
    library: CoverLearningLibrary,
    status: 'ready' | 'fallback',
    error?: string
  ): CoverLearningLibrarySummary {
    return {
      directory,
      filePath,
      status,
      styleCount: Object.keys(library.styles).length,
      sampleCount: library.source.sampleCount,
      categoryCount: library.source.categoryCount,
      updatedAt: library.updatedAt,
      trackedSampleCount: library.learning.legacyUntrackedSampleCount + new Set([
        ...library.learning.knownFingerprints,
        ...library.learning.samples.map((sample) => sample.fingerprint)
      ]).size,
      learningRunCount: library.learning.runs.length,
      ...(library.learning.runs.length > 0
        ? { lastLearnedAt: library.learning.runs[library.learning.runs.length - 1].completedAt }
        : {}),
      ...(error ? { error } : {})
    }
  }
}

const COVER_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
async function collectImageFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && COVER_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }
  await visit(root)
  return files
}

async function analyzeCover(filePath: string): Promise<CoverVisualMetrics> {
  const { Canvas, loadImage } = await import('skia-canvas')
  const image = await loadImage(filePath)
  if (!image.width || !image.height) throw new Error('图片尺寸无效')

  const width = 72
  const height = 128
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  const pixels = ctx.getImageData(0, 0, width, height).data
  const luminances = new Float64Array(width * height)
  let red = 0
  let green = 0
  let blue = 0
  let luminance = 0
  let saturation = 0

  for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel++) {
    const r = pixels[index] / 255
    const g = pixels[index + 1] / 255
    const b = pixels[index + 2] / 255
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    red += r
    green += g
    blue += b
    luminance += lum
    saturation += max === 0 ? 0 : (max - min) / max
    luminances[pixel] = lum
  }

  const count = width * height
  const averageLuminance = luminance / count
  let variance = 0
  const detailSum = [0, 0, 0]
  const detailCount = [0, 0, 0]
  for (let y = 0; y < height; y++) {
    const band = Math.min(2, Math.floor((y / height) * 3))
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const lum = luminances[index]
      variance += (lum - averageLuminance) ** 2
      if (x > 0) {
        detailSum[band] += Math.abs(lum - luminances[index - 1])
        detailCount[band]++
      }
      if (y > 0) {
        detailSum[band] += Math.abs(lum - luminances[index - width])
        detailCount[band]++
      }
    }
  }

  const averageRgb: [number, number, number] = [
    Math.round((red / count) * 255),
    Math.round((green / count) * 255),
    Math.round((blue / count) * 255)
  ]
  return {
    width: image.width,
    height: image.height,
    aspectRatio: image.width / image.height,
    averageRgb,
    luminance: roundMetric(averageLuminance),
    saturation: roundMetric(saturation / count),
    contrast: roundMetric(Math.sqrt(variance / count)),
    warmth: roundMetric((averageRgb[0] - averageRgb[2]) / 255),
    detailByBand: detailSum.map((value, index) => roundMetric(value / Math.max(1, detailCount[index]))) as [number, number, number],
    dominantColor: classifyDominantColor(...averageRgb),
    perceptualHash: buildPerceptualHash(luminances, width, height),
    visualFingerprint: buildNormalizedVisualFingerprint(pixels, width, height)
  }
}

function buildNormalizedVisualFingerprint(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): string {
  const blocksX = 18
  const blocksY = 32
  const signature = Buffer.alloc(blocksX * blocksY * 3)
  let output = 0
  for (let blockY = 0; blockY < blocksY; blockY++) {
    const startY = Math.floor((blockY / blocksY) * height)
    const endY = Math.max(startY + 1, Math.floor(((blockY + 1) / blocksY) * height))
    for (let blockX = 0; blockX < blocksX; blockX++) {
      const startX = Math.floor((blockX / blocksX) * width)
      const endX = Math.max(startX + 1, Math.floor(((blockX + 1) / blocksX) * width))
      let red = 0
      let green = 0
      let blue = 0
      let count = 0
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const index = (y * width + x) * 4
          red += pixels[index]
          green += pixels[index + 1]
          blue += pixels[index + 2]
          count++
        }
      }
      signature[output++] = Math.round(red / count)
      signature[output++] = Math.round(green / count)
      signature[output++] = Math.round(blue / count)
    }
  }
  return createHash('sha256').update(signature).digest('hex')
}

function buildPerceptualHash(luminances: Float64Array, width: number, height: number): string {
  let bits = ''
  for (let y = 0; y < 8; y++) {
    const sourceY = Math.min(height - 1, Math.round(((y + 0.5) / 8) * height))
    for (let x = 0; x < 8; x++) {
      const leftX = Math.min(width - 1, Math.round((x / 9) * width))
      const rightX = Math.min(width - 1, Math.round(((x + 1) / 9) * width))
      bits += luminances[sourceY * width + leftX] > luminances[sourceY * width + rightX] ? '1' : '0'
    }
  }
  let hex = ''
  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16)
  }
  return hex.padStart(16, '0')
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function classifyDominantColor(r255: number, g255: number, b255: number): string {
  const r = r255 / 255
  const g = g255 / 255
  const b = b255 / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta < 0.1) return max < 0.28 ? 'black' : max > 0.78 ? 'white' : 'neutral'
  let hue: number
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)
  if (hue < 0) hue += 360
  if (hue < 20 || hue >= 345) return 'red'
  if (hue < 50) return 'orange'
  if (hue < 75) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 200) return 'cyan'
  if (hue < 260) return 'blue'
  if (hue < 300) return 'purple'
  return 'magenta'
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
    colors.set(metric.dominantColor, (colors.get(metric.dominantColor) ?? 0) + 1)
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
    rules.push(`Observed local library: ${Math.round(aggregate.portraitShare * 100)}% of tracked covers use portrait composition; prioritize a tall mobile-first silhouette.`)
  }
  if (aggregate.nineSixteenShare >= 0.45) {
    rules.push(`Observed local library: ${Math.round(aggregate.nineSixteenShare * 100)}% cluster near 9:16; preserve the 9:16 master ratio and central safe area.`)
  }
  rules.push(aggregate.saturation >= 0.45
    ? 'Observed local library favors saturated color separation; keep the focal subject and typography strongly differentiated.'
    : 'Observed local library favors restrained saturation; create hierarchy through value, texture and controlled accent color.')
  rules.push(aggregate.contrast >= 0.22
    ? 'Observed local library favors strong tonal contrast that remains legible at thumbnail size.'
    : 'Observed local library favors soft tonal transitions; reserve a cleaner text field to protect readability.')
  const band = ['upper third', 'middle third', 'lower third'][aggregate.quietBand]
  rules.push(`Observed local library has the lowest average visual-detail density in the ${band}; consider it as the first typography candidate when it does not cover a face.`)
  if (aggregate.topColors.length > 0) {
    rules.push(`Observed recurring dominant color families: ${aggregate.topColors.join(', ')}; use them as evidence, not as a mandatory palette.`)
  }
  return rules.slice(0, 8)
}

function deriveChineseObservations(samples: LearnedCoverSample[]): string[] {
  if (samples.length === 0) return ['目前没有可汇总的新增封面。']
  const aggregate = aggregateMetrics(samples)
  const band = ['上三分之一', '中部', '下三分之一'][aggregate.quietBand]
  const palette = aggregate.topColors.join('、')
  return [
    `已建立内容指纹的封面中，${Math.round(aggregate.portraitShare * 100)}% 为竖版构图，${Math.round(aggregate.nineSixteenShare * 100)}% 接近 9:16。`,
    `整体更偏${aggregate.saturation >= 0.45 ? '高饱和' : '克制低饱和'}、${aggregate.contrast >= 0.22 ? '强对比' : '柔和对比'}。`,
    `平均视觉细节最少的区域在${band}，可优先作为标题候选位置。`,
    palette ? `最常出现的主色族：${palette}。` : '暂未形成稳定的主色倾向。'
  ]
}
