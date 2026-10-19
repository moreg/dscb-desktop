import type { ChapterGenerationStage } from './types'

export function generationProgressLabel(stage: ChapterGenerationStage | null): string {
  switch (stage) {
    case 'agy:queued': return 'AGY 排队中，等待前一个任务结束'
    case 'agy:waiting': return '等待 AGY 返回正文'
    case 'agy:streaming': return 'AGY 正在生成正文'
    case 'agy:retrying': return 'AGY 正在刷新登录状态并重试'
    case 'foreshadowRepair': return '正在检查并补写伏笔'
    default: return isDeslopStage(stage) ? deslopProgressLabel(stage) : '正在准备并生成正文'
  }
}

export const isDeslopStage = (stage: ChapterGenerationStage | null): boolean =>
  stage === 'deslop' || stage?.startsWith('deslop:') === true

export const deslopProgressLabel = (stage: ChapterGenerationStage | null): string =>
  stage?.startsWith('deslop:') ? stage.slice('deslop:'.length) : '正在检查对白比例与表达…'
