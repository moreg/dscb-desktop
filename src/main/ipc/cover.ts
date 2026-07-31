import { z } from 'zod'
import { dialog } from 'electron'
import { CoverService } from '../data/cover-service'
import { CoverPromptService } from '../data/cover-prompt-service'
import { SettingsRepository } from '../data/settings-repository'
import { CoverLearningLibraryService } from '../data/cover-learning-library'
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
const stylePresetSchema = z.enum([
  'auto',
  'fanqie_impact',
  'ancient_romance',
  'ink_minimal',
  'dark_suspense',
  'urban_cinematic',
  'anime_light',
  'retro_period',
  'epic_fantasy',
  'concept_symbol',
  'glamour_romance',
  'cute_doodle',
  'warm_period_life',
  'rural_healing',
  'male_power_type',
  'folk_horror',
  'war_spy_epic',
  'game_neon',
  'western_adventure',
  'minimal_typographic'
])
const typographySchema = z.object({
  titleFont: z.enum(['auto', 'impact', 'brush', 'elegant', 'modern', 'suspense', 'anime', 'retro']).optional(),
  titlePosition: z.enum(['auto', 'top', 'center', 'lower_third', 'vertical_left', 'vertical_right']).optional(),
  titleEffect: z.enum(['auto', 'flat', 'outline_shadow', 'metallic', 'ink', 'glow', 'embossed']).optional(),
  authorFont: z.enum(['auto', 'sans', 'serif', 'seal', 'handwritten', 'metallic']).optional(),
  authorPosition: z.enum(['auto', 'bottom_center', 'bottom_right', 'vertical_side']).optional()
})

const generateCoverSchema = z.object({
  projectId: projectIdSchema,
  bookName: bookNameSchema,
  authorName: authorNameSchema,
  platform: platformSchema,
  genreOverride: genreSchema.optional(),
  composition: compositionSchema.optional(),
  stylePreset: stylePresetSchema.optional(),
  typography: typographySchema.optional(),
  styleHint: z.string().max(500).optional(),
  // 手改后的整段提示词。8000 字符远超模板拼装长度，又低于图像 API 的上限
  promptOverride: z.string().max(8000).optional(),
  refImagePath: z.string().max(1000).optional()
})

const extractCoverPromptSchema = z.object({
  projectId: projectIdSchema,
  bookName: bookNameSchema,
  authorName: authorNameSchema,
  platform: platformSchema,
  genreOverride: genreSchema.optional(),
  compositionOverride: compositionSchema.optional(),
  stylePreset: stylePresetSchema.optional(),
  typography: typographySchema.optional(),
  extraHint: z.string().max(500).optional()
})

const fileNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes('..') && !s.includes('/') && !s.includes('\\'), '非法文件名')

export function registerCoverIpc(
  coverService: CoverService,
  settings: SettingsRepository,
  coverPromptService: CoverPromptService,
  learningLibrary: CoverLearningLibraryService
): void {
  /* 从小说内容提炼封面提示词（只调文本模型，不出图） */
  safeHandle('cover:extractPrompt', async (_e, input: unknown) => {
    const validated = validateInput(extractCoverPromptSchema, input)
    return coverPromptService.extract(validated)
  })

  /* 按模板拼一份提示词（纯函数，不调任何 API）——给编辑框填初值 / 重置用 */
  safeHandle('cover:buildPrompt', async (_e, input: unknown) => {
    const validated = validateInput(generateCoverSchema, input)
    // 重置的语义就是丢掉手改，所以这里显式忽略 promptOverride
    return coverService.resolvePromptWithLibrary({ ...validated, promptOverride: undefined })
  })

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

  safeHandle('cover:getLearningLibrary', async () => learningLibrary.initialize())

  safeHandle('cover:setLearningLibraryDirectory', async (_e, directory: unknown) => {
    const validated = validateInput(
      z.string().trim().min(1).max(2000).refine((value) => /^[a-zA-Z]:[\\/]|^\\\\/.test(value), '学习库必须使用本地绝对路径'),
      directory
    )
    return learningLibrary.setDirectory(validated)
  })

  safeHandle('cover:chooseLearningLibraryDirectory', async () => {
    const current = await learningLibrary.initialize()
    const result = await dialog.showOpenDialog({
      title: '选择封面学习库保存位置',
      defaultPath: current.directory,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return learningLibrary.setDirectory(result.filePaths[0])
  })

  safeHandle('cover:chooseAndLearnFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要学习的封面文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return learningLibrary.learnFolder(result.filePaths[0])
  })
}
