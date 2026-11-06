import { z } from 'zod'

/**
 * 剧本创作工作台（小说 → 剧本 → 结构化分镜 → 视频提示词）的共享契约。
 *
 * 注意：渲染层只应 `import type` 本模块，避免把 zod 及校验逻辑打进前端 bundle；
 * 运行时 IPC 输入校验全部在主进程完成。
 */

/**
 * 分镜硬阻断纯校验器定义在 zod-free / Node-free 的独立模块中，供渲染层按值导入；
 * 这里重导出，方便主进程与测试沿用本模块作为统一契约入口。
 */
export { storyboardHardIssues } from './script-studio-gate'

// ---------------------------------------------------------------------------
// 常量与错误码
// ---------------------------------------------------------------------------

export const SCRIPT_SCHEMA_VERSION = 1
export const SOURCE_MAX_CHARS = 24_000
/** 与中短篇最多 60 节一致，全文选材保留所有分节来源。 */
export const SOURCE_MAX_RANGES = 60
export const OUTLINE_HINT_MAX_CHARS = 1_000
export const PROMPT_SOFT_LIMIT = 1900
export const PROMPT_HARD_LIMIT = 2000
export const MIN_UNIT_SEC = 4
export const MAX_UNIT_SEC = 15

export const FEATURE_SCRIPT = 'script:novel-to-script'
export const FEATURE_STORYBOARD = 'script:storyboard'
export const FEATURE_STORYBOARD_SEGMENT = 'script:storyboard:segment'

/** 镜头 11 字段，顺序固定；分镜表、校验器、页面编辑框必须完全一致。 */
export const SHOT_FIELDS = [
  'focalLength',
  'aperture',
  'depthOfFieldAndFocusLock',
  'cameraPosition',
  'composition',
  'cameraMovement',
  'subjectActionExpression',
  'dialogueAndTone',
  'lighting',
  'constraints',
  'nextTransition'
] as const
export type ShotField = (typeof SHOT_FIELDS)[number]

export const SCRIPT_CONFLICT = 'SCRIPT_CONFLICT'
export const SCRIPT_RUN_ACTIVE = 'SCRIPT_RUN_ACTIVE'
export const SCRIPT_PARSE_FAILED = 'SCRIPT_PARSE_FAILED'
export const SCRIPT_SOURCE_MISSING = 'SCRIPT_SOURCE_MISSING'
export const SCRIPT_STALE = 'SCRIPT_STALE'
export const SCRIPT_EXPORT_BLOCKED = 'SCRIPT_EXPORT_BLOCKED'
/** 分镜存在硬阻断（时长 / 11 字段等 error 级问题），主进程拒绝保存。 */
export const SCRIPT_STORYBOARD_BLOCKED = 'SCRIPT_STORYBOARD_BLOCKED'
export const LLM_EMPTY = 'LLM_EMPTY'
export const LLM_ABORTED = 'LLM_ABORTED'

export type ScriptErrorCode =
  | typeof SCRIPT_CONFLICT
  | typeof SCRIPT_RUN_ACTIVE
  | typeof SCRIPT_PARSE_FAILED
  | typeof SCRIPT_SOURCE_MISSING
  | typeof SCRIPT_STALE
  | typeof SCRIPT_EXPORT_BLOCKED
  | typeof SCRIPT_STORYBOARD_BLOCKED
  | typeof LLM_EMPTY
  | typeof LLM_ABORTED

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

export type ScriptFormat = 'short' | 'comic'
export type PaceTier = 'short-high' | 'high-hook' | 'cinematic-mid' | 'slow-info'
export type PromptMode = 'A' | 'B' | 'C'
export interface RhythmProfile {
  first3: string
  first15: string
  first30: string
  breathing: string
  avoidDragging: string
  completionGoal: string
}
export type AdaptStrength = 'low' | 'medium' | 'high'
export type SourceKind = 'long' | 'short' | 'pasteNovel' | 'pasteScript'
export type RunKind = 'script' | 'storyboard'
export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
export type GateSeverity = 'error' | 'warn'

export interface ScriptSettings {
  format: ScriptFormat
  platform: string
  aspectRatio: string
  /** 单集目标时长供创作规划使用，不进入最终视频提示词正文。 */
  targetDurationSec: number
  visualStyle: string
  adaptStrength: AdaptStrength
  paceTier: PaceTier
  resolution: string
  extraRequirements: string
  targetAudience?: string
  paceMode?: 'auto' | 'manual'
  promptMode?: 'auto' | PromptMode
  rhythmProfile?: RhythmProfile
}

