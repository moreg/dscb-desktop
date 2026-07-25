import { describe, it, expect, vi } from 'vitest'
import { safeSend } from '../src/main/ipc/safe-handle'

function mockWin(opts: {
  destroyed?: boolean
  wcDestroyed?: boolean
  send?: ReturnType<typeof vi.fn>
}): {
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
} {
  const send = opts.send ?? vi.fn()
  return {
    isDestroyed: () => Boolean(opts.destroyed),
    webContents: {
      isDestroyed: () => Boolean(opts.wcDestroyed),
      send
    }
  }
}

describe('safeSend', () => {
  it('sends when window and webContents are alive', () => {
    const send = vi.fn()
    const win = mockWin({ send })
    safeSend(win as never, 'llm:token', { token: 'a', done: false })
    expect(send).toHaveBeenCalledWith('llm:token', { token: 'a', done: false })
  })

  it('no-ops when win is null/undefined', () => {
    expect(() => safeSend(null, 'llm:token', {})).not.toThrow()
    expect(() => safeSend(undefined, 'llm:token', {})).not.toThrow()
  })

  it('no-ops when window is destroyed', () => {
    const send = vi.fn()
    const win = mockWin({ destroyed: true, send })
    safeSend(win as never, 'llm:token', { token: 'x' })
    expect(send).not.toHaveBeenCalled()
  })

  it('no-ops when webContents is destroyed', () => {
    const send = vi.fn()
    const win = mockWin({ wcDestroyed: true, send })
    safeSend(win as never, 'llm:token', { token: 'x' })
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows "Object has been destroyed" from send race', () => {
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })
    const win = mockWin({ send })
    expect(() => safeSend(win as never, 'llm:token', { token: 'x' })).not.toThrow()
    expect(send).toHaveBeenCalled()
  })
})
