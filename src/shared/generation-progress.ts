import type { ChapterGenerationStage } from './types'

export const isDeslopStage = (stage: ChapterGenerationStage | null): boolean =>
  stage === 'deslop' || stage?.startsWith('deslop:') === true

export const deslopProgressLabel = (stage: ChapterGenerationStage | null): string =>
  stage?.startsWith('deslop:') ? stage.slice('deslop:'.length) : '正在检查对白比例与表达…'
