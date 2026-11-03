import { EventEmitter } from 'events'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chapterRequest } from '../src/main/ipc/chapter-request'
import { abortStream, activeStreamCount, clearAllStreams, pendingAbortCount } from '../src/main/data/stream-abort-registry'

afterEach(clearAllStreams)

describe('chapter request cancellation', () => {
  function event(destroyed = false) {
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
    return { sender, ipc: { sender } as unknown as IpcMainInvokeEvent }
  }

  it('aborts the model when its originating window closes and removes lifecycle listeners', async () => {
    const { sender, ipc } = event()
    await expect(chapterRequest(ipc, 'closing-window', async signal => {
      expect(signal.aborted).toBe(false)
      sender.emit('destroyed')
      expect(signal.aborted).toBe(true)
      throw new Error('LLM_ABORTED')
    })).rejects.toThrow('LLM_ABORTED')
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
  })

  it.each(['early-abort', 'destroyed-window'])('never starts work for %s', async reason => {
    const { sender, ipc } = event(reason === 'destroyed-window')
    if (reason === 'early-abort') abortStream(reason)
    const action = vi.fn(async () => 'unexpected')
    await expect(chapterRequest(ipc, reason, action)).rejects.toThrow('LLM_ABORTED')
    expect(action).not.toHaveBeenCalled()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
  })
})
