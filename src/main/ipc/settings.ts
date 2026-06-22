import { dialog, type IpcMainInvokeEvent } from 'electron'
import { safeHandle } from './safe-handle'
import { SettingsRepository } from '../data/settings-repository'
import type { ThemeMode, PricingConfig } from '../data/settings-repository'
import type { WriteAuditConfig } from '../../shared/types'
import { z } from 'zod'
import { validateInput, dailyWordGoalSchema } from './validation'

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
}
