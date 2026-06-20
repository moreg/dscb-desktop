import { safeHandle } from './safe-handle'
import { FigureService } from '../data/figure-service'

export function registerFigureIpc(service: FigureService): void {
  safeHandle('figure:list', (_e, projectId: string) => service.list(projectId))
  safeHandle('figure:read', (_e, projectId: string, fileName: string) =>
    service.read(projectId, fileName)
  )
  safeHandle('figure:open', (_e, projectId: string, fileName: string) =>
    service.open(projectId, fileName)
  )
}
