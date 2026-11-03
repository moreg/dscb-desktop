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
  volumeNumber: z.number().int().positive().optional(),
  /** 只导出未导出过的章节（从未导出，或导出后正文又改过） */
  onlyUnexported: z.boolean().optional()
})

export function registerExportIpc(exportService: ExportService, projectService: ProjectService): void {
  safeHandle(
    'export:chapters',
    async (
      _e,
      payload: unknown
    ): Promise<{ canceled: boolean; path?: string }> => {
      const { projectId, volumeNumber, onlyUnexported } = validateInput(exportInputSchema, payload)
      const [built, data] = await Promise.all([
        exportService.buildExport(projectId, { volumeNumber, onlyUnexported }),
        projectService.getProjectData(projectId)
      ])
      const bookName = sanitizeTitle(data.name)
      const suffix =
        `${volumeNumber !== undefined ? `_第${volumeNumber}卷` : '_全本'}${onlyUnexported ? '_未导出' : ''}`
      const result = await dialog.showSaveDialog({
        title: '导出正文',
        defaultPath: `${bookName}${suffix}.txt`,
        filters: [{ name: 'Text', extensions: ['txt'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.writeFile(result.filePath, built.text, 'utf-8')
      try {
        // 标记只是增量导出的依据，写失败不影响本次已保存的文件
        await exportService.markExported(projectId, built.chapters)
      } catch (err) {
        console.warn('[export:chapters] Failed to mark exported chapters:', err)
      }
      return { canceled: false, path: result.filePath }
    }
  )
}
