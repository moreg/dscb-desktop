import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRendererApi } from '../src/preload/api'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const selection = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: selection }
}))
const { registerProseImportIpc } = await import('../src/main/ipc/prose-import')
let root: string | undefined
afterEach(async () => {
  if (root) {
    expect(root.startsWith(join(tmpdir(), 'dscb-import-ipc-'))).toBe(true)
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('prose import preload/IPC integration', () => {
  it('supports multi-file selection, owner-bound preview, cancellation and one-time commit', async () => {
    root = await mkdtemp(join(tmpdir(), 'dscb-import-ipc-'))
    await mkdir(join(root, 'source'))
    const first = join(root, 'source', '第1章.txt'), second = join(root, 'source', '第2章.txt')
    await writeFile(first, '甲。'); await writeFile(second, '乙。')
    selection.mockResolvedValue({ canceled: false, filePaths: [second, first] })
    const service = new ProjectService(join(root, 'books'), new LibraryRepository(join(root, 'library.json')), { getProjectsRoot: async (fallback: string) => fallback } as never)
    registerProseImportIpc(service)
    const apiFor = (id: number) => createRendererApi({
      invoke: (channel, ...args) => handlers.get(channel)!({ sender: { id, isDestroyed: () => false, once: vi.fn() } }, ...args),
      on() {}, removeListener() {}
    })
    const api = apiFor(1), other = apiFor(2)
    const preview = await api.previewProseImport({ mode: 'files', encoding: 'auto' })
    expect(preview?.chapters.map(c => c.number)).toEqual([1, 2])
    expect(selection.mock.calls[0][0].properties).toContain('multiSelections')
    await expect(other.commitProseImport(preview!.token, '越界')).rejects.toThrow('预览已失效')
    const result = await api.commitProseImport(preview!.token, '正文测试')
    expect(result.importedCount).toBe(2)
    await expect(api.commitProseImport(preview!.token, '重复')).rejects.toThrow('预览已失效')
    expect(await readFile(first, 'utf8')).toBe('甲。')
    const next = await api.previewProseImport({ mode: 'folder', folderPath: join(root, 'source'), encoding: 'auto' })
    expect(next?.chapters).toHaveLength(2)
    await api.cancelProseImport()
    await expect(api.commitProseImport(next!.token, '取消')).rejects.toThrow('预览已失效')
    selection.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await api.previewProseImport({ mode: 'files', encoding: 'auto' })).toBeNull()
    await expect(api.previewProseImport({ mode: 'files', encoding: 'invalid' as never })).rejects.toThrow('IPC_INPUT_INVALID')
  })
})
