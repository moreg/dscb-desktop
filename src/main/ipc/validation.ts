import { z } from 'zod'

/**
 * IPC 输入验证模式。
 * 所有从渲染进程传入的数据都必须经过这些模式验证。
 */

// 项目相关
export const projectIdSchema = z.string().min(1).max(255)
export const projectNameSchema = z.string().min(1).max(255)

// 章节相关
export const chapterNumberSchema = z.number().int().positive()
export const chapterContentSchema = z.string().max(500_000) // 合理上限

// 草稿操作
export const saveDraftInputSchema = z.object({
  projectId: projectIdSchema,
  chapterNumber: chapterNumberSchema,
  content: chapterContentSchema
})

export const readDraftInputSchema = z.object({
  projectId: projectIdSchema,
  chapterNumber: chapterNumberSchema
})

// 章节操作
export const listChaptersInputSchema = z.object({
  projectId: projectIdSchema
})

export const getChapterInputSchema = z.object({
  projectId: projectIdSchema,
  chapterNumber: chapterNumberSchema
})

export const updateContentInputSchema = z.object({
  projectId: projectIdSchema,
  chapterNumber: chapterNumberSchema,
  content: chapterContentSchema
})

// LLM 提供商相关
export const providerIdSchema = z.string().min(1).max(100)
export const baseUrlSchema = z.string().url().max(2048)
export const apiKeySchema = z.string().max(1000)
export const modelSchema = z.string().min(1).max(255)
export const labelSchema = z.string().min(1).max(100)

// 设置相关
export const dailyWordGoalSchema = z.number().int().min(0).max(100_000)

// 验证辅助函数
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`IPC_INPUT_INVALID: ${err.errors.map(e => e.path.join('.') + ': ' + e.message).join(', ')}`)
    }
    throw err
  }
}
