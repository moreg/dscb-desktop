import { BrowserWindow, dialog } from 'electron'
import type { ShortStoryStorage } from '../data/short-story-storage'
import type { ShortStoryStorageSelectionResult } from '../../shared/short-story'
import { safeHandle, safeSend } from './safe-handle'

export function registerShortStoryStorageIpc(storage: Pick<ShortStoryStorage, 'getLocation' | 'setLocation'>): void {
  safeHandle('shortStory:getStorageLocation', async () => storage.getLocation())
  safeHandle('shortStory:chooseStorageLocation', async (event): Promise<ShortStoryStorageSelectionResult> => {
    const current = await storage.getLocation()
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择中短篇作品保存位置',
      defaultPath: current,
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const selected = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0] || event.sender.isDestroyed()) return { canceled: true }
    const result = await storage.setLocation(selected.filePaths[0])
    for (const target of BrowserWindow.getAllWindows()) {
      safeSend(target, 'shortStory:storageLocationChanged', result.path)
    }
    return { canceled: false, ...result }
  })
}
