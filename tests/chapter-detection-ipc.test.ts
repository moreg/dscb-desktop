import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRendererApi } from '../src/preload/api'
import type { RendererApi } from '../src/shared/types'
import { currentChapterDetection } from '../src/shared/chapter-detection'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  dialog: {}, BrowserWindow: { fromWebContents: () => null }
}))
const { registerChaptersIpc } = await import('../src/main/ipc/chapters')
const { ProjectService } = await import('../src/main/data/project-service')
const { ChapterService } = await import('../src/main/data/chapter-service')
const { LibraryRepository } = await import('../src/main/data/library-repository')

describe('检测入口经 preload 和共用 IPC 往返', () => {
  let root: string
  let api: RendererApi
  let projectId: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'detection-ipc-'))
    handlers.clear()
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')),
      { getProjectsRoot: async (fallback: string) => fallback } as never)
    projectId = (await projects.create({ name: '检测测试', genre: '悬疑' })).id
    registerChaptersIpc(projects, new ChapterService(projects))
    api = createRendererApi({ invoke: (channel, ...args) => handlers.get(channel)!(null, ...args),
      on() {}, removeListener() {} })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('保存、捕获、登记、重读与改稿失效贯通，捕获前拒绝未保存版本', async () => {
    const text = '“钱已付了。”她翻开收条。\n\n签收人为什么换了名字？'
    await api.updateChapterContent(projectId, 4, text)
    await expect(api.captureChapterDetection(projectId, 4, text + '改')).rejects.toThrow('CHAPTER_REVISION_CONFLICT')
    const record = await api.captureChapterDetection(projectId, 4, text)
    await api.recordChapterDetection(projectId, 4, record.id, { status: 'completed', ai: 0, suspected: 0,
      human: 100, detectedAt: record.createdAt, evidence: '测试用报告摘录。' })
    expect(currentChapterDetection(await api.listChapterDetections(projectId, 4), text)).toBe('本版双零（人工登记）')
    await api.updateChapterContent(projectId, 4, text.replace('。', '！'))
    expect(currentChapterDetection(await api.listChapterDetections(projectId, 4), text)).toBe('正文已变化，需复测')
    expect((await api.listChapterDetections(projectId, 3)).records).toEqual([])
  })

  it('在边界拒绝无效章节、路径和分数', async () => {
    await expect(api.listChapterDetections(projectId, -1)).rejects.toThrow('IPC_INPUT_INVALID')
    await expect(api.recordChapterDetection(projectId, 1, '../bad', { status: 'failed', note: '' })).rejects.toThrow()
    await expect(api.captureChapterDetection('missing-project', 1, '正文')).rejects.toThrow()
  })
})
