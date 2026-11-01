import { describe, expect, it, vi } from 'vitest'
import { createRendererApi } from '../src/preload/api'
import type { ProjectService } from '../src/main/data/project-service'

const { handlers, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  openPath: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  dialog: {}, shell: { openPath }
}))

import { registerLibraryIpc } from '../src/main/ipc/library'

describe('打开长篇作品文件夹', () => {
  it('通过作品 ID 找到对应目录，并向界面传递打开失败信息', async () => {
    const resolveDir = vi.fn().mockResolvedValue('D:\\books\\novel')
    registerLibraryIpc({ resolveDir } as unknown as ProjectService)
    const api = createRendererApi({
      invoke: (channel, ...args) => handlers.get(channel)!({}, ...args),
      on() {}, removeListener() {}
    })
    openPath.mockResolvedValueOnce('')
    await api.openProjectDirectory('book-1')
    expect(resolveDir).toHaveBeenCalledWith('book-1')
    expect(openPath).toHaveBeenCalledWith('D:\\books\\novel')
    openPath.mockResolvedValueOnce('目录不存在')
    await expect(api.openProjectDirectory('book-1')).rejects.toThrow('目录不存在')
    await expect(api.openProjectDirectory('')).rejects.toThrow()
  })
})
