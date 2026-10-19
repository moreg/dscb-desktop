import type { ChapterGenerationStage, PostWriteProgress } from './types'

export function postWriteProgressLabel(progress: PostWriteProgress): string {
  const labels: Record<PostWriteProgress['stage'], string> = {
    outline: '伏笔：对照完整细纲，查找遗漏',
    generate: '伏笔：补写遗漏段落',
    review: '伏笔：联合复核细纲与新增内容',
    verify: '伏笔：独立核验新增内容的因果与揭示边界',
    dialogue: '伏笔：检查补写后的对白与表达',
    finalCheck: '伏笔：正文已调整，重新核对完整细纲',
    selfCheck: '记忆：执行写后自检',
    extract: '记忆：从正文提取人物、道具与伏笔变化',
    deepReview: '记忆：审核正文与连续性',
    evidence: '记忆：核对并补齐原文证据',
    plantEvidence: '记忆：核实历史伏笔的埋设证据',
    writeMemory: '记忆：校验正文版本并写入记忆',
    writeSettings: '记忆：同步设定变更',
    summary: '记忆已处理：更新章节概要'
  }
  return [labels[progress.stage], progress.round ? `第 ${progress.round}/2 轮` : '',
    progress.attempt && progress.attempt > 1 ? `第 ${progress.attempt} 次尝试` : '', progress.detail ?? ''].filter(Boolean).join(' · ')
}

export function generationProgressLabel(stage: ChapterGenerationStage | null): string {
  if (stage?.startsWith('foreshadow:')) return stage.slice('foreshadow:'.length)
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
