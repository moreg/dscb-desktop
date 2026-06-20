import { dialog, type IpcMainInvokeEvent } from 'electron'
import { safeHandle } from './safe-handle'
import { SettingsRepository } from '../data/settings-repository'
import type { ThemeMode, PricingConfig } from '../data/settings-repository'

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
      await repo.update({ projectsRoot: path })
      return path
    }
  )

  safeHandle('settings:getTheme', async (): Promise<ThemeMode> => {
    return repo.getTheme()
  })

  safeHandle(
    'settings:setTheme',
    async (_e: IpcMainInvokeEvent, theme: ThemeMode): Promise<ThemeMode> => {
      return repo.setTheme(theme)
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
      await repo.update({ dailyWordGoal: goal })
      return goal
    }
  )

  safeHandle(
    'settings:setPomodoro',
    async (
      _e: IpcMainInvokeEvent,
      cfg: { focus: number; brk: number }
    ): Promise<{ focus: number; brk: number }> => {
      await repo.update({ pomodoroFocus: cfg.focus, pomodoroBreak: cfg.brk })
      return cfg
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
