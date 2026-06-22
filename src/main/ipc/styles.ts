import { z } from 'zod'
import { StyleProfileService } from '../data/style-profile-service'
import { ProjectService } from '../data/project-service'
import { safeHandle } from './safe-handle'
import { projectIdSchema, validateInput } from './validation'

const styleProfileIdSchema = z.string().min(1).max(255)
const styleSampleSchema = z.string().min(1).max(100_000)
const styleNameSchema = z.string().min(1).max(120)

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
  dos: z.array(z.string().min(1).max(500)).max(16),
  donts: z.array(z.string().min(1).max(500)).max(16),
  stylePrompt: z.string().min(1).max(10_000)
})

export function registerStyleIpc(
  styleService: StyleProfileService,
  projectService: ProjectService
): void {
  safeHandle('styles:list', async (_e, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    return styleService.list(validated)
  })

  safeHandle(
    'styles:create',
    async (_e, payload: { projectId: string; input: unknown }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          input: createStyleProfileSchema
        }),
        payload
      )
      return styleService.create(validated.projectId, validated.input)
    }
  )

  safeHandle(
    'styles:update',
    async (_e, payload: { projectId: string; styleProfileId: string; patch: unknown }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          styleProfileId: styleProfileIdSchema,
          patch: z.object({
            name: styleNameSchema.optional()
          })
        }),
        payload
      )
      return styleService.update(
        validated.projectId,
        validated.styleProfileId,
        validated.patch
      )
    }
  )

  safeHandle(
    'styles:delete',
    async (_e, payload: { projectId: string; styleProfileId: string }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
          styleProfileId: styleProfileIdSchema
        }),
        payload
      )
      return styleService.delete(validated.projectId, validated.styleProfileId)
    }
  )

  safeHandle(
    'styles:extract',
    async (_e, payload: { projectId: string; sampleText: string; name?: string }) => {
      const validated = validateInput(
        z.object({
          projectId: projectIdSchema,
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
}
