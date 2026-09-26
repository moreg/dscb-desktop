import { describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../src/shared/types'

const { invoke, expose } = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(),
  expose: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

await import('../src/preload/index')
const api = expose.mock.calls[0][1] as RendererApi

describe('library preload archive channels', () => {
  it('listProjects sends includeArchived and defaults to an empty query', async () => {
    invoke.mockResolvedValueOnce([])
    await api.listProjects()
    expect(invoke).toHaveBeenCalledWith('library:list', {})
    invoke.mockResolvedValueOnce([])
    await api.listProjects({ includeArchived: true })
    expect(invoke).toHaveBeenCalledWith('library:list', { includeArchived: true })
  })

  it('setProjectArchived sends projectId and archived flag', async () => {
    invoke.mockResolvedValueOnce({ id: 'p1' })
    await api.setProjectArchived('p1', true)
    expect(invoke).toHaveBeenCalledWith('library:setArchived', { projectId: 'p1', archived: true })
  })
})
