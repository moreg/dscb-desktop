import { safeHandle } from './safe-handle'
import { OutlineService } from '../data/outline-service'

export function registerOutlineIpc(service: OutlineService): void {
  safeHandle('outline:getMain', (_e, projectId: string) => service.getMain(projectId))
  safeHandle('outline:generateMain', (_e, projectId: string) =>
    service.generateMain(projectId)
  )
  safeHandle('outline:listDetailed', (_e, projectId: string) =>
    service.listDetailed(projectId)
  )
  safeHandle('outline:generateDetailed', (_e, projectId: string, chapterNumber: number) =>
    service.generateDetailed(projectId, chapterNumber)
  )
}
