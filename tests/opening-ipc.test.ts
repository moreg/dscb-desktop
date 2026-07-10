import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
const sendMock = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    fromWebContents: () => ({
      webContents: {
        send: sendMock
      }
    })
  }
}))

const { registerOpeningIpc } = await import('../src/main/ipc/opening')

describe('registerOpeningIpc streaming protocol', () => {
  beforeEach(() => {
    handlers.clear()
    sendMock.mockClear()
  })

  it('echoes requestId on opening stream tokens', async () => {
    const service = {
      generateCoreSettings: async (
        _projectId: string,
        _brainDump: string,
        opts: { onToken?: (token: string) => void }
      ) => {
        opts.onToken?.('hello')
        opts.onToken?.(' world')
        return 'hello world'
      }
    }

    registerOpeningIpc(service as never)

    const handler = handlers.get('opening:coreSettings')
    expect(handler).toBeDefined()

    const result = await handler!(
      { sender: {} },
      { projectId: 'p1', brainDump: 'idea', requestId: 'req-opening-1' }
    )

    expect(result).toEqual({ ok: true, markdown: 'hello world' })
    expect(sendMock).toHaveBeenCalledWith('opening:token', {
      requestId: 'req-opening-1',
      token: 'hello',
      done: false
    })
    expect(sendMock).toHaveBeenCalledWith('opening:token', {
      requestId: 'req-opening-1',
      token: ' world',
      done: false
    })
    expect(sendMock).toHaveBeenCalledWith('opening:token', {
      requestId: 'req-opening-1',
      token: '',
      done: true
    })
  })

  it('echoes requestId on opening:continueCoreSettings stream tokens', async () => {
    const service = {
      continueCoreSettings: async (
        _projectId: string,
        _brainDump: string,
        _partial: string,
        opts: { onToken?: (token: string) => void }
      ) => {
        opts.onToken?.('continue')
        return 'continue markdown'
      }
    }

    registerOpeningIpc(service as never)

    const handler = handlers.get('opening:continueCoreSettings')
    expect(handler).toBeDefined()

    const result = await handler!(
      { sender: {} },
      {
        projectId: 'p1',
        brainDump: 'idea',
        partial: 'partial-output',
        requestId: 'req-opening-continue'
      }
    )

    expect(result).toEqual({ ok: true, markdown: 'continue markdown' })
    expect(sendMock).toHaveBeenCalledWith('opening:token', {
      requestId: 'req-opening-continue',
      token: 'continue',
      done: false
    })
    expect(sendMock).toHaveBeenCalledWith('opening:token', {
      requestId: 'req-opening-continue',
      token: '',
      done: true
    })
  })

  it('opening:persist forwards chaptersMd and fromChapter to service', async () => {
    const service = {
      persistOpening: vi.fn().mockResolvedValue({
        settingsFile: '设定/题材定位.md',
        outlineFile: '大纲/大纲.md',
        chapterFiles: ['细纲/细纲_第001章_测试.md']
      })
    }

    registerOpeningIpc(service as never)

    const handler = handlers.get('opening:persist')
    expect(handler).toBeDefined()

    const result = await handler!({ sender: {} } as never, {
      projectId: 'p1',
      coreSettings: '核心设定',
      volumeOutline: '卷级大纲',
      chaptersMd: '=== 第1章 ===\n## 第 1 章：测试',
      fromChapter: 1
    })

    expect(service.persistOpening).toHaveBeenCalledWith(
      'p1',
      '核心设定',
      '卷级大纲',
      '=== 第1章 ===\n## 第 1 章：测试',
      1
    )
    expect(result).toEqual({
      settingsFile: '设定/题材定位.md',
      outlineFile: '大纲/大纲.md',
      chapterFiles: ['细纲/细纲_第001章_测试.md']
    })
  })

  it('opening:persist works without chaptersMd (settings+outline only)', async () => {
    const service = {
      persistOpening: vi.fn().mockResolvedValue({
        settingsFile: '设定/题材定位.md',
        outlineFile: '大纲/大纲.md',
        chapterFiles: []
      })
    }

    registerOpeningIpc(service as never)

    const handler = handlers.get('opening:persist')
    const result = await handler!({ sender: {} } as never, {
      projectId: 'p1',
      coreSettings: '设定',
      volumeOutline: '大纲'
    })

    expect(service.persistOpening).toHaveBeenCalledWith('p1', '设定', '大纲', undefined, undefined)
    expect(result.chapterFiles).toEqual([])
  })
})
