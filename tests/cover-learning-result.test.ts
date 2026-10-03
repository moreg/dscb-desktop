import { describe, expect, it } from 'vitest'
import { describeCoverLearningFeedback, describeCoverLearningPhase, describeCoverLearningResult } from '../src/renderer/src/CoverLearningLibraryPage'
import type { CoverLearningRunResult } from '../src/shared/types'

function result(patch: Partial<CoverLearningRunResult>): CoverLearningRunResult {
  return {
    directory: 'E:\\covers', scanned: 0, learned: 0, duplicates: 0, failed: 0,
    startedAt: '2026-10-02T01:00:00Z', completedAt: '2026-10-02T01:01:00Z', observations: [],
    summary: { directory: 'E:\\library', filePath: 'E:\\library\\cover-learning-library.json', status: 'ready', styleCount: 21, sampleCount: 138, categoryCount: 23, updatedAt: '', trackedSampleCount: 138, learningRunCount: 0 },
    ...patch
  }
}
describe('learning result feedback', () => {
  it('distinguishes an empty folder from existing duplicates', () => {
    expect(describeCoverLearningResult(result({}))).toContain('没有支持的图片')
    expect(describeCoverLearningResult(result({ scanned: 4, duplicates: 4 }))).toContain('4 张图片已在库中')
  })
  it('reports all failures, unreadable directory issues, and quality rejection without calling them duplicates', () => {
    expect(describeCoverLearningResult(result({ scanned: 3, failed: 3 }))).toContain('失败 3 项')
    expect(describeCoverLearningResult(result({ scanned: 0, failed: 1 }))).not.toContain('没有支持的图片')
    expect(describeCoverLearningResult(result({ scanned: 3, rejected: 3 }))).toContain('拒收 3 张')
  })
  it('identifies partial success and explains resumable cancellation', () => {
    expect(describeCoverLearningResult(result({ learned: 2, failed: 1 }))).toContain('请查看明细')
    const cancelled = describeCoverLearningResult(result({ learned: 2, cancelled: true }))
    expect(cancelled).toContain('学习已取消')
    expect(cancelled).toContain('2 张新样本')
    expect(cancelled).toContain('可继续')
    expect(cancelled).not.toContain('学习完成')
  })
  it('distinguishes successful local analysis from failed or unsupported AI refinement', () => {
    const failed = describeCoverLearningResult(result({ learned: 2, aiStatus: 'failed' }))
    expect(failed).toContain('本地学习完成')
    expect(failed).toContain('AI 汇总失败')
    expect(failed).toContain('未新增 AI 规则')
    expect(describeCoverLearningResult(result({ learned: 2, aiStatus: 'unsupported' }))).toContain('不支持看图')
    expect(describeCoverLearningResult(result({ learned: 2, aiStatus: 'skipped' }))).toContain('未执行')
  })
  it('reports AI re-analysis of existing samples without implying images were merely skipped', () => {
    const message = describeCoverLearningResult(result({ scanned: 4, duplicates: 4, aiStatus: 'completed' }))
    expect(message).toContain('已有样本并更新 AI 规则')
    expect(message).toContain('未重复新增样本')
    expect(message).not.toContain('已跳过重复样本')
    expect(describeCoverLearningResult(result({ scanned: 5, duplicates: 4, failed: 1, aiStatus: 'completed' }))).toContain('失败 1 项')
  })
  it('names the local summarizing stage without promising an AI call', () => {
    expect(describeCoverLearningPhase('summarizing')).toBe('汇总学习规则')
    expect(describeCoverLearningPhase('summarizing')).not.toContain('AI')
  })
  it('describes unrated feedback as revoked ratings rather than a count of all unreviewed covers', () => {
    const label = describeCoverLearningFeedback({ adopted: 3, rejected: 2, unrated: 1 })
    expect(label).toContain('已采用 3 张')
    expect(label).toContain('已拒绝 2 张')
    expect(label).toContain('已撤销评价 1 张')
    expect(label).not.toContain('未评价')
  })
})