export interface SourceRange {
  kind: 'longChapter' | 'shortStorySection' | 'paste'
  label: string
  projectId?: string
  chapterNumber?: number
  storyId?: string
  sectionNumber?: number
}

export interface SourceSnapshot {
  kind: SourceKind
  /** 选材快照正文；不写回原小说文件。 */
  text: string
  ranges: SourceRange[]
  /** 大纲仅作计划参考，绝不是事实来源。 */
  outlineHint: string
  sourceFingerprint: string
  truncated: boolean
  charCount: number
  createdAt: string
}

/** 一个镜头的 11 个必填字段。 */
export type Shot11 = Record<ShotField, string> & { functionLabel?: string }

export interface StoryboardUnit {
  id: string
  index: number
  durationSec: number
  emotion: string
  dramaticAction: string
  paceTier: PaceTier
  paceReason: string
  suggestedShotCount: number
  firstFrame: string
  lastFrame: string
  continuity: string
  characterPositions: string
  paceExecution?: string
  slowMotionPurpose?: string
  boundaryPlan?: string
  enhancementAdvice?: string[]
  /** P0 无参考图资产，恒为空数组。 */
  assetRefs: string[]
  shots: Shot11[]
}

export interface ComicExtras {
  keyFrames: string[]
  narration: string[]
  visualStyle: string
  transitions: string[]
}

export interface ScriptCandidate {
  id: string
  format: ScriptFormat
  body: string
  adaptationNote: string
  tentative: string[]
  additions: string[]
  characters: string[]
  scenes: string[]
  props: string[]
  creativeNotes: string
  risks: string[]
  comicExtras?: ComicExtras
  sourceFingerprint: string
  expectedRevision: number
  parseFallback: boolean
  createdAt: string
}

export interface ScriptVersion {
  id: string
  number: number
  body: string
  note: string
  sourceFingerprint: string
  createdAt: string
}

export interface BasedOn {
  projectId: string
  projectName: string
  versionId: string
  versionNumber: number
  /** settings + 所有剧本版本正文 + 分镜 计算所得，用于保存冲突校验。 */
  contentFingerprint: string
  /** settings + 所有剧本版本正文 计算所得；剧本改动后旧分镜据此失配。 */
  scriptFingerprint: string
  /** 分镜 units 计算所得；分镜改动后旧提示词据此失配。 */
  storyboardFingerprint: string
  sourceFingerprint: string
  scriptRevision: number
  unitId: string
  stale: boolean
  staleReason?: string
  generatedAt: string
}

export interface PackageMeta {
  projectId: string
  projectName: string
  versionId: string
  versionNumber: number
  contentFingerprint: string
  scriptFingerprint: string
  storyboardFingerprint: string
  sourceFingerprint: string
  unitId: string
  scriptRevision: number
  /** 时长/画幅/分辨率/任务类型/模式/视觉风格/平台/版本/指纹/过期状态单独返回，绝不进入 body。 */
  durationSec: number
  aspectRatio: string
  resolution: string
  taskType: string
  mode: PromptMode
  paceTier?: PaceTier
  paceReason?: string
  paceExecution?: string
  recommendedMode?: PromptMode
  modeReason?: string
  boundaryPlan?: string
  enhancementAdvice?: string[]
  splitFromUnitId?: string
  splitNotice?: string
  visualStyle: string
  platform: string
  schemaVersion: number
  stale: boolean
  staleReason?: string
  generatedAt: string
}

export interface GateIssue {
  code: string
  severity: GateSeverity
  message: string
  unitId?: string
  field?: string
}

export interface QualityReport {
  ok: boolean
  issues: GateIssue[]
  errors: GateIssue[]
  warnings: GateIssue[]
  charCount: number
  softLimit: number
  hardLimit: number
  compressed: boolean
  checkedAt: string
}

export interface PromptPackage {
  unitId: string
  meta: PackageMeta
  /** 纯净视频提示词正文；不含任何平台参数、管理话术、素材编号。 */
  body: string
  charCount: number
  quality: QualityReport
  /** 用于二次闸门校验的结构化来源，不进入导出正文。 */
  sourceShots: Shot11[]
  durationSec: number
}

