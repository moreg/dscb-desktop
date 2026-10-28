import { createWritingProject } from './helpers/writing-project'
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { setChapterStatus } from '../src/main/data/chapter-status-store'
import { markLongformPending, clearLongformPending } from '../src/main/data/longform-review-state'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = { getProjectsRoot: async (fallback: string) => fallback } as unknown as SettingsRepository

/**
 * 章节状态按正文内容推导：空文件仍待写；草稿与旧润色标注合并成正文。
 * 定稿标注仍绑定正文哈希与长篇核对状态。
 */
describe('chapter status', () => {
  let root: string
  let projectId: string
  let ps: ProjectService
  let cs: ChapterService
  let dir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-status-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await createWritingProject(ps, { name: '状态测试', genre: '玄幻' })).id
    dir = await ps.resolveDir(projectId)
    cs = new ChapterService(ps)
    await mkdir(path.join(dir, '图解'), { recursive: true })
    await writeFile(
      path.join(dir, '图解', '节奏图谱.html'),
      `<script>\nconst rhythmData = [\n  { chapter: 1, title: '一章', emotion: 3, climax: 1, volume: 1, actualized: false }\n];\n</script>`,
      'utf-8'
    )
  })

  it('merges legacy reviewed marks into正文 in both detail and list', async () => {
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('outline')
    const prose = '第一章正文。\n\n他推门而入。'
    await new ProseRepo(dir).write(1, prose, '一章')
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')

    await setChapterStatus(dir, 1, 'reviewed', hashProse(prose))
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')
    expect(await cs.listChapters(projectId).then((list) => list.find((c) => c.chapterNumber === 1)?.status))
      .toBe('draft')
  })

  it('demotes to draft when prose changes after the mark', async () => {
    const prose = '第一章正文。'
    await new ProseRepo(dir).write(1, prose, '一章')
    await setChapterStatus(dir, 1, 'published', hashProse(prose))
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('published')

    await new ProseRepo(dir).write(1, '第一章正文，改过了。', '一章')
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')
  })

  it('demotes to draft while the chapter is quarantined by the longform review', async () => {
    const prose = '第一章正文。'
    await new ProseRepo(dir).write(1, prose, '一章')
    await setChapterStatus(dir, 1, 'reviewed', hashProse(prose))

    const token = await markLongformPending(dir, 1, hashProse(prose))
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')
    await clearLongformPending(dir, 1, token)
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')
  })

  it('updateMeta persists manual status and draft clears the mark', async () => {
    const prose = '第一章正文。'
    await new ProseRepo(dir).write(1, prose, '一章')
    expect((await cs.updateMeta(projectId, 1, { status: 'published' })).status).toBe('published')

    await cs.updateMeta(projectId, 1, { status: 'draft' })
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('draft')
  })
  it.each(['', ' \n\t\r\n', '\uFEFF　\n'])('keeps an existing blank file pending even with a saved status (%j)', async (content) => {
    const repo = new ProseRepo(dir)
    await repo.write(1, content, '一章')
    await setChapterStatus(dir, 1, 'published', hashProse(content))
    expect((await repo.readMany([1])).get(1)?.exists).toBe(true)
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('outline')
    expect((await cs.listChapters(projectId)).find(c => c.chapterNumber === 1)?.status).toBe('outline')
  })

  it('updates both views immediately when a正文 file is emptied outside the app', async () => {
    const prose = '真正的章节正文。'
    await new ProseRepo(dir).write(1, prose, '一章')
    await setChapterStatus(dir, 1, 'published', hashProse(prose))
    expect((await cs.listChapters(projectId))[0].status).toBe('published')
    await writeFile(path.join(dir, '正文', '第001章 一章.md'), '')
    expect((await cs.listChapters(projectId))[0].status).toBe('outline')
    expect((await cs.getChapter(projectId, 1)).meta.status).toBe('outline')
  })

})
