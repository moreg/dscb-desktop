import { ipcMain, type IpcMainInvokeEvent } from 'electron'

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
