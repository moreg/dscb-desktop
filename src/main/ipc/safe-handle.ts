import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function safeHandle(
  channel: string,
  // IPC 边界：参数类型由各 handler 自行声明。any[] 是刻意的——unknown[] 会因逆变
  // 拒绝所有带具体参数类型的 handler。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      // 仅记录 message + name，避免错误对象中可能包含的敏感字段（路径/token 片段等）泄漏到主进程日志
      let message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      // 若底层网络请求抛出 TypeError: fetch failed，且包含更具体的 cause（如 ECONNREFUSED/ENOTFOUND/ETIMEDOUT 等），
      // 将 cause 详情附加上，避免关键网络诊断信息在 IPC 边界被吞掉
      if (
        err instanceof Error &&
        err.name === 'TypeError' &&
        err.message === 'fetch failed' &&
        'cause' in err &&
        err.cause
      ) {
        const cause = err.cause as { code?: string; message?: string }
        const causeDetail = cause.code || cause.message || String(err.cause)
        message = `TypeError: fetch failed (${causeDetail})`
      }
      console.error(`[ipc:${channel}]`, message)
      // 抛出脱敏后的错误，避免原始 err.stack（含主进程绝对路径）经 IPC 序列化回传渲染进程。
      // cause 仅存在于主进程侧（Electron invoke 拒绝只序列化 message），不会随 IPC 泄漏。
      throw new Error(message, { cause: err })
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
