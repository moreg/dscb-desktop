import { safeHandle } from './safe-handle'
import { DiagnosticsService } from '../data/diagnostics-service'
import type { DiagnosticFixKind } from '../../shared/types'

export function registerDiagnosticsIpc(service: DiagnosticsService): void {
  safeHandle('diagnostics:report', (_e, projectId: string) => service.report(projectId))
  safeHandle('diagnostics:fix', (_e, projectId: string, kind: DiagnosticFixKind) =>
    service.applyFix(projectId, kind)
  )
}
