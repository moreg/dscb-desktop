import { safeHandle } from './safe-handle'
import { DiagnosticsService } from '../data/diagnostics-service'

export function registerDiagnosticsIpc(service: DiagnosticsService): void {
  safeHandle('diagnostics:report', (_e, projectId: string) => service.report(projectId))
}
