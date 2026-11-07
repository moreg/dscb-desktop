import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { recoverProjectFolderLocks } from '../src/main/data/project-folder-locks'
import { ProjectFolderInUseError, renameProjectDirectory } from '../src/main/data/project-directory-rename'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import type { SettingsRepository } from '../src/main/data/settings-repository'

vi.mock('../src/main/data/project-folder-locks', () => ({ recoverProjectFolderLocks: vi.fn() }))
const busy = () => Object.assign(new Error('locked'), { code: 'EPERM' })

describe('保存作品时恢复目录改名', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.mocked(recoverProjectFolderLocks).mockReset() })

  it('正常改名不启动进程检测', async () => {
    const rename = vi.spyOn(fs, 'rename').mockResolvedValue(undefined)
    await renameProjectDirectory('old', 'new')
    expect(rename).toHaveBeenCalledTimes(1)
    expect(recoverProjectFolderLocks).not.toHaveBeenCalled()
  })

  it('暂时占用在短暂重试后解除，不运行清理工具', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busy()).mockResolvedValue(undefined)
    await renameProjectDirectory('old', 'new')
    expect(rename).toHaveBeenCalledTimes(2)
    expect(recoverProjectFolderLocks).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')('持续占用时自动检测释放，并在同一次保存中重试成功', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(busy())
    vi.mocked(recoverProjectFolderLocks).mockImplementation(async () => {
      rename.mockResolvedValue(undefined)
      return { released: [20], remaining: [] }
    })
    await renameProjectDirectory('old', 'new')
    expect(recoverProjectFolderLocks).toHaveBeenCalledWith('old')
    expect(rename).toHaveBeenCalledTimes(5)
  })

  it.skipIf(process.platform !== 'win32')('仍被编辑器使用时给出程序名和 PID，并保留失败原因', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(busy())
    vi.mocked(recoverProjectFolderLocks).mockResolvedValue({ released: [], remaining: [{ pid: 42, name: 'Code.exe' } as never] })
    await expect(renameProjectDirectory('old', 'new')).rejects.toThrow(/Code.exe（PID 42）/)
  })

  it.skipIf(process.platform !== 'win32')('检测工具不可用时继续常规重试，不把检测失败当成保存失败', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(busy())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(recoverProjectFolderLocks).mockImplementation(async () => {
      rename.mockResolvedValue(undefined)
      throw new Error('PowerShell disabled')
    })
    await expect(renameProjectDirectory('old', 'new')).resolves.toBeUndefined()
  })

  it('同名冲突或路径错误不尝试释放其他程序', async () => {
    const conflict = Object.assign(new Error('exists'), { code: 'EEXIST' })
    vi.spyOn(fs, 'rename').mockRejectedValue(conflict)
    await expect(renameProjectDirectory('old', 'new')).rejects.toBe(conflict)
    expect(recoverProjectFolderLocks).not.toHaveBeenCalled()
    expect(conflict).not.toBeInstanceOf(ProjectFolderInUseError)
  })

  it.skipIf(process.platform !== 'win32')('无法释放时不改小说文件或书架路径，原信息可以继续读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-locked-save-'))
    const library = new LibraryRepository(join(root, 'library.json'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const service = new ProjectService(join(root, 'projects'), library, settings)
    const meta = await service.create({ name: '原书名', description: '原简介' })
    const saved = await readFile(join(meta.path, 'project.json'), 'utf8')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(busy())
    vi.mocked(recoverProjectFolderLocks).mockResolvedValue({ released: [], remaining: [] })
    try {
      await expect(service.updateProjectInfo(meta.id, { name: '新书名', description: '新简介' })).rejects.toBeInstanceOf(ProjectFolderInUseError)
      expect(await readFile(join(meta.path, 'project.json'), 'utf8')).toBe(saved)
      expect(await service.resolveDir(meta.id)).toBe(meta.path)
      expect(await service.getProjectData(meta.id)).toMatchObject({ name: '原书名', description: '原简介' })
      expect(await library.list()).toEqual([meta])
    } finally {
      rename.mockRestore()
      // root is the exact directory just created by mkdtemp in the temporary workspace.
      await rm(root, { recursive: true, force: true })
    }
  })
})
