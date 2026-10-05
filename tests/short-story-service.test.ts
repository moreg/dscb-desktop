import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortStoryService } from '../src/main/data/short-story-service'
import type { ShortStoryCreateInput, ShortStoryDocument } from '../src/shared/short-story'

const input: ShortStoryCreateInput = {
  title: '  归途  ', kind: 'short', genre: '悬疑', brief: '失踪者回家',
  requirements: '收束所有伏笔', targetWords: 8000, sectionCount: 4
}

describe('ShortStoryService', () => {
  let root: string
  let service: ShortStoryService

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'aw-short-story-'))
    service = new ShortStoryService(join(root, 'stories'))
  })

  async function snapshot(story: ShortStoryDocument): Promise<string> {
    const directory = await service.getDirectory(story.id)
    const pointer = JSON.parse(await fs.readFile(join(directory, 'current.json'), 'utf-8')) as { snapshotId: string }
    return join(directory, 'revisions', pointer.snapshotId)
  }

  it('creates a separate story, saves Markdown, lists progress and exports the full text', async () => {
    expect(await service.list()).toEqual([])
    const initial = await service.create(input)
    expect(initial.title).toBe('归途')
    expect(initial.sections.map(section => section.number)).toEqual([1, 2, 3, 4])
    expect(await service.get(initial.id)).toEqual(initial)

    initial.outline = '# 大纲\n\n最后揭开谜底。'
    initial.sections[0] = { number: 1, title: '敲门', content: '门外有人。\n\n她没有开门。' }
    const saved = await service.save(initial)
    expect(saved.revision).toBe(2)
    expect(await service.get(initial.id)).toEqual(saved)
    expect(await service.list()).toEqual([expect.objectContaining({
      title: '归途', sectionCount: 4, completedSections: 1, writtenWords: 11
    })])
    expect(await service.export(initial.id)).toContain('## 第 1 节：敲门\n\n门外有人。\n\n她没有开门。')

    const directory = await snapshot(saved)
    const metadata = await fs.readFile(join(directory, 'metadata.json'), 'utf-8')
    expect(metadata).not.toContain('门外有人')
    expect(metadata).not.toContain('最后揭开谜底')
    expect(await fs.readFile(join(directory, '大纲.md'), 'utf-8')).toBe(saved.outline)
    expect(await fs.readFile(join(directory, '正文', '01.md'), 'utf-8')).toBe(saved.sections[0].content)

    // Markdown 文件本身就是正文真源，读取不依赖 JSON 内的正文副本。
    await fs.writeFile(join(directory, '正文', '01.md'), '她终于打开门。', 'utf-8')
    expect((await service.get(saved.id)).sections[0].content).toBe('她终于打开门。')
  })

  it('keeps review-only saves and invalidates reviews when configuration, outline or prose changes', async () => {
    let story = await service.create(input)
    story.review = '# 审核\n结构完整。'
    story = await service.save(story)
    expect((await service.get(story.id)).review).toBe('# 审核\n结构完整。')

    const edits: ((document: ShortStoryDocument) => void)[] = [
      document => { document.genre = '现实' },
      document => { document.outline = '新的结局' },
      document => { document.sections[0].title = '归来' },
      document => { document.sections[0].content = '他回来了。' }
    ]
    for (const edit of edits) {
      edit(story)
      story = await service.save(story)
      expect(story.review).toBe('')
      story.review = '重新审核通过'
      story = await service.save(story)
      expect(story.review).toBe('重新审核通过')
    }
    const reviewedSnapshot = await snapshot(story)
    await fs.writeFile(join(reviewedSnapshot, '大纲.md'), '在文件夹中手动修改后的大纲', 'utf-8')
    expect((await service.get(story.id)).review).toBe('')
  })

  it('rejects stale revisions and serializes concurrent saves across service instances', async () => {
    const initial = await service.create(input)
    const otherService = new ShortStoryService(join(root, 'stories'))
    const first = structuredClone(initial)
    first.outline = '第一版'
    first.sections[0].content = '第一份正文'
    const second = structuredClone(initial)
    second.outline = '第二版'
    second.sections[0].content = '第二份正文'

    const results = await Promise.allSettled([service.save(first), otherService.save(second)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(String(rejection.reason)).toContain('SHORT_STORY_REVISION_CONFLICT')
    const current = await service.get(initial.id)
    expect(current.revision).toBe(2)
    expect(current.outline).toBe('第一版')
    expect(current.sections[0].content).toBe('第一份正文')
    await expect(service.save(initial)).rejects.toThrow('SHORT_STORY_REVISION_CONFLICT')
  })

  it('protects external Markdown changes from an old window and allows saving after reloading', async () => {
    let story = await service.create(input)
    story.sections[0].content = '窗口中的初稿'
    story.review = '已检查'
    story = await service.save(story)
    const oldWindow = structuredClone(story)
    const directory = await snapshot(story)
    await fs.writeFile(join(directory, '正文', '01.md'), '在外部编辑器中修改的正文', 'utf-8')
    oldWindow.title = '窗口只修改作品名'
    await expect(service.save(oldWindow)).rejects.toThrow('SHORT_STORY_SOURCE_CONFLICT')
    const reloaded = await service.get(story.id)
    expect(reloaded.revision).toBe(oldWindow.revision)
    expect(reloaded.sourceFingerprint).not.toBe(oldWindow.sourceFingerprint)
    expect(reloaded.sections[0].content).toBe('在外部编辑器中修改的正文')
    reloaded.title = '重新载入后修改作品名'
    const saved = await service.save(reloaded)
    expect(saved.sections[0].content).toBe('在外部编辑器中修改的正文')
    expect(await service.get(saved.id)).toEqual(saved)
  })

  it('retains all committed snapshots and leaves the last commit readable if pointer update fails', async () => {
    let story = await service.create(input)
    story.sections[0].content = '初稿'
    story = await service.save(story)
    const priorSnapshot = await snapshot(story)
    story.sections[0].content = '修订稿'
    story = await service.save(story)
    expect(await fs.readFile(join(priorSnapshot, '正文', '01.md'), 'utf-8')).toBe('初稿')
    const directory = await service.getDirectory(story.id)
    expect(await fs.readdir(join(directory, 'revisions'))).toHaveLength(3)

    const interrupted = structuredClone(story)
    interrupted.outline = '提交未完成的大纲'
    interrupted.sections[0].content = '提交未完成的正文'
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟提交中断'))
    try {
      await expect(service.save(interrupted)).rejects.toThrow('模拟提交中断')
    } finally {
      rename.mockRestore()
    }
    expect(await service.get(story.id)).toEqual(story)
  })

  it('blocks removal of sections containing drafts and requires a continuous complete section array', async () => {
    let story = await service.create(input)
    story.sections[3].content = '结尾已经写好，不能丢失。'
    story = await service.save(story)
    const fewer = { ...story, sectionCount: 3, sections: story.sections.slice(0, 3) }
    await expect(service.save(fewer)).rejects.toThrow('SHORT_STORY_MANUSCRIPT_PROTECTED')
    expect((await service.get(story.id)).sections[3].content).toBe('结尾已经写好，不能丢失。')
    await expect(service.save({ ...story, sections: story.sections.slice(1) })).rejects.toThrow('分节数与正文节数必须一致')
    const reordered = structuredClone(story)
    reordered.sections[0].number = 2
    await expect(service.save(reordered)).rejects.toThrow('节序号必须连续')

    const empty = await service.create(input)
    const smaller = await service.save({ ...empty, sectionCount: 2, sections: empty.sections.slice(0, 2) })
    expect(smaller.sections).toHaveLength(2)
    expect((await service.get(empty.id)).sectionCount).toBe(2)
  })

  it('rejects unsafe IDs and pointer paths without reading outside the story directory', async () => {
    for (const id of ['../outside', '..\\outside', resolve(root), 'not-a-uuid', `${randomUUID()}/../outside`]) {
      await expect(service.get(id)).rejects.toThrow('SHORT_STORY_INVALID_ID')
      await expect(service.export(id)).rejects.toThrow('SHORT_STORY_INVALID_ID')
      await expect(service.getDirectory(id)).rejects.toThrow('SHORT_STORY_INVALID_ID')
    }
    const story = await service.create(input)
    const directory = await service.getDirectory(story.id)
    await fs.writeFile(join(directory, 'current.json'), JSON.stringify({ schemaVersion: 1, revision: 1, snapshotId: '../../../outside' }))
    await expect(service.get(story.id)).rejects.toThrow('SHORT_STORY_CORRUPT')
  })

  it('keeps corrupt stories visible, lists healthy stories and allows opening a corrupt story directory', async () => {
    await expect(service.get(randomUUID())).rejects.toThrow('SHORT_STORY_NOT_FOUND')
    const story = await service.create(input)
    const healthy = await service.create({ ...input, title: '健康作品' })
    const directory = await snapshot(story)
    await fs.writeFile(join(directory, 'metadata.json'), '{ broken', 'utf-8')
    await expect(service.get(story.id)).rejects.toThrow('SHORT_STORY_CORRUPT')
    const summaries = await service.list()
    expect(summaries).toHaveLength(2)
    expect(summaries.find(item => item.id === healthy.id)).toEqual(expect.objectContaining({ title: '健康作品' }))
    expect(summaries.find(item => item.id === story.id)).toEqual(expect.objectContaining({
      title: '作品文件待检查', sectionCount: 0, loadError: expect.stringContaining('SHORT_STORY_CORRUPT')
    }))
    expect(await service.getDirectory(story.id)).toBe(join(root, 'stories', story.id))
  })

  it('keeps failed creations outside the list and can create healthy stories afterward', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟创建提交中断'))
    try {
      await expect(service.create(input)).rejects.toThrow('模拟创建提交中断')
    } finally {
      rename.mockRestore()
    }
    expect(await service.list()).toEqual([])
    const entries = await fs.readdir(join(root, 'stories'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^\.creating-/)
    const story = await service.create(input)
    expect(await service.list()).toEqual([expect.objectContaining({ id: story.id })])
  })

  it('rejects invalid configurations and malformed saved metadata', async () => {
    await expect(service.create({ ...input, title: ' ' })).rejects.toThrow('请填写作品名')
    await expect(service.create({ ...input, targetWords: 100000, sectionCount: 1 })).rejects.toThrow('每节预算最多 6000 字')
    await expect(service.create({ ...input, kind: 'long' } as unknown as ShortStoryCreateInput)).rejects.toThrow('作品配置无效')
    await expect(service.create({ ...input, title: '名'.repeat(121) })).rejects.toThrow('SHORT_STORY_INVALID')
    const story = await service.create(input)
    const directory = await snapshot(story)
    const metadataFile = join(directory, 'metadata.json')
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf-8')) as Record<string, unknown>
    metadata.sectionCount = 3
    await fs.writeFile(metadataFile, JSON.stringify(metadata), 'utf-8')
    await expect(service.get(story.id)).rejects.toThrow('SHORT_STORY_CORRUPT')
  })
})
