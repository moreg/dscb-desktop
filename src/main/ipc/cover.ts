import { z } from 'zod'
import { CoverService } from '../data/cover-service'
import { SettingsRepository } from '../data/settings-repository'
import { safeHandle } from './safe-handle'
import { validateInput, projectIdSchema } from './validation'

const bookNameSchema = z.string().min(1).max(120)
const authorNameSchema = z.string().min(1).max(60)
const platformSchema = z.enum([
  'fanqie',
  'qidian',
  'jjwxc',
  'zhihu',
  'qimao',
  'ciweimao',
  'other'
])
const genreSchema = z.enum([
  'xianxia',
  'urban',
  'ancient_romance',
  'modern_romance',
  'mystery',
  'scifi',
  'western_fantasy',
  'historical',
  'supernatural',
  'light_novel'
])
const compositionSchema = z.enum(['closeup', 'fullbody', 'scene', 'duo'])

const generateCoverSchema = z.object({
  projectId: projectIdSchema,
  bookName: bookNameSchema,
  authorName: authorNameSchema,
  platform: platformSchema,
  genreOverride: genreSchema.optional(),
  composition: compositionSchema.optional(),
  styleHint: z.string().max(500).optional(),
  refImagePath: z.string().max(1000).optional()
})

const fileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('..') && !s.includes('/') && !s.includes('\\'), '非法文件名')

export function registerCoverIpc(
  coverService: CoverService,
  settings: SettingsRepository
): void {
  /* 生成封面 */
  safeHandle('cover:generate', async (_e, input: unknown) => {
    const validated = validateInput(generateCoverSchema, input)
    return coverService.generate(validated)
  })

  /* 列出项目封面 */
  safeHandle('cover:list', async (_e, projectId: string) => {
    const validated = validateInput(projectIdSchema, projectId)
    return coverService.list(validated)
  })

  /* 读取封面为 data URL */
  safeHandle('cover:read', async (_e, payload: { projectId: string; fileName: string }) => {
    const validated = validateInput(
      z.object({ projectId: projectIdSchema, fileName: fileNameSchema }),
      payload
    )
    return coverService.readAsDataURL(validated.projectId, validated.fileName)
  })

  /* 图像配置（脱敏） */
  safeHandle('cover:getConfig', async () => settings.getCoverImageConfigSummary())

  /* 保存图像配置 */
  safeHandle(
    'cover:setConfig',
    async (
      _e,
      payload: { apiKey?: string; baseUrl?: string; model?: string }
    ) => {
      const validated = validateInput(
        z.object({
          apiKey: z.string().min(1).max(1000).optional(),
          baseUrl: z
            .string()
            .max(2048)
            .refine((s) => /^https?:\/\//.test(s), 'baseUrl 必须以 http:// 或 https:// 开头')
            .optional(),
          model: z.string().min(1).max(100).optional()
        }),
        payload
      )
      return settings.setCoverImageConfig(validated)
    }
  )
}
