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
      console.error(`[ipc:${channel}]`, err)
      throw err
    }
  })
}
