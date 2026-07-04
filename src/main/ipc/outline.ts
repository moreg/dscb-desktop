import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema, chapterNumberSchema } from './validation'
import { z } from 'zod'
import { OutlineService } from '../data/outline-service'
import type { MainOutline, DetailedOutlineItem } from '../../shared/types'

const detailedRangeSchema = z.object({
  projectId: projectIdSchema,
  fromChapter: chapterNumberSchema,
  count: z.number().int().min(1).max(30)
})

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
  safeHandle(
    'outline:updateDetailed',
    (_e, projectId: string, chapterNumber: number, patch: Partial<DetailedOutlineItem>) =>
      service.updateDetailed(projectId, chapterNumber, patch)
  )
  safeHandle('outline:generateDetailed', (_e, projectId: string, chapterNumber: number) =>
    service.generateDetailed(projectId, chapterNumber)
  )
  safeHandle('outline:generateDetailedRange', (_e, projectId: string, fromChapter: number, count: number) => {
    const validated = validateInput(detailedRangeSchema, { projectId, fromChapter, count })
    return service.generateDetailedRange(validated.projectId, validated.fromChapter, validated.count)
  })
  safeHandle('outline:getRhythm', (_e, projectId: string) => service.getRhythm(projectId))
  safeHandle('outline:getVolumes', (_e, projectId: string) => service.getVolumes(projectId))
  safeHandle('outline:getSections', (_e, projectId: string) => service.getOutlineSections(projectId))
  safeHandle('outline:getVolumeOutlines', (_e, projectId: string) => service.getVolumeOutlines(projectId))
}
