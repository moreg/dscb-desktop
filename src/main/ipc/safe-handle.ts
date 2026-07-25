import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function safeHandle(
  channel: string,
  // IPC boundary: argument types are provided by each handler
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      // 仅记录 message + name，避免错误对象中可能包含的敏感字段（路径/token 片段等）泄漏到主进程日志
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(`[ipc:${channel}]`, message)
      // 抛出脱敏后的错误，避免原始 err.stack（含主进程绝对路径）经 IPC 序列化回传渲染进程
      throw new Error(message)
    }
  })
}

/**
 * 向渲染进程推送事件。窗口/webContents 已销毁时静默跳过，避免流式 onToken
 * 在用户关窗后抛出 "Object has been destroyed" 导致主进程 Uncaught Exception。
 */
export function safeSend(win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  const { webContents } = win
  if (!webContents || webContents.isDestroyed()) return
  try {
    webContents.send(channel, ...args)
  } catch (err) {
    // 竞态：isDestroyed 检查后、send 前对象被销毁
    const message = err instanceof Error ? err.message : String(err)
    if (!/destroyed/i.test(message)) {
      console.warn(`[safeSend:${channel}]`, message)
    }
  }
}
