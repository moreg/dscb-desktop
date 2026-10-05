import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortStoryService } from '../src/main/data/short-story-service'
import { ShortStoryStorage } from '../src/main/data/short-story-storage'
import type { ShortStoryCreateInput, ShortStoryDocument } from '../src/shared/short-story'

const input: ShortStoryCreateInput = {
  title: '迁移测试', kind: 'short', genre: '悬疑', brief: '一封旧信',
  requirements: '完整结局', targetWords: 8000, sectionCount: 4
}

describe('ShortStoryStorage', () => {
  let root: string
  let source: string
  let destination: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'aw-short-story-storage-'))
    source = join(root, 'old-location')
    destination = join(root, 'new-location')
  })

  async function writtenStory(service: ShortStoryService | ShortStoryStorage, title = input.title): Promise<ShortStoryDocument> {
    let story = await service.create({ ...input, title })
    story.outline = '# 大纲\n最终解决冲突。'
    story.sections[0].content = '第一节的正文。'
    story = await service.save(story)
    story.review = '检查通过。'
    return service.save(story)
  }

  async function copyStory(story: ShortStoryDocument): Promise<string> {
    const directory = join(destination, story.id)
    await fs.mkdir(destination, { recursive: true })
    await fs.cp(join(source, story.id), directory, { recursive: true, errorOnExist: true, force: false })
    return directory
  }

  it('copies complete histories, preserves the original files and reopens the merged library after restart', async () => {
    const settings = join(root, 'storage-setting.txt')
    const manager = new ShortStoryStorage(source, path => fs.writeFile(settings, path, 'utf-8'))
    const story = await writtenStory(manager)
    const other = await new ShortStoryService(destination).create({ ...input, title: '目标已有作品' })
    const oldRevisions = await fs.readdir(join(source, story.id, 'revisions'))
    const result = await manager.setLocation(destination)
    expect(result).toEqual({ path: destination, copiedCount: 1 })
    expect(await fs.readdir(join(destination, story.id, 'revisions'))).toEqual(oldRevisions)
    expect(oldRevisions).toHaveLength(3)
    expect(await new ShortStoryService(source).get(story.id)).toEqual(story)
    const restarted = new ShortStoryStorage(await fs.readFile(settings, 'utf-8'), async () => undefined)
    expect(await restarted.get(story.id)).toEqual(story)
    expect((await restarted.list()).map(item => item.id).sort()).toEqual([story.id, other.id].sort())
    expect(await restarted.export(story.id)).toContain('第一节的正文。')
    expect(await restarted.getDirectory(story.id)).toBe(join(destination, story.id))
    expect((await fs.readdir(destination)).some(name => name.startsWith('.migrating-'))).toBe(false)
    expect((await fs.readdir(destination)).some(name => name.startsWith('.write-check-'))).toBe(false)
  })

  it('skips only byte-identical same-ID copies, including their older revisions', async () => {
    const manager = new ShortStoryStorage(source, async () => undefined)
    const story = await writtenStory(manager)
    await copyStory(story)
    expect(await manager.setLocation(destination)).toEqual({ path: destination, copiedCount: 0 })
    expect(await manager.get(story.id)).toEqual(story)
    expect(await manager.setLocation(destination)).toEqual({ path: destination, copiedCount: 0 })
  })

  it('preflights every collision without copying earlier works or overwriting different content', async () => {
    const persist = vi.fn(async () => undefined)
    const manager = new ShortStoryStorage(source, persist)
    const stories = [await writtenStory(manager, '第一部'), await writtenStory(manager, '第二部')].sort((a, b) => a.id.localeCompare(b.id))
    const collision = stories[1]
    const copied = await copyStory(collision)
    const altered = join(copied, '历史之外的备注.md')
    await fs.writeFile(altered, '必须保留的不同目标内容', 'utf-8')
    await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_CONFLICT')
    expect(persist).not.toHaveBeenCalled()
    expect(await manager.getLocation()).toBe(source)
    expect(await fs.readdir(destination)).toEqual([collision.id])
    expect(await fs.readFile(altered, 'utf-8')).toBe('必须保留的不同目标内容')
    expect(await manager.get(stories[0].id)).toEqual(stories[0])
  })

  it('keeps the old root after settings failure and safely reuses copies on retry', async () => {
    let rejected = true
    const manager = new ShortStoryStorage(source, async () => {
      if (rejected) throw new Error('保存设置失败')
    })
    const story = await writtenStory(manager)
    await expect(manager.setLocation(destination)).rejects.toThrow('保存设置失败')
    expect(await manager.getLocation()).toBe(source)
    expect(await manager.getDirectory(story.id)).toBe(join(source, story.id))
    expect(await new ShortStoryService(destination).get(story.id)).toEqual(story)
    rejected = false
    expect(await manager.setLocation(destination)).toEqual({ path: destination, copiedCount: 0 })
    expect(await manager.getLocation()).toBe(destination)
  })

  it('treats a missing source as empty and preserves damaged plain-file works as visible entries', async () => {
    const empty = new ShortStoryStorage(join(root, 'missing'), async () => undefined)
    expect(await empty.setLocation(destination)).toEqual({ path: destination, copiedCount: 0 })
    expect(await empty.list()).toEqual([])
    const manager = new ShortStoryStorage(source, async () => undefined)
    const story = await manager.create(input)
    await fs.writeFile(join(source, story.id, 'current.json'), '{ broken data', 'utf-8')
    await fs.writeFile(join(source, story.id, '手动恢复稿.md'), '不能丢失的独立草稿', 'utf-8')
    expect(await manager.setLocation(destination)).toEqual({ path: destination, copiedCount: 1 })
    expect(await fs.readFile(join(destination, story.id, '手动恢复稿.md'), 'utf-8')).toBe('不能丢失的独立草稿')
    expect((await manager.list()).find(item => item.id === story.id)?.loadError).toContain('SHORT_STORY_CORRUPT')
  })

  it('rejects relative, nested and non-directory locations while keeping the queue usable', async () => {
    const persist = vi.fn(async () => undefined)
    expect(() => new ShortStoryStorage('relative/path', persist)).toThrow('SHORT_STORY_LOCATION_INVALID')
    const manager = new ShortStoryStorage(source, persist)
    await expect(manager.setLocation('relative/path')).rejects.toThrow('SHORT_STORY_LOCATION_INVALID')
    await expect(manager.setLocation(join(source, 'nested'))).rejects.toThrow('SHORT_STORY_LOCATION_NESTED')
    await expect(manager.setLocation(root)).rejects.toThrow('SHORT_STORY_LOCATION_NESTED')
    const file = join(root, 'plain-file')
    await fs.writeFile(file, 'not a directory', 'utf-8')
    await expect(manager.setLocation(file)).rejects.toThrow('SHORT_STORY_LOCATION_UNSAFE')
    expect(persist).not.toHaveBeenCalled()
    expect(await manager.getLocation()).toBe(source)
    expect(await manager.create(input)).toEqual(expect.objectContaining({ title: input.title }))
  })

  it('rejects linked source trees, linked target ancestors and hard-linked files', async () => {
    const manager = new ShortStoryStorage(source, async () => undefined)
    const story = await manager.create(input)
    const outside = join(root, 'outside')
    await fs.mkdir(outside)
    const linked = join(source, story.id, '链接目录')
    await fs.symlink(outside, linked, 'junction')
    await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_UNSAFE')
    expect(await manager.getLocation()).toBe(source)
    await fs.unlink(linked)
    const alias = join(root, 'target-alias')
    await fs.symlink(outside, alias, 'junction')
    await expect(manager.setLocation(join(alias, 'nested-target'))).rejects.toThrow('SHORT_STORY_LOCATION_UNSAFE')
    const original = join(source, story.id, 'current.json')
    await fs.link(original, join(source, story.id, 'linked-file.json'))
    await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_UNSAFE')
    expect(await manager.getLocation()).toBe(source)
  })

  it('returns the configured path even if its root is invalid, and rejects migration from a linked root', async () => {
    await fs.mkdir(source)
    const alias = join(root, 'source-alias')
    await fs.symlink(source, alias, 'junction')
    const manager = new ShortStoryStorage(alias, async () => undefined)
    expect(await manager.getLocation()).toBe(resolve(alias))
    await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_UNSAFE')
  })

  it('checks target writability even with no source stories and never persists a rejected location', async () => {
    const persist = vi.fn(async () => undefined)
    const manager = new ShortStoryStorage(source, persist)
    const denied = Object.assign(new Error('目标无写入权限'), { code: 'EACCES' })
    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(denied)
    try { await expect(manager.setLocation(destination)).rejects.toThrow('目标无写入权限') }
    finally { open.mockRestore() }
    expect(persist).not.toHaveBeenCalled()
    expect(await manager.getLocation()).toBe(source)
  })

  it('serializes migration with queued creates and saves and captures their input at submission', async () => {
    const manager = new ShortStoryStorage(source, async () => undefined)
    const pendingInput = { ...input }
    const creating = manager.create(pendingInput)
    pendingInput.title = '调用后修改不应进入队列'
    const relocating = manager.setLocation(destination)
    const [story, moved] = await Promise.all([creating, relocating])
    expect(story.title).toBe(input.title)
    expect(moved.copiedCount).toBe(1)
    expect(await new ShortStoryService(source).get(story.id)).toEqual(story)
    expect(await manager.getDirectory(story.id)).toBe(join(destination, story.id))

    story.sections[0].content = '排队时捕获的正文'
    const saving = manager.save(story)
    story.sections[0].content = '调用后篡改的对象内容'
    const saved = await saving
    expect(saved.sections[0].content).toBe('排队时捕获的正文')
    expect((await new ShortStoryService(source).get(story.id)).sections[0].content).toBe('')
  })

  it('waits for settings persistence before using the new service for subsequent operations', async () => {
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolveGate => { release = resolveGate })
    const reached = new Promise<void>(resolveGate => { entered = resolveGate })
    const manager = new ShortStoryStorage(source, async () => { entered(); await blocked })
    const switching = manager.setLocation(destination)
    await reached
    let finished = false
    const creating = manager.create(input).then(story => { finished = true; return story })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await switching
    const story = await creating
    expect(await manager.getDirectory(story.id)).toBe(join(destination, story.id))
    await expect(fs.lstat(join(source, story.id))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('detects external manuscript changes during publication and does not switch roots', async () => {
    const persist = vi.fn(async () => undefined)
    const manager = new ShortStoryStorage(source, persist)
    const story = await writtenStory(manager)
    const pointer = JSON.parse(await fs.readFile(join(source, story.id, 'current.json'), 'utf-8')) as { snapshotId: string }
    const sourceProse = join(source, story.id, 'revisions', pointer.snapshotId, '正文', '01.md')
    const originalRename = fs.rename
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (basename(String(from)).startsWith('.migrating-')) await fs.writeFile(sourceProse, '迁移过程中在外部改写的正文', 'utf-8')
      return originalRename(from, to)
    })
    try { await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_CHANGED') }
    finally { rename.mockRestore() }
    expect(persist).not.toHaveBeenCalled()
    expect(await manager.getLocation()).toBe(source)
    expect((await manager.get(story.id)).sections[0].content).toBe('迁移过程中在外部改写的正文')
  })

  it('keeps an incomplete or altered staging copy out of the formal UUID library', async () => {
    const persist = vi.fn(async () => undefined)
    const manager = new ShortStoryStorage(source, persist)
    const story = await writtenStory(manager)
    const originalWrite = fs.writeFile
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      await originalWrite(file, data, options)
      if (String(file).includes('.migrating-') && basename(String(file)) === '01.md') {
        await originalWrite(file, '复制期间暂存稿被修改', 'utf-8')
      }
    })
    try { await expect(manager.setLocation(destination)).rejects.toThrow('SHORT_STORY_LOCATION_CHANGED') }
    finally { write.mockRestore() }
    expect(persist).not.toHaveBeenCalled()
    expect(await manager.getLocation()).toBe(source)
    await expect(fs.lstat(join(destination, story.id))).rejects.toHaveProperty('code', 'ENOENT')
    expect((await fs.readdir(destination)).some(name => name.startsWith('.migrating-'))).toBe(true)
    expect(await new ShortStoryService(destination).list()).toEqual([])
    expect(await manager.get(story.id)).toEqual(story)
  })
})
