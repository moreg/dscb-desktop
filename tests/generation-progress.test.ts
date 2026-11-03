import { describe, expect, it } from 'vitest'
import { generationProgressLabel, isDeslopStage } from '../src/shared/generation-progress'
import type { ChapterGenerationStage } from '../src/shared/types'

describe('generation progress labels', () => {
  it.each<[ChapterGenerationStage | null, string]>([
    [null, '正在准备写作上下文'],
    ['preparing', '正在准备写作上下文'],
    ['preparing:核对历史记忆与上章结尾状态', '核对历史记忆与上章结尾状态'],
    ['preparing:', '正在准备写作上下文'],
    ['waiting', '上下文已就绪，等待正文首字'],
    ['generating', '正在生成正文']
  ])('distinguishes the preparation and first-token stages: %s', (stage, expected) => {
    expect(generationProgressLabel(stage)).toBe(expected)
    expect(isDeslopStage(stage)).toBe(false)
  })

  it.each<[ChapterGenerationStage, string]>([
    ['agy:queued', 'AGY 排队中，等待前一个任务结束'],
    ['agy:waiting', '等待 AGY 返回正文'],
    ['agy:streaming', 'AGY 正在生成正文'],
    ['agy:retrying', 'AGY 正在刷新登录状态并重试'],
    ['deslop', '正在检查表达与事实…'],
    ['deslop:整场保真修订 1/4', '整场保真修订 1/4'],
    ['foreshadowRepair', '正在检查并补写伏笔'],
    ['foreshadow:核验新增伏笔', '核验新增伏笔'],
    ['continuity:检查长期记忆', '检查长期记忆']
  ])('preserves the provider and review-stage labels: %s', (stage, expected) => {
    expect(generationProgressLabel(stage)).toBe(expected)
  })
})
