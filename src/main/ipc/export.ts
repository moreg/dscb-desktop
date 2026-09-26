import { z } from 'zod'
import { dialog } from 'electron'
import { promises as fs } from 'fs'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema } from './validation'
import { ExportService } from '../data/export-service'
import { ProjectService } from '../data/project-service'
import { sanitizeTitle } from '../data/skill-format/prose-repo'

const exportInputSchema = z.object({
  projectId: projectIdSchema,
  /** 缺省导出全书，指定则只导出该卷 */
  volumeNumber: z.number().int().positive().optional()
})

export function registerExportIpc(exportService: ExportService, projectService: ProjectService): void {
  safeHandle(
    'export:chapters',
    async (
      _e,
      payload: unknown
    ): Promise<{ canceled: boolean; path?: string }> => {
      const { projectId, volumeNumber } = validateInput(exportInputSchema, payload)
      const [text, data] = await Promise.all([
        exportService.buildText(projectId, volumeNumber),
        projectService.getProjectData(projectId)
      ])
      const bookName = sanitizeTitle(data.name)
      const suffix = volumeNumber !== undefined ? `_第${volumeNumber}卷` : '_全本'
      const result = await dialog.showSaveDialog({
        title: '导出正文',
        defaultPath: `${bookName}${suffix}.txt`,
        filters: [{ name: 'Text', extensions: ['txt'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.writeFile(result.filePath, text, 'utf-8')
      return { canceled: false, path: result.filePath }
    }
  )
}