export interface GenerationRun {
  runId: string
  projectId: string
  kind: RunKind
  feature: string
  status: RunStatus
  requestId: string
  unitId?: string
  startedAt: string
  updatedAt: string
  partialText: string
  retainedText?: string
  error?: string
}

export interface StoryboardDoc {
  units: StoryboardUnit[]
  basedOn: BasedOn
  storyboardFingerprint: string
  savedAt: string
}

export interface ScriptProject {
  schemaVersion: number
  id: string
  title: string
  settings: ScriptSettings
  source: SourceSnapshot
  candidate: ScriptCandidate | null
  scriptVersions: ScriptVersion[]
  activeVersionId: string | null
  storyboard: StoryboardDoc | null
  revision: number
  contentFingerprint: string
  scriptFingerprint: string
  createdAt: string
  updatedAt: string
}

export interface ScriptProjectSummary {
  id: string
  title: string
  format: ScriptFormat
  revision: number
  hasCandidate: boolean
  versionCount: number
  hasStoryboard: boolean
  createdAt: string
  updatedAt: string
}

/** 从章节列表 / 中短篇页跳转到工作台时携带的选材线索。 */
export interface SourceSelectionHint {
  kind: SourceKind
  projectId?: string
  chapterNumber?: number
  chapterNumbers?: number[]
  storyId?: string
  sectionNumbers?: number[] | 'all'
  title?: string
}

