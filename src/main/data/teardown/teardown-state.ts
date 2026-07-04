import type {
  TeardownLengthKind,
  TeardownLongProgress,
  TeardownShortMeta,
  TeardownStage,
  StructureCounts,
  TeardownEntry,
  TeardownProgressInfo,
  TeardownChapterBoundary
} from '../../../shared/types'

/**
 * 拆文状态机辅助（纯函数，无 IO）。
 *
 * 阶段编号对齐 skill 包：
 * - 长篇：0 → 0.5 → 1（停靠）→ 2 → 3 → 4 → 5 → 6
 * - 短篇：2 → 3 → 4 → 5 → 6（串行）
 *
 * crash safety：lastStageInProgress 在落盘前置；目标文件 non-empty + 最小长度检查通过
 * 才清空并 append stagesCompleted；半成品不被信任，resume 整段重跑。
 */

export const LONG_STAGES: TeardownStage[] = [0, 0.5, 1, 2, 3, 4, 5, 6]
export const SHORT_STAGES: TeardownStage[] = [2, 3, 4, 5, 6]

/** 长篇管道的阶段依赖顺序（含停靠点） */
export function stageOrder(lengthKind: TeardownLengthKind): TeardownStage[] {
  return lengthKind === 'long' ? LONG_STAGES : SHORT_STAGES
}

/** 计算下一个待执行阶段（resume 入口） */
export function nextStage(
  lengthKind: TeardownLengthKind,
  completed: TeardownStage[]
): TeardownStage | null {
  const order = stageOrder(lengthKind)
  const done = new Set(completed)
  for (const s of order) {
    if (!done.has(s)) return s
  }
  return null // 全部完成
}

/** 长篇是否停在 Stage 1 停靠点（需用户确认 continue 才进 Stage 2） */
export function isPausedAfterStage1(progress: TeardownLongProgress): boolean {
  if (!progress.pausedAfterStage1) return false
  const done = new Set(progress.stagesCompleted)
  return done.has(1) && !done.has(2)
}

/** 判断管道是否全部完成 */
export function isComplete(
  lengthKind: TeardownLengthKind,
  completed: TeardownStage[]
): boolean {
  return nextStage(lengthKind, completed) === null
}

/* =========================================================
   长篇 _progress 构造/流转
   ========================================================= */

export function createLongProgress(
  bookName: string,
  chapterBoundaries: TeardownChapterBoundary[]
): TeardownLongProgress {
  return {
    schemaVersion: 2,
    bookName,
    chapterBoundaries,
    stagesCompleted: [],
    pausedAfterStage1: false,
    failures: [],
    updatedAt: new Date().toISOString()
  }
}

/** 标记某阶段开始进行（落盘前置，crash 时 resume 整段重跑） */
export function markStageInProgress(
  progress: TeardownLongProgress,
  stage: TeardownStage
): TeardownLongProgress {
  return {
    ...progress,
    lastStageInProgress: stage,
    updatedAt: new Date().toISOString()
  }
}

/** 标记某阶段完成（清 lastStageInProgress，append stagesCompleted） */
export function markStageComplete(
  progress: TeardownLongProgress,
  stage: TeardownStage
): TeardownLongProgress {
  const done = new Set(progress.stagesCompleted)
  done.add(stage)
  const arr = stageOrder('long').filter((s) => done.has(s))
  return {
    ...progress,
    stagesCompleted: arr,
    lastStageInProgress: undefined,
    updatedAt: new Date().toISOString()
  }
}

/** 长篇 Stage 1 后置停靠标志 */
export function setPausedAfterStage1(
  progress: TeardownLongProgress,
  paused: boolean
): TeardownLongProgress {
  return {
    ...progress,
    pausedAfterStage1: paused,
    updatedAt: new Date().toISOString()
  }
}

/** 记录失败（不中断管道） */
export function recordFailure(
  progress: TeardownLongProgress,
  stage: TeardownStage,
  reason: string,
  chapter?: number
): TeardownLongProgress {
  return {
    ...progress,
    failures: [
      ...progress.failures,
      { stage, chapter, reason, at: new Date().toISOString() }
    ],
    updatedAt: new Date().toISOString()
  }
}

/* =========================================================
   短篇 _meta 构造/流转
   ========================================================= */

export function createShortMeta(bookName: string, wordCount: number): TeardownShortMeta {
  return {
    version: 1,
    bookName,
    wordCount,
    stagesCompleted: [],
    structureCounts: emptyStructureCounts(),
    updatedAt: new Date().toISOString()
  }
}

export function markShortStageInProgress(
  meta: TeardownShortMeta,
  stage: TeardownStage
): TeardownShortMeta {
  return { ...meta, lastStageInProgress: stage, updatedAt: new Date().toISOString() }
}

export function markShortStageComplete(
  meta: TeardownShortMeta,
  stage: TeardownStage
): TeardownShortMeta {
  const done = new Set(meta.stagesCompleted)
  done.add(stage)
  const arr = stageOrder('short').filter((s) => done.has(s))
  return { ...meta, stagesCompleted: arr, lastStageInProgress: undefined, updatedAt: new Date().toISOString() }
}

