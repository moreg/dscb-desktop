import { safeHandle } from './safe-handle'
import { OutlineService } from '../data/outline-service'
import type { MainOutline } from '../../shared/types'

export function registerOutlineIpc(service: OutlineService): void {
  safeHandle('outline:getMain', (_e, projectId: string) => service.getMain(projectId))
  safeHandle('outline:updateMain', (_e, projectId: string, patch: Partial<MainOutline>) =>
    service.updateMain(projectId, patch)
  )
  safeHandle('outline:generateMain', (_e, projectId: string) =>
    service.generateMain(projectId)
  )
  safeHandle('outline:listDetailed', (_e, projectId: string) =>
    service.listDetailed(projectId)
  )
  safeHandle('outline:generateDetailed', (_e, projectId: string, chapterNumber: number) =>
    service.generateDetailed(projectId, chapterNumber)
  )
  safeHandle('outline:getRhythm', (_e, projectId: string) => service.getRhythm(projectId))
  safeHandle('outline:getVolumes', (_e, projectId: string) => service.getVolumes(projectId))
  safeHandle('outline:getSections', (_e, projectId: string) => service.getOutlineSections(projectId))
}