export interface RunSummary {
  runId: string
  projectId: string
  kind: RunKind
  status: RunStatus
  startedAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// IPC 输入与结果类型
// ---------------------------------------------------------------------------

export interface CreateScriptProjectInput {
  title: string
  settings: ScriptSettings
  sourceText: string
  sourceRanges: SourceRange[]
  outlineHint: string
  sourceKind: SourceKind
  truncated: boolean
}

export interface SaveScriptProjectInput {
  project: ScriptProject
}

export type SaveScriptProjectResult =
  | { ok: true; project: ScriptProject }
  | { ok: false; code: typeof SCRIPT_CONFLICT; current: ScriptProject; message: string }

export interface AdoptScriptCandidateInput {
  projectId: string
  candidateId: string
  expectedRevision: number
  body: string
  note: string
}

export type AdoptScriptCandidateResult =
  | { ok: true; project: ScriptProject }
  | { ok: false; code: ScriptErrorCode; message: string; current?: ScriptProject }

export interface SaveScriptStoryboardInput {
  projectId: string
  units: StoryboardUnit[]
  expectedRevision: number
  expectedVersionId: string
  expectedScriptFingerprint: string
  /** 必须使用分镜生成时的来源指纹。 */
  expectedSourceFingerprint: string
}

export type SaveScriptStoryboardResult =
  | { ok: true; project: ScriptProject }
  | { ok: false; code: ScriptErrorCode; message: string; current?: ScriptProject; issues?: GateIssue[] }

export interface GenerateStudioScriptInput {
  projectId: string
  expectedRevision: number
  instruction?: string
}

export interface GenerateStudioStoryboardInput {
  projectId: string
  expectedRevision: number
  unitId?: string
  instruction?: string
}

export interface ScriptStreamPayload {
  requestId: string
  token: string
  done: boolean
}

export type GenerateStudioScriptResult =
  | {
    ok: true
    candidate: ScriptCandidate
    project: ScriptProject
    error?: undefined
    code?: undefined
    retainedText?: undefined
    issues?: undefined
  }
  | {
    ok: false
    error: string
    code?: ScriptErrorCode
    retainedText?: string
    issues?: GateIssue[]
    candidate?: undefined
    project?: undefined
  }

export interface GenerateStudioStoryboardResult {
  ok: boolean
  units?: StoryboardUnit[]
  /** 分镜草稿的生成依据，保存时不得替换为当前项目的版本信息。 */
  basedOn?: BasedOn
  quality?: QualityReport
  error?: string
  code?: ScriptErrorCode
  retainedText?: string
}

export interface BuildStudioPromptPackageInput {
  projectId: string
  unitId?: string
  expectedBasedOn?: BasedOn
  /** 本次本地构建的模板选择，不修改正式稿或分镜依据。 */
  promptMode?: 'auto' | PromptMode
}

export type BuildStudioPromptPackageResult =
  | { ok: true; packages: PromptPackage[]; stale: boolean }
  | { ok: false; code: ScriptErrorCode; message: string; issues?: GateIssue[] }

export interface ExportStudioMarkdownInput {
  projectId: string
  packages: PromptPackage[]
  /** Web 版无可用 dialog 时置 true，返回 text/markdown 供前端下载。 */
  preferText?: boolean
  /** 允许导出已过期但显式标注的保存版本。 */
  allowStale?: boolean
}

export type ExportStudioMarkdownResult =
  | { ok: true; mode: 'file'; path: string; text: string; fileName: string }
  | { ok: true; mode: 'text'; text: string; mimeType: 'text/markdown'; fileName: string }
  | { ok: true; canceled: true }
  | { ok: false; code: typeof SCRIPT_EXPORT_BLOCKED | typeof SCRIPT_STALE; issues: GateIssue[]; message: string }

export interface ListStudioRunsInput {
  projectId: string
}

export interface RecoverStudioRunsInput {
  projectId?: string
}

export type RecoverStudioRunsResult = { ok: true; recovered: number; runs: GenerationRun[] }

// ---------------------------------------------------------------------------
// 共享校验片段（zod v4）
// ---------------------------------------------------------------------------

const shortString = z.string().max(2000)
const longString = z.string().max(200_000)
const fingerprintString = z.string().regex(/^[0-9a-f]{64}$/)
const uuidString = z.string().uuid()

export const scriptSettingsSchema = z.object({
  format: z.enum(['short', 'comic']),
  platform: shortString,
  aspectRatio: shortString,
  targetDurationSec: z.number().int().min(1).max(3600),
  visualStyle: shortString,
  adaptStrength: z.enum(['low', 'medium', 'high']),
  paceTier: z.enum(['short-high', 'high-hook', 'cinematic-mid', 'slow-info']),
  resolution: shortString,
  extraRequirements: z.string().max(10_000),
  targetAudience: shortString.optional(),
  paceMode: z.enum(['auto', 'manual']).optional(),
  promptMode: z.enum(['auto', 'A', 'B', 'C']).optional(),
  rhythmProfile: z.object({ first3: shortString, first15: shortString, first30: shortString,
    breathing: shortString, avoidDragging: shortString, completionGoal: shortString }).optional()
})

export const sourceRangeSchema = z.object({
  kind: z.enum(['longChapter', 'shortStorySection', 'paste']),
  label: shortString,
  projectId: shortString.optional(),
  chapterNumber: z.number().int().positive().optional(),
  storyId: shortString.optional(),
  sectionNumber: z.number().int().positive().optional()
})

export const sourceSnapshotSchema = z.object({
  kind: z.enum(['long', 'short', 'pasteNovel', 'pasteScript']),
  text: longString,
  ranges: z.array(sourceRangeSchema).max(SOURCE_MAX_RANGES),
  outlineHint: z.string().max(OUTLINE_HINT_MAX_CHARS),
  sourceFingerprint: fingerprintString,
  truncated: z.boolean(),
  charCount: z.number().int().nonnegative(),
  createdAt: z.string()
})

const shotShape = Object.fromEntries(
  SHOT_FIELDS.map(field => [field, z.string().max(4000)])
) as Record<ShotField, z.ZodString>
export const shot11Schema = z.object({ ...shotShape, functionLabel: shortString.optional() })

export const storyboardUnitSchema = z.object({
  id: shortString,
  index: z.number().int().nonnegative(),
  durationSec: z.number(),
  emotion: shortString,
  dramaticAction: longString,
  paceTier: z.enum(['short-high', 'high-hook', 'cinematic-mid', 'slow-info']),
  paceReason: longString,
  suggestedShotCount: z.number().int().nonnegative(),
  firstFrame: longString,
  lastFrame: longString,
  continuity: longString,
  characterPositions: longString,
  paceExecution: shortString.optional(),
  slowMotionPurpose: shortString.optional(),
  boundaryPlan: shortString.optional(),
  enhancementAdvice: z.array(shortString).max(20).optional(),
  assetRefs: z.array(shortString).max(20),
  shots: z.array(shot11Schema).max(40)
})

export const comicExtrasSchema = z.object({
  keyFrames: z.array(longString).max(40),
  narration: z.array(longString).max(40),
  visualStyle: shortString,
  transitions: z.array(longString).max(40)
})

export const scriptCandidateSchema = z.object({
  id: uuidString,
  format: z.enum(['short', 'comic']),
  body: longString,
  adaptationNote: longString,
  tentative: z.array(longString).max(50),
  additions: z.array(longString).max(50),
  characters: z.array(longString).max(100),
  scenes: z.array(longString).max(100),
  props: z.array(longString).max(100),
  creativeNotes: longString,
  risks: z.array(longString).max(50),
  comicExtras: comicExtrasSchema.optional(),
  sourceFingerprint: fingerprintString,
  expectedRevision: z.number().int().positive(),
  parseFallback: z.boolean(),
  createdAt: z.string()
})

export const scriptVersionSchema = z.object({
  id: uuidString,
  number: z.number().int().positive(),
  body: longString,
  note: shortString,
  sourceFingerprint: fingerprintString,
  createdAt: z.string()
})

export const basedOnSchema = z.object({
  projectId: uuidString,
  projectName: shortString,
  versionId: shortString,
  versionNumber: z.number().int().positive(),
  contentFingerprint: fingerprintString,
  scriptFingerprint: fingerprintString,
  storyboardFingerprint: fingerprintString,
  sourceFingerprint: fingerprintString,
  scriptRevision: z.number().int().positive(),
  unitId: shortString,
  stale: z.boolean(),
  staleReason: longString.optional(),
  generatedAt: z.string()
})

export const gateIssueSchema = z.object({
  code: shortString,
  severity: z.enum(['error', 'warn']),
  message: longString,
  unitId: shortString.optional(),
  field: shortString.optional()
})

export const qualityReportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(gateIssueSchema).max(200),
  errors: z.array(gateIssueSchema).max(200),
  warnings: z.array(gateIssueSchema).max(200),
  charCount: z.number().int().nonnegative(),
  softLimit: z.number().int().positive(),
  hardLimit: z.number().int().positive(),
  compressed: z.boolean(),
  checkedAt: z.string()
})

