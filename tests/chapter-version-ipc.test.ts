import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { SettingsRepository } from '../src/main/data/settings-repository'
import type { ChapterVersion } from '../src/shared/types'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null }
}))

const { LibraryRepository } = await import('../src/main/data/library-repository')
const { ProjectService } = await import('../src/main/data/project-service')
const { ChapterService } = await import('../src/main/data/chapter-service')
const { registerChaptersIpc } = await import('../src/main/ipc/chapters')

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

describe('Chapter Versions IPC & Rollback', () => {
  let projectId: string
  let projectService: InstanceType<typeof ProjectService>
  let chapterService: InstanceType<typeof ChapterService>

  beforeEach(async () => {
    handlers.clear()
    const root = await mkdtemp(path.join(tmpdir(), 'aw-chap-ver-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    projectService = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    chapterService = new ChapterService(projectService)
    projectId = (await projectService.create({ name: '版本测试项目', genre: '玄幻' })).id
    registerChaptersIpc(projectService, chapterService)
  })

  it('auto-seeds initial version when prose exists but no versions yet', async () => {
    // 写入正文
    await chapterService.updateContent(projectId, 1, '第一章 初始正文内容')
    const listFn = handlers.get('chapters:listVersions')!
    const versions = (await listFn(null, projectId, 1)) as ChapterVersion[]

    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(versions[0].content).toBe('第一章 初始正文内容')
  })

  it('keeps at most 5 versions and sorts in reverse order (倒序)', async () => {
    const createFn = handlers.get('chapters:createVersion')!
    const listFn = handlers.get('chapters:listVersions')!

    for (let i = 1; i <= 6; i++) {
      await createFn(null, projectId, 1, {
        source: 'manual',
        content: `正文修改 第${i}次`,
        note: `第${i}次提交`
      })
    }

    const versions = (await listFn(null, projectId, 1)) as ChapterVersion[]
    expect(versions).toHaveLength(5)
    // 倒序排列：最新在最前
    expect(versions.map((v) => v.versionNumber)).toEqual([6, 5, 4, 3, 2])
    expect(versions[0].content).toBe('正文修改 第6次')
  })

  it('rolls back to an earlier version and updates chapter content', async () => {
    const createFn = handlers.get('chapters:createVersion')!
    const rollbackFn = handlers.get('chapters:rollback')!

    await createFn(null, projectId, 1, {
      source: 'manual',
      content: '黄金版本正文',
      note: '满意版本'
    })
    await createFn(null, projectId, 1, {
      source: 'ai',
      content: '劣质AI续写正文，需要回滚',
      note: '尝试续写'
    })

    // 回滚到版本 1
    await rollbackFn(null, projectId, 1, 1)

    // 读取当前章节正文，应已被恢复为版本 1
    const current = await chapterService.getChapter(projectId, 1)
    expect(current.content).toBe('黄金版本正文')
  })

  it('deletes a version correctly', async () => {
    const createFn = handlers.get('chapters:createVersion')!
    const deleteFn = handlers.get('chapters:deleteVersion')!
    const listFn = handlers.get('chapters:listVersions')!

    await createFn(null, projectId, 1, { source: 'manual', content: '版本A' })
    await createFn(null, projectId, 1, { source: 'manual', content: '版本B' })

    await deleteFn(null, projectId, 1, 1)

    const list = (await listFn(null, projectId, 1)) as ChapterVersion[]
    expect(list.map((v) => v.versionNumber)).toEqual([2])
  })
})
