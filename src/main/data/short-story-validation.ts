import { z } from 'zod'
import { shortStoryConfigError } from '../../shared/short-story'

export const shortStoryIdSchema = z.string().uuid()

const configFields = {
  title: z.string().trim().min(1).max(120),
  kind: z.enum(['short', 'medium']),
  genre: z.string().max(200),
  brief: z.string().max(10000),
  requirements: z.string().max(10000),
  targetWords: z.number().int().min(1000).max(120000),
  sectionCount: z.number().int().min(1).max(60)
}

export const shortStoryCreateSchema = z.object(configFields).superRefine((input, ctx) => {
  const error = shortStoryConfigError(input)
  if (error) ctx.addIssue({ code: 'custom', message: error })
})

export const shortStoryDocumentSchema = z.object({
  ...configFields,
  id: shortStoryIdSchema,
  revision: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  outline: z.string().max(100000),
  sections: z.array(z.object({
    number: z.number().int().min(1).max(60),
    title: z.string().max(120),
    content: z.string().max(40000)
  })).min(1).max(60),
  review: z.string().max(100000)
}).superRefine((input, ctx) => {
  const error = shortStoryConfigError(input)
  if (error) ctx.addIssue({ code: 'custom', message: error })
  if (input.sections.length !== input.sectionCount || input.sections.some((section, index) => section.number !== index + 1)) {
    ctx.addIssue({ code: 'custom', path: ['sections'], message: '分节数量与编号必须和设定一致' })
  }
  if (input.sections.reduce((sum, section) => sum + section.content.length, 0) > 300000) {
    ctx.addIssue({ code: 'custom', path: ['sections'], message: '正文合计最多 300000 字符' })
  }
})

export const shortStoryGenerationSchema = z.object({
  story: shortStoryDocumentSchema,
  task: z.enum(['outline', 'section', 'review', 'revise']),
  sectionNumber: z.number().int().min(1).max(60).optional(),
  instruction: z.string().max(10000).optional(),
  requestId: z.string().uuid()
}).superRefine((input, ctx) => {
  if (input.task !== 'revise') return
  if (!input.sectionNumber || input.sectionNumber > input.story.sectionCount) {
    ctx.addIssue({ code: 'custom', path: ['sectionNumber'], message: '请选择有效的修订分节序号' })
  } else if (!input.story.sections[input.sectionNumber - 1]?.content.trim()) {
    ctx.addIssue({ code: 'custom', path: ['sectionNumber'], message: '所选分节尚无正文，无法修订' })
  }
  if (input.story.sections.some(section => !section.content.trim())) {
    ctx.addIssue({ code: 'custom', path: ['story', 'sections'], message: '请完成所有节的正文后再根据完结检查修订' })
  }
  if (!input.story.review.trim()) {
    ctx.addIssue({ code: 'custom', path: ['story', 'review'], message: '请先生成并采用完结检查结果，再修订正文' })
  }
})
