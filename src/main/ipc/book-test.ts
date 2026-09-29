import { z } from 'zod'
import { BookTestService } from '../data/book-test-service'
import { BOOK_TEST_BATCH_MAX, BOOK_TEST_STYLE_PRESETS } from '../../shared/book-test'
import { safeHandle } from './safe-handle'
import { projectIdSchema, validateInput } from './validation'

const stylePresetSchema = z.enum(BOOK_TEST_STYLE_PRESETS)
const candidateIdSchema = z.string().min(1).max(80)

export function registerBookTestIpc(bookTest: BookTestService): void {
  safeHandle('bookTest:get', async (_e, projectId: unknown) => {
    return bookTest.getState(validateInput(projectIdSchema, projectId))
  })

  safeHandle('bookTest:patch', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({
        projectId: projectIdSchema,
        authorName: z.string().max(60).optional(),
        stylePreset: stylePresetSchema.optional(),
        direction: z.string().max(200).optional()
      }),
      input
    )
    return bookTest.patchSettings(validated.projectId, validated)
  })

  safeHandle('bookTest:generateTitles', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({
        projectId: projectIdSchema,
        count: z.number().int().min(1).max(BOOK_TEST_BATCH_MAX),
        direction: z.string().max(200).optional(),
        authorName: z.string().max(60).optional(),
        stylePreset: stylePresetSchema.optional()
      }),
      input
    )
    return bookTest.generateTitles(validated.projectId, validated)
  })

  safeHandle('bookTest:replaceTitle', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({ projectId: projectIdSchema, id: candidateIdSchema }),
      input
    )
    return bookTest.replaceTitle(validated.projectId, validated.id)
  })

  safeHandle('bookTest:update', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({
        projectId: projectIdSchema,
        id: candidateIdSchema,
        title: z.string().max(40).optional(),
        hook: z.string().max(80).optional(),
        coverHint: z.string().max(200).optional(),
        kept: z.boolean().optional()
      }),
      input
    )
    return bookTest.updateCandidate(validated.projectId, validated.id, validated)
  })

  safeHandle('bookTest:delete', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({ projectId: projectIdSchema, id: candidateIdSchema }),
      input
    )
    return bookTest.deleteCandidate(validated.projectId, validated.id)
  })

  safeHandle('bookTest:generateCover', async (_e, input: unknown) => {
    const validated = validateInput(
      z.object({
        projectId: projectIdSchema,
        id: candidateIdSchema,
        authorName: z.string().max(60).optional()
      }),
      input
    )
    return bookTest.generateCover(validated.projectId, validated.id, validated.authorName)
  })
}