export const packageMetaSchema = z.object({
  projectId: uuidString,
  projectName: shortString,
  versionId: shortString,
  versionNumber: z.number().int().positive(),
  contentFingerprint: fingerprintString,
  scriptFingerprint: fingerprintString,
  storyboardFingerprint: fingerprintString,
  sourceFingerprint: fingerprintString,
  unitId: shortString,
  scriptRevision: z.number().int().positive(),
  durationSec: z.number(),
  aspectRatio: shortString,
  resolution: shortString,
  taskType: shortString,
  mode: z.enum(['A', 'B', 'C']),
  paceTier: z.enum(['short-high', 'high-hook', 'cinematic-mid', 'slow-info']).optional(),
  paceReason: shortString.optional(),
  paceExecution: shortString.optional(),
  recommendedMode: z.enum(['A', 'B', 'C']).optional(),
  modeReason: shortString.optional(),
  boundaryPlan: shortString.optional(),
  enhancementAdvice: z.array(shortString).max(20).optional(),
  splitFromUnitId: shortString.optional(),
  splitNotice: shortString.optional(),
  visualStyle: shortString,
  platform: shortString,
  schemaVersion: z.number().int().positive(),
  stale: z.boolean(),
  staleReason: longString.optional(),
  generatedAt: z.string()
})

export const promptPackageSchema = z.object({
  unitId: shortString,
  meta: packageMetaSchema,
  body: z.string().max(20_000),
  charCount: z.number().int().nonnegative(),
  quality: qualityReportSchema,
  sourceShots: z.array(shot11Schema).max(40),
  durationSec: z.number()
})

export const storyboardDocSchema = z.object({
  units: z.array(storyboardUnitSchema).max(60),
  basedOn: basedOnSchema,
  storyboardFingerprint: fingerprintString,
  savedAt: z.string()
})

export const scriptProjectSchema = z.object({
  schemaVersion: z.literal(SCRIPT_SCHEMA_VERSION),
  id: uuidString,
  title: shortString,
  settings: scriptSettingsSchema,
  source: sourceSnapshotSchema,
  candidate: scriptCandidateSchema.nullable(),
  scriptVersions: z.array(scriptVersionSchema).max(50),
  activeVersionId: shortString.nullable(),
  storyboard: storyboardDocSchema.nullable(),
  revision: z.number().int().positive(),
  contentFingerprint: fingerprintString,
  scriptFingerprint: fingerprintString,
  createdAt: z.string(),
  updatedAt: z.string()
})

export const generationRunSchema = z.object({
  runId: uuidString,
  projectId: uuidString,
  kind: z.enum(['script', 'storyboard']),
  feature: shortString,
  status: z.enum(['running', 'completed', 'failed', 'aborted', 'interrupted']),
  requestId: uuidString,
  unitId: shortString.optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  partialText: z.string().max(200_000),
  retainedText: z.string().max(200_000).optional(),
  error: z.string().max(2000).optional()
})

