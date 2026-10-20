import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserWindow,
  configureShim,
  dialog,
  invokeTab,
  ipcMain,
  releaseTab,
  resetShimForTests,
  safeStorage,
  setDestroyGraceForTests,
  subscribeTab
} from '../src/web/electron-shim'

describe('web electron shim', () => {
  afterEach(() => {
    resetShimForTests()
  })

  it('round-trips provider secrets with the server data key', () => {
    process.env.WEB_DATA_KEY = 'test-key'
    const encrypted = safeStorage.encryptString('{"activeId":"p1"}')
    expect(safeStorage.decryptString(encrypted)).toBe('{"activeId":"p1"}')
    process.env.WEB_DATA_KEY = 'other-key'
    expect(() => safeStorage.decryptString(encrypted)).toThrow()
  })

  it('places save-dialog files inside the export directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dscb-shim-'))
    const exportsDir = join(root, 'exports')
    configureShim({ userData: root, exportsDir })
    const saved = await dialog.showSaveDialog(undefined, { defaultPath: '../书名.txt' })
    expect(saved.canceled).toBe(false)
    expect(saved.filePath?.startsWith(exportsDir + sep)).toBe(true)
    expect(saved.filePath).not.toContain('..')
  })

  it('delivers streamed events to the tab that invoked the channel', async () => {
    ipcMain.handle('demo:ping', (event) => {
      event.sender.send('demo:token', { text: '甲' })
      return 'pong'
    })
    const events: Array<{ channel: string; args: unknown[] }> = []
    const stop = subscribeTab('tababcdef12', (channel, args) => {
      events.push({ channel, args })
    })
    await expect(invokeTab('tababcdef12', 'demo:ping', [])).resolves.toBe('pong')
    expect(events).toEqual([{ channel: 'demo:token', args: [{ text: '甲' }] }])
    stop()
  })

  it('emits destroyed after the tab disconnects', async () => {
    let destroyed = false
    ipcMain.handle('demo:watch', (event) => {
      event.sender.once('destroyed', () => {
        destroyed = true
      })
      return true
    })
    setDestroyGraceForTests(20)
    const stop = subscribeTab('tabwatch001', () => {})
    await invokeTab('tabwatch001', 'demo:watch', [])
    const contentsId = BrowserWindow.getAllWindows()[0]?.webContents.id
    expect(contentsId).toBeTypeOf('number')
    stop()
    releaseTab('tabwatch001')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(destroyed).toBe(true)
  })
})
