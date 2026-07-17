import { dialog, type IpcMainInvokeEvent } from 'electron'
import { safeHandle } from './safe-handle'
import { SettingsRepository } from '../data/settings-repository'
import type { ThemeMode, PricingConfig } from '../data/settings-repository'
import type { WriteAuditConfig } from '../../shared/types'
import { z } from 'zod'
import { validateInput, dailyWordGoalSchema } from './validation'
import type { AiHighFreqConfig } from '../../shared/types'
import type { WritingRequirementTemplate } from '../../shared/writing-requirement-templates'
import {
  CHAPTER_RULE_SECTIONS,
  REVIEW_CHECK_SECTIONS,
  REVIEW_CHECK_KEYS
} from '../data/skill-prompts'
import type { ReviewCheckId, ReviewRulesConfig } from '../../shared/types'

export function registerSettingsIpc(
  repo: SettingsRepository,
  defaultProjectsRoot: string
): void {
  safeHandle('settings:getProjectsRoot', async (): Promise<string> => {
    return repo.getProjectsRoot(defaultProjectsRoot)
  })

  safeHandle(
    'settings:setProjectsRoot',
    async (_e: IpcMainInvokeEvent, path: string): Promise<string> => {
      const validatedPath = validateInput(z.string().min(1).max(1000), path)
      await repo.update({ projectsRoot: validatedPath })
      return validatedPath
    }
  )

  safeHandle('settings:getTheme', async (): Promise<ThemeMode> => {
    return repo.getTheme()
  })

  safeHandle(
    'settings:setTheme',
    async (_e: IpcMainInvokeEvent, theme: ThemeMode): Promise<ThemeMode> => {
      const validatedTheme = validateInput(z.enum(['light', 'dark', 'system']), theme)
      return repo.setTheme(validatedTheme)
    }
  )

  safeHandle('settings:getAll', async () => {
    return repo.get()
  })

  safeHandle(
    'settings:setPricing',
    async (_e: IpcMainInvokeEvent, patch: Partial<PricingConfig>): Promise<PricingConfig> => {
      await repo.update({ pricing: patch })
      return repo.getPricing()
    }
  )

  safeHandle(
    'settings:setDailyGoal',
    async (_e: IpcMainInvokeEvent, goal: number): Promise<number> => {
      const validatedGoal = validateInput(dailyWordGoalSchema, goal)
      await repo.update({ dailyWordGoal: validatedGoal })
      return validatedGoal
    }
  )

  safeHandle(
    'settings:setPomodoro',
    async (
      _e: IpcMainInvokeEvent,
      cfg: { focus: number; brk: number }
    ): Promise<{ focus: number; brk: number }> => {
      const validated = validateInput(
        z.object({
          focus: z.number().int().min(1).max(120),
          brk: z.number().int().min(1).max(60)
        }),
        cfg
      )
      await repo.update({ pomodoroFocus: validated.focus, pomodoroBreak: validated.brk })
      return validated
    }
  )

  safeHandle(
    'settings:setWriteAudit',
    async (
      _e: IpcMainInvokeEvent,
      patch: Partial<WriteAuditConfig>
    ): Promise<WriteAuditConfig> => {
      return repo.setWriteAudit(patch)
    }
  )

  safeHandle('settings:getSettingsEvolution', async () => {
    const all = await repo.get()
    return all.settingsEvolution ?? 'auto_high'
  })
  safeHandle(
    'settings:setSettingsEvolution',
    async (
      _e: IpcMainInvokeEvent,
      mode: 'off' | 'confirm_all' | 'auto_high'
    ): Promise<'off' | 'confirm_all' | 'auto_high'> => {
      const m =
        mode === 'off' || mode === 'confirm_all' || mode === 'auto_high' ? mode : 'auto_high'
      await repo.update({ settingsEvolution: m })
      return m
    }
  )

  // P13-C：用量预警配置
  safeHandle('settings:getCostAlert', async () => {
    return repo.getCostAlert()
  })
  safeHandle(
    'settings:setCostAlert',
    async (
      _e: IpcMainInvokeEvent,
      patch: Partial<{ enabled: boolean; warning: number; exceeded: number }>
    ): Promise<{ enabled: boolean; warning: number; exceeded: number }> => {
      const validated = validateInput(
        z.object({
          enabled: z.boolean().optional(),
          warning: z.number().min(0).max(1_000_000).optional(),
          exceeded: z.number().min(0).max(10_000_000).optional()
        }),
        patch
      )
      return repo.setCostAlert(validated)
    }
  )

  safeHandle('dialog:selectDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择书籍保存位置'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /** AI 高频词配置 */
  safeHandle('settings:getAiHighFreq', async () => {
    return repo.getAiHighFreq()
  })
  safeHandle(
    'settings:setAiHighFreq',
    async (_e: IpcMainInvokeEvent, patch: Partial<AiHighFreqConfig>): Promise<AiHighFreqConfig> => {
      const validated = validateInput(
        z.object({
          enabled: z.boolean().optional(),
          words: z
            .array(
              z.object({
                word: z.string().min(1).max(100),
                example: z.string().max(500).optional()
              })
            )
            .max(200)
            .optional()
        }),
        patch
      )
      return repo.setAiHighFreq(validated)
    }
  )

  safeHandle('settings:getWritingRequirementTemplates', async () => {
    return repo.getWritingRequirementTemplates()
  })
  safeHandle(
    'settings:setWritingRequirementTemplates',
    async (
      _e: IpcMainInvokeEvent,
      templates: WritingRequirementTemplate[]
    ): Promise<WritingRequirementTemplate[]> => {
      const validated = validateInput(
        z
          .array(
            z.object({
              id: z.string().min(1).max(100),
              name: z.string().min(1).max(100),
              description: z.string().max(300),
              requirements: z.array(z.string().min(1).max(300)).max(100)
            })
          )
          .max(100),
        templates
      )
      return repo.setWritingRequirementTemplates(validated)
    }
  )

  /** 续写规则分节：读取可编辑小节（标题 + 默认正文）与当前覆盖 */
  safeHandle('settings:getChapterRules', async () => {
    const overrides = await repo.getChapterRuleOverrides()
    return {
      sections: CHAPTER_RULE_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        defaultText: s.text
      })),
      overrides
    }
  })
  safeHandle(
    'settings:setChapterRules',
    async (
      _e: IpcMainInvokeEvent,
      overrides: Record<string, string>
    ): Promise<Record<string, string>> => {
      const validated = validateInput(z.record(z.string(), z.string()), overrides)
      return repo.setChapterRuleOverrides(validated)
    }
  )

  /** 审稿规则：读取检查项清单（内置应用元数据覆盖 + 自定义）+ 当前配置 */
  safeHandle('settings:getReviewRules', async () => {
    const config = await repo.getReviewRules()
    const hidden = new Set(config.hiddenBuiltin ?? [])
    const meta = config.builtinMeta ?? {}
    const builtinSections = REVIEW_CHECK_SECTIONS.filter((s) => !hidden.has(s.checkId)).map(
      (s) => {
        const m = meta[s.checkId]
        return {
          checkId: s.checkId,
          kind: s.kind,
          group: s.group,
          label: m?.label ?? s.label,
          defaultSeverity: m?.severity ?? s.defaultSeverity,
          hint: m?.hint ?? s.hint,
          isCustom: false as const
        }
      }
    )
    const customSections = (config.customChecks ?? []).map((c) => ({
      checkId: c.id,
      kind: c.type === 'llm' ? ('llm' as const) : ('algorithm' as const),
      group: c.group,
      label: c.label,
      defaultSeverity: c.severity,
      hint: c.hint,
      isCustom: true as const,
      customType: c.type,
      keywords: c.keywords,
      pattern: c.pattern,
      prompt: c.prompt
    }))
    const hiddenSections = REVIEW_CHECK_SECTIONS.filter((s) => hidden.has(s.checkId)).map((s) => ({
      checkId: s.checkId,
      label: meta[s.checkId]?.label ?? s.label
    }))
    return {
      sections: [...builtinSections, ...customSections],
      hiddenSections,
      config
    }
  })

  /** 保存审稿规则配置（开关/阈值/词表/自定义项/元数据/软删除） */
  safeHandle('settings:setReviewRules', async (_e, patch) => {
    const checkIdEnum = z.custom<ReviewCheckId>(
      (v): v is ReviewCheckId => typeof v === 'string' && REVIEW_CHECK_KEYS.has(v as ReviewCheckId),
      '非法 checkId'
    )
    const validated = validateInput(
      z.object({
        enabled: z.boolean().optional(),
        autoDeepReview: z.boolean().optional(),
        // checks key 放宽为 string（含 custom_ 前缀），repo 层用运行时白名单清洗
        checks: z.record(z.string(), z.boolean()).optional(),
        thresholds: z
          .object({
            minWords: z.number().int().min(1).max(100000).optional(),
            maxWords: z.number().int().min(1).max(100000).optional(),
            maxParagraphLen: z.number().int().min(1).max(10000).optional(),
            dashDensityPer100: z.number().min(0).max(100).optional(),
            repetitionLen: z.number().int().min(1).max(1000).optional(),
            maxSentenceLen: z.number().int().min(1).max(10000).optional()
          })
          .optional(),
        wordLists: z
          .object({
            metaBreak: z.array(z.string().max(100)).max(1000).optional(),
            sensitive: z.array(z.string().max(100)).max(1000).optional()
          })
          .optional(),
        builtinMeta: z
          .record(
            checkIdEnum,
            z.object({
              label: z.string().max(100).optional(),
              hint: z.string().max(300).optional(),
              severity: z.enum(['error', 'warn', 'info']).optional()
            })
          )
          .optional(),
        hiddenBuiltin: z.array(checkIdEnum).max(50).optional(),
        customChecks: z
          .array(
            z.object({
              id: z.string().min(1).max(60),
              label: z.string().min(1).max(100),
              hint: z.string().max(300),
              severity: z.enum(['error', 'warn', 'info']),
              type: z.enum(['keyword', 'regex', 'llm']),
              group: z.string().min(1).max(40),
              keywords: z.array(z.string().max(100)).max(500).optional(),
              pattern: z.string().max(500).optional(),
              prompt: z.string().max(2000).optional(),
              enabled: z.boolean()
            })
          )
          .max(50)
          .optional()
      }),
      patch
    )
    // zod schema 字段全 optional（深度 partial），运行时 repo.setReviewRules 会用默认值
    // 填充缺失的 thresholds/wordLists 字段。zod 默认 strip 未知键，此处断言桥接类型。
    const rules = validated as Partial<ReviewRulesConfig>
    return repo.setReviewRules(rules)
  })
}
