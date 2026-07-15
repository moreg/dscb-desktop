import { TrackingMdRepo } from '../data/skill-format/tracking-md-repo'
import { ForeshadowingMdRepo } from '../data/skill-format/foreshadowing-md-repo'
import { safeHandle } from './safe-handle'
import type { TrackingView } from '../../shared/types'
import type { ProjectService } from '../data/project-service'

/**
 * 追踪 IPC：读取 `追踪/` 目录的聚合展示数据。
 * 供 TrackingPage 渲染角色状态 / 时间线 / 进度 / 问题 / 伏笔统计。
 */
export function registerTrackingIpc(projectService: ProjectService): void {
  safeHandle('tracking:read', async (_e, pid: string): Promise<TrackingView | null> => {
    const dir = await projectService.resolveDir(pid)

    const tracking = await new TrackingMdRepo(dir).readForDisplay()
    if (!tracking) return null

    // 伏笔统计（来自 追踪/伏笔.md）
    let foreshadowingSummary = {
      total: 0,
      pending: 0,
      planted: 0,
      collected: 0,
      missed: 0
    }
    try {
      const list = await new ForeshadowingMdRepo(dir).list()
      foreshadowingSummary = {
        total: list.length,
        pending: list.filter((f) => f.status === 'pending').length,
        planted: list.filter((f) => f.status === 'planted').length,
        collected: list.filter((f) => f.status === 'collected').length,
        missed: list.filter((f) => f.status === 'missed').length
      }
    } catch (err) {
      console.warn('[tracking:read] Failed to load foreshadowing summary:', err)
    }

    return {
      characterStates: tracking.characterStates,
      stateChanges: tracking.stateChanges,
      timeline: tracking.timeline,
      recentProgress: tracking.recentProgress,
      openIssues: tracking.openIssues,
      allIssues: tracking.allIssues,
      foreshadowingSummary
    }
  })
}
