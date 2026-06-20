import { safeHandle } from './safe-handle'
import { ProjectService } from '../data/project-service'

/**
 * library:list 现在走 ProjectService.listProjects()，过滤掉非 v3.2 项目。
 * library:scan 扫描 projectsRoot 自动发现 v3.2 项目。
 */
export function registerLibraryIpc(service: ProjectService): void {
  safeHandle('library:list', async () => service.listProjects())
  safeHandle('library:scan', async () => service.scanProjects())
}
