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
})
