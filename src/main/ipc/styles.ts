import { z } from 'zod'
import { basename } from 'path'
import { dialog } from 'electron'
import { readFile } from 'fs/promises'
import { StyleProfileService } from '../data/style-profile-service'
import { ProjectService } from '../data/project-service'
import { safeHandle } from './safe-handle'
import { projectIdSchema, validateInput } from './validation'

const styleProfileIdSchema = z.string().min(1).max(255)
const styleSampleSchema = z.string().min(1).max(100_000)
const styleNameSchema = z.string().min(1).max(120)

const updateStyleProfileSchema = z
  .object({
    name: styleNameSchema.optional(),
    identifiedStyle: z.string().min(1).max(500).optional(),
    sentencePatterns: z.array(z.string().min(1).max(500)).max(16).optional(),
    vocabularyPreferences: z.array(z.string().min(1).max(500)).max(16).optional(),
    punctuationAndRhythm: z.array(z.string().min(1).max(500)).max(16).optional(),
    narrativePerspective: z.array(z.string().min(1).max(500)).max(16).optional(),
    tone: z.array(z.string().min(1).max(500)).max(16).optional(),
    narrativeTemplates: z.array(z.string().min(1).max(500)).max(16).optional(),
    styleConstraints: z.array(z.string().min(1).max(500)).max(16).optional(),
    characterConstraints: z.array(z.string().min(1).max(500)).max(16).optional(),
    plotConstraints: z.array(z.string().min(1).max(500)).max(16).optional(),
    stylePrompt: z.string().min(1).max(10_000).optional()
  })

const createStyleProfileSchema = z.object({
  name: styleNameSchema,
  sourceType: z.literal('sampleText'),
  sampleText: styleSampleSchema,
  identifiedStyle: z.string().min(1).max(500),
  sentencePatterns: z.array(z.string().min(1).max(500)).max(16),
  vocabularyPreferences: z.array(z.string().min(1).max(500)).max(16),
  punctuationAndRhythm: z.array(z.string().min(1).max(500)).max(16),
  narrativePerspective: z.array(z.string().min(1).max(500)).max(16),
  tone: z.array(z.string().min(1).max(500)).max(16),
  narrativeTemplates: z.array(z.string().min(1).max(500)).max(16),
  styleConstraints: z.array(z.string().min(1).max(500)).max(16),
  characterConstraints: z.array(z.string().min(1).max(500)).max(16),
  plotConstraints: z.array(z.string().min(1).max(500)).max(16),
  dos: z.array(z.string().min(1).max(500)).max(16).optional(),
  donts: z.array(z.string().min(1).max(500)).max(16).optional(),
  stylePrompt: z.string().min(1).max(10_000)
})

export function registerStyleIpc(
  styleService: StyleProfileService,
  projectService: ProjectService
): void {
  // 文风库是全局资产（同拆文库），增删改查一律不按项目隔离，故这四个通道不接受 projectId。
  safeHandle('styles:list', async () => styleService.list())

  safeHandle('styles:create', async (_e, payload: { input: unknown }) => {
    const validated = validateInput(z.object({ input: createStyleProfileSchema }), payload)
    return styleService.create(validated.input)
  })

  safeHandle(
    'styles:update',
    async (_e, payload: { styleProfileId: string; patch: unknown }) => {
      const validated = validateInput(
        z.object({
          styleProfileId: styleProfileIdSchema,
          patch: updateStyleProfileSchema
        }),
        payload
      )
      return styleService.update(validated.styleProfileId, validated.patch)
    }
  )

  safeHandle('styles:delete', async (_e, payload: { styleProfileId: string }) => {
    const validated = validateInput(
      z.object({ styleProfileId: styleProfileIdSchema }),
      payload
    )
    return styleService.delete(validated.styleProfileId)
  })

  // 唯一真正用到项目的通道：取项目名/题材写进提示词，并把用量记到该项目名下。
  safeHandle(
    'styles:extract',
    async (_e, payload: { projectId?: string; sampleText: string; name?: string }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema.optional(),
          sampleText: styleSampleSchema,
          name: styleNameSchema.optional()
        }),
        payload
      )
      return styleService.extract(validated.projectId, validated.sampleText, validated.name)
    }
  )

  safeHandle(
    'projects:setDefaultStyleProfile',
    async (_e, payload: { projectId: string; styleProfileId: string | null }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          styleProfileId: styleProfileIdSchema.nullable()
        }),
        payload
      )
      return projectService.updateProjectData(validated.projectId, {
        defaultStyleProfileId: validated.styleProfileId ?? undefined
      })
    }
  )

  safeHandle(
    'dialog:selectTextFile',
    async (): Promise<Array<{ content: string; fileName: string }> | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '文本文件', extensions: ['txt', 'md'] }],
        title: '选择样文文件'
      })
      if (result.canceled || result.filePaths.length === 0) return null

      try {
        const MAX_SIZE = 100_000
        let totalSize = 0
        const out = []
        for (const filePath of result.filePaths) {
          if (totalSize >= MAX_SIZE) break
          const content = await readFile(filePath, 'utf-8')
          const remain = MAX_SIZE - totalSize
          const truncated = content.length > remain ? content.slice(0, remain) : content
          totalSize += truncated.length
          out.push({
            content: truncated,
            fileName: basename(filePath)
          })
        }
        return out
      } catch (err) {
        console.error('[selectTextFile] Failed to read file:', err)
        throw new Error('文件读取失败，请确保文件是 UTF-8 编码的文本文件', { cause: err })
      }
    }
  )
}