export function setStructureCounts(
  meta: TeardownShortMeta,
  counts: StructureCounts
): TeardownShortMeta {
  return { ...meta, structureCounts: counts, updatedAt: new Date().toISOString() }
}

function emptyStructureCounts(): StructureCounts {
  return {
    beats: 0,
    hooks: 0,
    setupClues: 0,
    characterArchetypes: 0,
    reusableStructures: 0
  }
}

/* =========================================================
   Phase 7 短篇结构计数阈值校验
   ========================================================= */

export interface StructureValidationResult {
  ok: boolean
  errors: string[]
}

/** Phase 7.2 强制阈值校验（beats≥4/hooks≥3/setup_clues≥3/archetypes≥2/reusable≥3） */
export function validateStructureCounts(counts: StructureCounts): StructureValidationResult {
  const errors: string[] = []
  if (counts.beats < 4) errors.push(`功能分段不足：${counts.beats}（需≥4，必含开端/发展/高潮/结局）`)
  if (counts.hooks < 3) errors.push(`钩子不足：${counts.hooks}（需≥3）`)
  if (counts.setupClues < 3) errors.push(`铺垫线索不足：${counts.setupClues}（需≥3）`)
  if (counts.characterArchetypes < 2) errors.push(`角色原型不足：${counts.characterArchetypes}（需≥2）`)
  if (counts.reusableStructures < 3) errors.push(`可复用结构不足：${counts.reusableStructures}（需≥3）`)
  return { ok: errors.length === 0, errors }
}

/* =========================================================
   字数路由（短篇/长篇分流）
   ========================================================= */

const SHORT_MAX = 15000
const LONG_MIN = 20000

export function routeByWordCount(wordCount: number): {
  lengthKind: TeardownLengthKind
  isGrayZone: boolean
} {
  if (wordCount < SHORT_MAX) return { lengthKind: 'short', isGrayZone: false }
  if (wordCount > LONG_MIN) return { lengthKind: 'long', isGrayZone: false }
  return { lengthKind: 'short', isGrayZone: true } // 灰区默认建议短篇，前端询问
}

/* =========================================================
   进度信息构建（IPC 返回）
   ========================================================= */

const STAGE_LABELS: Record<string, string> = {
  '0': '概要提取',
  '0.5': '章节边界表',
  '1': '黄金三章深度拆解',
  '2': '逐章摘要',
  '3': '聚合分析',
  '4': '设定与角色关系',
  '5': '汇总报告',
  '6': '文风分析'
}

const SHORT_STAGE_LABELS: Record<string, string> = {
  '2': '结构与情节节点',
  '3': '情感线与爆点',
  '4': '反转与写作手法',
  '5': '人物与开头结尾',
  '6': '综合评估'
}

export function buildProgressInfo(
  bookName: string,
  lengthKind: TeardownLengthKind,
  completed: TeardownStage[],
  inProgress?: TeardownStage,
  chapterProgress?: { done: number; total: number }
): TeardownProgressInfo {
  const labels = lengthKind === 'long' ? STAGE_LABELS : SHORT_STAGE_LABELS
  const current = inProgress ?? null
  let statusText: string
  if (current !== null) {
    const base = labels[String(current)] ?? `Stage ${current}`
    if (chapterProgress && current === 2) {
      statusText = `${base}（${chapterProgress.done}/${chapterProgress.total} 章）`
    } else {
      statusText = `正在：${base}`
    }
  } else if (isComplete(lengthKind, completed)) {
    statusText = '拆解完成'
  } else {
    const next = nextStage(lengthKind, completed)
    statusText = next !== null ? `待执行：${labels[String(next)] ?? `Stage ${next}`}` : '拆解完成'
  }
  return {
    bookName,
    lengthKind,
    currentStage: current,
    stagesCompleted: completed,
    statusText,
    chapterProgress
  }
}

/* =========================================================
   TeardownEntry 摘要构建
   ========================================================= */

export function buildEntryFromLong(
  bookName: string,
  progress: TeardownLongProgress,
  createdAt: string
): TeardownEntry {
  return {
    bookName,
    lengthKind: 'long',
    stagesCompleted: progress.stagesCompleted,
    currentStage: progress.lastStageInProgress ?? undefined,
    pausedAfterStage1: isPausedAfterStage1(progress),
    wordCount: 0, // 长篇字数从原文统计，这里留 0 由调用方补
    createdAt,
    updatedAt: progress.updatedAt
  }
}

export function buildEntryFromShort(
  meta: TeardownShortMeta,
  createdAt: string
): TeardownEntry {
  return {
    bookName: meta.bookName,
    lengthKind: 'short',
    stagesCompleted: meta.stagesCompleted,
    currentStage: meta.lastStageInProgress ?? undefined,
    wordCount: meta.wordCount,
    genreDetected: meta.genreDetected,
    createdAt,
    updatedAt: meta.updatedAt
  }
}