// ---------------------------------------------------------------------------
// LLM 结构化输出 schema
// ---------------------------------------------------------------------------

export const scriptStructuredOutputSchema = z.object({
  body: longString,
  adaptationNote: longString,
  tentative: z.array(longString).max(50),
  additions: z.array(longString).max(50),
  characters: z.array(longString).max(100),
  scenes: z.array(longString).max(100),
  props: z.array(longString).max(100),
  creativeNotes: longString,
  risks: z.array(longString).min(1).max(50),
  comicExtras: comicExtrasSchema.optional()
})

export const storyboardStructuredOutputSchema = z.object({
  units: z.array(storyboardUnitSchema).min(1).max(60)
})

export type ScriptStructuredOutput = z.infer<typeof scriptStructuredOutputSchema>
export type StoryboardStructuredOutput = z.infer<typeof storyboardStructuredOutputSchema>

// ---------------------------------------------------------------------------
// IPC 输入 schema
// ---------------------------------------------------------------------------

export const scriptProjectIdSchema = z.object({ projectId: uuidString })

export const createScriptProjectInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  settings: scriptSettingsSchema,
  sourceText: z.string().max(200_000),
  sourceRanges: z.array(sourceRangeSchema).max(SOURCE_MAX_RANGES),
  outlineHint: z.string().max(OUTLINE_HINT_MAX_CHARS),
  sourceKind: z.enum(['long', 'short', 'pasteNovel', 'pasteScript']),
  truncated: z.boolean()
})

export const saveScriptProjectInputSchema = z.object({ project: scriptProjectSchema })

export const adoptScriptCandidateInputSchema = z.object({
  projectId: uuidString,
  candidateId: uuidString,
  expectedRevision: z.number().int().positive(),
  body: longString,
  note: z.string().max(2000)
})

export const saveScriptStoryboardInputSchema = z.object({
  projectId: uuidString,
  units: z.array(storyboardUnitSchema).min(1).max(60),
  expectedRevision: z.number().int().positive(),
  expectedVersionId: shortString,
  expectedScriptFingerprint: fingerprintString,
  expectedSourceFingerprint: fingerprintString
})

export const generateStudioScriptInputSchema = z.object({
  projectId: uuidString,
  expectedRevision: z.number().int().positive(),
  instruction: z.string().max(4000).optional(),
  requestId: uuidString
})

export const generateStudioStoryboardInputSchema = z.object({
  projectId: uuidString,
  expectedRevision: z.number().int().positive(),
  unitId: shortString.optional(),
  instruction: z.string().max(4000).optional(),
  requestId: uuidString
})

export const buildStudioPromptPackageInputSchema = z.object({
  projectId: uuidString,
  unitId: shortString.optional(),
  expectedBasedOn: basedOnSchema.optional(),
  promptMode: z.enum(['auto', 'A', 'B', 'C']).optional()
})

export const exportStudioMarkdownInputSchema = z.object({
  projectId: uuidString,
  packages: z.array(promptPackageSchema).min(1).max(2400),
  preferText: z.boolean().optional(),
  allowStale: z.boolean().optional()
})

export const listStudioRunsInputSchema = z.object({ projectId: uuidString })

export const recoverStudioRunsInputSchema = z.object({
  projectId: uuidString.optional()
})

/** 12 个 invoke 通道 + 2 个流式事件通道；Web 版 RPC/SSE 通道名需满足 /^[\w:.-]{1,120}$/。 */
export const SCRIPT_STUDIO_INVOKE_CHANNELS = [
  'scriptStudio:listProjects',
  'scriptStudio:createProject',
  'scriptStudio:getProject',
  'scriptStudio:saveProject',
  'scriptStudio:adoptCandidate',
  'scriptStudio:saveStoryboard',
  'scriptStudio:generateScript',
  'scriptStudio:generateStoryboard',
  'scriptStudio:buildPromptPackage',
  'scriptStudio:exportMarkdown',
  'scriptStudio:listRuns',
  'scriptStudio:recoverRuns'
] as const

export const SCRIPT_STUDIO_TOKEN_CHANNELS = [
  'scriptStudio:scriptToken',
  'scriptStudio:storyboardToken'
] as const
