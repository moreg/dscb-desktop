import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectService } from '../src/main/data/project-service'

const { handlers, instances } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  instances: [] as { projectId: string | null; starts: [string, string][]; stops: number }[]
}))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }))
vi.mock('../src/main/ipc/safe-handle', () => ({
  safeHandle: (name: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => handlers.set(name, handler)
}))
vi.mock('../src/main/data/project-file-watcher', () => ({
  ProjectFileWatcher: class {
    state = { projectId: null as string | null, starts: [] as [string, string][], stops: 0 }
    constructor() { instances.push(this.state) }
    watchingProjectId() { return this.state.projectId }
    watchProject(id: string, path: string) { this.state.projectId = id; this.state.starts.push([id, path]) }
    stopWatching() { this.state.projectId = null; this.state.stops++ }
    dispose() { this.stopWatching() }
  }
}))
import { registerProjectsIpc } from '../src/main/ipc/projects'

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id, destroyed: false, isDestroyed() { return this.destroyed } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('保存期间释放并恢复项目监听', () => {
  let dispose: () => void
  let path: string
  let service: { resolveDir: ReturnType<typeof vi.fn>; updateProjectInfo: ReturnType<typeof vi.fn> }
  const invoke = (name: string, target: ReturnType<typeof sender>, payload?: unknown) => handlers.get(name)!({ sender: target }, payload)
  beforeEach(() => {
    handlers.clear(); instances.length = 0; path = 'old'
    service = { resolveDir: vi.fn(async (id: string) => id === 'book-b' ? 'other-book' : path),
      updateProjectInfo: vi.fn(async () => ({ name: '新书名' })) }
    dispose = registerProjectsIpc(service as unknown as ProjectService)
  })
  afterEach(() => dispose())

  it('释放所有窗口的旧监听，保存期间的新订阅等待完成后才监听新目录', async () => {
    const first = sender(1), second = sender(2), third = sender(3)
    await invoke('projects:watch', first, 'book-a')
    await invoke('projects:watch', second, 'book-a')
    const saving = deferred<{ name: string }>()
    service.updateProjectInfo.mockReturnValue(saving.promise)
    const update = invoke('projects:updateInfo', first, { projectId: 'book-a', name: '新书名' })
    await vi.waitFor(() => expect(service.updateProjectInfo).toHaveBeenCalledOnce())
    expect(instances.every(item => item.projectId === null)).toBe(true)
    await invoke('projects:watch', third, 'book-a')
    expect(instances[2].starts).toEqual([])
    path = 'new'; saving.resolve({ name: '新书名' }); await update
    expect(instances.map(item => item.starts.at(-1))).toEqual([
      ['book-a', 'new'], ['book-a', 'new'], ['book-a', 'new']
    ])
  })

  it('保存期间切换、停止或销毁窗口，完成后不重启旧订阅', async () => {
    const first = sender(1), second = sender(2), third = sender(3)
    for (const target of [first, second, third]) await invoke('projects:watch', target, 'book-a')
    const saving = deferred<{ name: string }>()
    service.updateProjectInfo.mockReturnValue(saving.promise)
    const update = invoke('projects:updateInfo', first, { projectId: 'book-a', name: '新书名' })
    await vi.waitFor(() => expect(service.updateProjectInfo).toHaveBeenCalledOnce())
    await invoke('projects:watch', first, 'book-b')
    await invoke('projects:stopWatch', second)
    third.destroyed = true; third.emit('destroyed')
    path = 'new'; saving.resolve({ name: '新书名' }); await update
    expect(instances.map(item => item.projectId)).toEqual(['book-b', null, null])
    expect(instances[0].starts.at(-1)).toEqual(['book-b', 'other-book'])
    expect(instances[1].starts).toHaveLength(1)
    expect(instances[2].starts).toHaveLength(1)
  })

  it('保存失败恢复原目录监听，同时把原始错误传回', async () => {
    const target = sender(1)
    await invoke('projects:watch', target, 'book-a')
    const error = new Error('Code.exe 仍占用目录')
    service.updateProjectInfo.mockRejectedValue(error)
    await expect(invoke('projects:updateInfo', target, { projectId: 'book-a', name: '新书名' })).rejects.toBe(error)
    expect(instances[0].starts).toEqual([['book-a', 'old'], ['book-a', 'old']])
  })

  it('改名之前尚未完成的路径查询，不能在改名后重新监听旧路径', async () => {
    const target = sender(1), pendingPath = deferred<string>()
    service.resolveDir.mockReturnValueOnce(pendingPath.promise)
    const watch = invoke('projects:watch', target, 'book-a')
    service.updateProjectInfo.mockImplementation(async () => { path = 'new'; return { name: '新书名' } })
    await invoke('projects:updateInfo', target, { projectId: 'book-a', name: '新书名' })
    pendingPath.resolve('old'); await watch
    expect(instances[0].starts).toEqual([['book-a', 'new']])
  })

  it('同一作品连续保存按顺序执行，监听不会在另一次保存期间提前恢复', async () => {
    const target = sender(1), firstSave = deferred<{ name: string }>()
    await invoke('projects:watch', target, 'book-a')
    service.updateProjectInfo.mockReturnValueOnce(firstSave.promise).mockImplementationOnce(async () => {
      expect(instances[0].projectId).toBeNull()
      path = 'final'; return { name: '最终书名' }
    })
    const first = invoke('projects:updateInfo', target, { projectId: 'book-a', name: '新书名' })
    const second = invoke('projects:updateInfo', target, { projectId: 'book-a', name: '最终书名' })
    await vi.waitFor(() => expect(service.updateProjectInfo).toHaveBeenCalledOnce())
    path = 'intermediate'; firstSave.resolve({ name: '新书名' })
    await Promise.all([first, second])
    expect(instances[0].starts.at(-1)).toEqual(['book-a', 'final'])
  })
})
