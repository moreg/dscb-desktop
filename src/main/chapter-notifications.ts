import { Notification, type BrowserWindow } from 'electron'
import type { SettingsRepository } from './data/settings-repository'

const active = new Set<Notification>()

/** Desktop-only callback; the web backend does not install it. Notification failure never fails writing. */
export async function notifyChapterCompleted(chapter: number, window: BrowserWindow | null,
  signal: AbortSignal, settings: SettingsRepository): Promise<void> {
  if (process.platform !== 'win32' || signal.aborted) return
  let notification: Notification | undefined
  try {
    if ((await settings.get()).chapterCompletionNotification !== true || signal.aborted || !Notification.isSupported()) return
    notification = new Notification({ title: '本轮续写完成', body: `第 ${chapter} 章本轮续写已完成，点击返回应用查看正文。` })
    const current = notification
    active.add(current)
    notification.on('click', () => {
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    notification.on('close', () => active.delete(current))
    notification.on('failed', () => { active.delete(current); console.warn('[chapter-notification] 系统通知未能显示') })
    notification.show()
  } catch {
    if (notification) active.delete(notification)
    console.warn('[chapter-notification] 系统通知不可用，续写结果已保留')
  }
}
