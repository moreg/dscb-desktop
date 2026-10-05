import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, showOpenDialog, fromWebContents, windows, getAllWindows } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(), fromWebContents: vi.fn(),
  windows: [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }],
  getAllWindows: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents, getAllWindows },
  dialog: { showOpenDialog }
}))
const { registerShortStoryStorageIpc } = await import('../src/main/ipc/short-story-storage')

describe('中短篇保存位置 IPC', () => {
  const event = { sender: { isDestroyed: () => false } }
  let getLocation: ReturnType<typeof vi.fn>
  let setLocation: ReturnType<typeof vi.fn>
  beforeEach(() => {
    handlers.clear()
    showOpenDialog.mockReset()
    fromWebContents.mockReset()
    getAllWindows.mockReset().mockReturnValue(windows)
    windows[0].webContents.send.mockClear()
    getLocation = vi.fn().mockResolvedValue('C:\\原目录')
    setLocation = vi.fn().mockResolvedValue({ path: 'D:\\作品', copiedCount: 3 })
    registerShortStoryStorageIpc({ getLocation, setLocation })
  })

  it('读取当前目录，并把当前路径交给系统文件夹选择器', async () => {
    const parent = windows[0]
    fromWebContents.mockReturnValue(parent)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\作品'] })
    expect(await handlers.get('shortStory:getStorageLocation')!(event)).toBe('C:\\原目录')
    expect(await handlers.get('shortStory:chooseStorageLocation')!(event)).toEqual({ canceled: false, path: 'D:\\作品', copiedCount: 3 })
    expect(showOpenDialog).toHaveBeenCalledWith(parent, expect.objectContaining({
      defaultPath: 'C:\\原目录', properties: ['openDirectory', 'createDirectory']
    }))
    expect(setLocation).toHaveBeenCalledWith('D:\\作品')
    expect(windows[0].webContents.send).toHaveBeenCalledWith('shortStory:storageLocationChanged', 'D:\\作品')
  })

  it('取消或空选择不会迁移、更新设置或广播', async () => {
    for (const result of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [] }]) {
      showOpenDialog.mockResolvedValue(result)
      expect(await handlers.get('shortStory:chooseStorageLocation')!(event)).toEqual({ canceled: true })
    }
    expect(setLocation).not.toHaveBeenCalled()
    expect(windows[0].webContents.send).not.toHaveBeenCalled()
  })

  it('没有所属窗口时仍可打开文件夹选择器', async () => {
    fromWebContents.mockReturnValue(null)
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await handlers.get('shortStory:chooseStorageLocation')!(event)
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '选择中短篇作品保存位置' }))
  })

  it('窗口关闭后的选择不会修改保存位置', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\作品'] })
    expect(await handlers.get('shortStory:chooseStorageLocation')!({ sender: { isDestroyed: () => true } })).toEqual({ canceled: true })
    expect(setLocation).not.toHaveBeenCalled()
  })

  it('迁移失败时向页面报错，其他窗口不收到成功通知', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\作品'] })
    setLocation.mockRejectedValue(new Error('目标目录有冲突作品'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(handlers.get('shortStory:chooseStorageLocation')!(event)).rejects.toThrow('目标目录有冲突作品')
    expect(windows[0].webContents.send).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('成功通知所有仍打开的窗口，忽略已销毁窗口', async () => {
    const another = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
    const destroyed = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: vi.fn() } }
    getAllWindows.mockReturnValue([...windows, another, destroyed])
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:\\作品'] })
    await handlers.get('shortStory:chooseStorageLocation')!(event)
    expect(another.webContents.send).toHaveBeenCalledWith('shortStory:storageLocationChanged', 'D:\\作品')
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
  })
})
