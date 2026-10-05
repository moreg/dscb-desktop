import { beforeEach, describe, expect, it } from 'vitest'
import {
  allowBrainstormPageDraftWrite, BRAINSTORM_PAGE_DRAFT_KEY, emptyBrainstormPageDraft,
  readBrainstormPageDraft, writeBrainstormPageDraft,
  type BrainstormPageDraft, type BrainstormPageDraftStorage
} from '../src/renderer/src/brainstorm-page-draft'
import { LONG_STORY_BRAINSTORM_PREFIX } from '../src/renderer/src/long-story-brainstorm-library'
import { SHORT_STORY_BRAINSTORM_PREFIX } from '../src/renderer/src/short-story-brainstorm-library'

function memoryStorage(): BrainstormPageDraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}

const edited: BrainstormPageDraft = { version: 1, genre: '玄幻', targetChapters: '300', sourceBrief: '药师能从废丹中读出过去的记忆。' }

describe('独立脑洞栏目条件草稿', () => {
  beforeEach(() => { allowBrainstormPageDraftWrite() })

  it('没有草稿时返回独立空状态，空草稿无需保留记录', () => {
    const storage = memoryStorage()
    expect(readBrainstormPageDraft(storage)).toEqual({ draft: emptyBrainstormPageDraft(), warning: '', found: false, corrupt: false })
    const empty = emptyBrainstormPageDraft()
    empty.genre = '修改一个返回对象'
    expect(emptyBrainstormPageDraft().genre).toBe('')
    expect(writeBrainstormPageDraft(emptyBrainstormPageDraft(), storage)).toBe(true)
    expect(storage.values.size).toBe(0)
  })

  it('恢复跨页面的题材、章数和来源简介，章数暂存输入不要求已经有效', () => {
    const storage = memoryStorage()
    for (const targetChapters of ['300', '0', '-2', '三百章', '1.', '未定']) {
      const draft = { ...edited, targetChapters, sourceBrief: '原文保留换行\n与 "引号"。' }
      expect(writeBrainstormPageDraft(draft, storage)).toBe(true)
      expect(readBrainstormPageDraft(storage)).toEqual({ draft, warning: '', found: true, corrupt: false })
    }
  })

  it('完全损坏的记录不能被自动挂载覆盖，明确编辑后才允许保存', () => {
    const storage = memoryStorage()
    for (const raw of ['{损坏', '', 'null', '[]', '{"version":2,"genre":"未来版本"}']) {
      storage.setItem(BRAINSTORM_PAGE_DRAFT_KEY, raw)
      const read = readBrainstormPageDraft(storage)
      expect(read).toMatchObject({ draft: emptyBrainstormPageDraft(), found: true, corrupt: true })
      expect(read.warning).toContain('原记录保留')
      expect(writeBrainstormPageDraft(read.draft, storage)).toBe(false)
      expect(writeBrainstormPageDraft(edited, storage)).toBe(false)
      expect(storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)).toBe(raw)
      allowBrainstormPageDraftWrite()
      expect(writeBrainstormPageDraft(edited, storage)).toBe(true)
      expect(readBrainstormPageDraft(storage).draft).toEqual(edited)
    }
  })

  it('部分损坏恢复有效字段，并保护缺失、错误类型或超长的原记录', () => {
    const storage = memoryStorage()
    const raw = JSON.stringify({ version: 1, genre: '都市', targetChapters: 300, sourceBrief: '设'.repeat(5001) })
    storage.setItem(BRAINSTORM_PAGE_DRAFT_KEY, raw)
    const read = readBrainstormPageDraft(storage)
    expect(read.draft).toEqual({ version: 1, genre: '都市', targetChapters: '', sourceBrief: '设'.repeat(5000) })
    expect(read.corrupt).toBe(true)
    expect(read.warning).toContain('原记录暂不覆盖')
    expect(writeBrainstormPageDraft(read.draft, storage)).toBe(false)
    expect(storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)).toBe(raw)
    allowBrainstormPageDraftWrite()
    expect(writeBrainstormPageDraft({ ...read.draft, targetChapters: '400' }, storage)).toBe(true)
  })

  it('允许字段上限，拒绝超限或不完整草稿且不改动既有记录', () => {
    const storage = memoryStorage()
    const maximum: BrainstormPageDraft = { version: 1, genre: '题'.repeat(100), targetChapters: '章'.repeat(32), sourceBrief: '设'.repeat(5000) }
    expect(writeBrainstormPageDraft(maximum, storage)).toBe(true)
    expect(readBrainstormPageDraft(storage).draft).toEqual(maximum)
    const raw = storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)
    for (const invalid of [
      { ...maximum, genre: '题'.repeat(101) }, { ...maximum, targetChapters: '章'.repeat(33) },
      { ...maximum, sourceBrief: '设'.repeat(5001) }, { ...maximum, version: 2 },
      { ...maximum, genre: 42 }, { version: 1, genre: '都市' }
    ]) {
      expect(writeBrainstormPageDraft(invalid as BrainstormPageDraft, storage)).toBe(false)
      expect(storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)).toBe(raw)
    }
  })

  it('无法读取时阻止自动覆盖，写入或清理失败也不丢掉已有记录', () => {
    const storage = memoryStorage()
    writeBrainstormPageDraft(edited, storage)
    const raw = storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)
    const cannotRead: BrainstormPageDraftStorage = { ...storage, getItem: () => { throw new Error('读取被拒绝') } }
    expect(readBrainstormPageDraft(cannotRead)).toMatchObject({ found: false, corrupt: true, warning: expect.stringContaining('无法访问') })
    expect(writeBrainstormPageDraft(emptyBrainstormPageDraft(), storage)).toBe(false)
    allowBrainstormPageDraftWrite()
    const cannotWrite: BrainstormPageDraftStorage = { ...storage, setItem: () => { throw new Error('空间已满') } }
    expect(writeBrainstormPageDraft({ ...edited, genre: '悬疑' }, cannotWrite)).toBe(false)
    const cannotRemove: BrainstormPageDraftStorage = { ...storage, removeItem: () => { throw new Error('清理被拒绝') } }
    expect(writeBrainstormPageDraft(emptyBrainstormPageDraft(), cannotRemove)).toBe(false)
    expect(storage.getItem(BRAINSTORM_PAGE_DRAFT_KEY)).toBe(raw)
  })

  it('没有浏览器存储时返回可显示的警告，保存失败不抛出异常', () => {
    expect(readBrainstormPageDraft()).toMatchObject({ found: false, corrupt: true, warning: expect.stringContaining('无法访问') })
    allowBrainstormPageDraftWrite()
    expect(writeBrainstormPageDraft(edited)).toBe(false)
  })

  it('条件读写及清空不修改长篇或短篇的候选收藏库', () => {
    const storage = memoryStorage()
    const longKey = LONG_STORY_BRAINSTORM_PREFIX + 'new'
    const shortKey = SHORT_STORY_BRAINSTORM_PREFIX + 'new'
    storage.setItem(longKey, '长篇候选与收藏原记录')
    storage.setItem(shortKey, '短篇候选与收藏原记录')
    expect(writeBrainstormPageDraft(edited, storage)).toBe(true)
    expect(readBrainstormPageDraft(storage).draft).toEqual(edited)
    expect(writeBrainstormPageDraft(emptyBrainstormPageDraft(), storage)).toBe(true)
    expect(storage.getItem(longKey)).toBe('长篇候选与收藏原记录')
    expect(storage.getItem(shortKey)).toBe('短篇候选与收藏原记录')
    expect(BRAINSTORM_PAGE_DRAFT_KEY.startsWith(LONG_STORY_BRAINSTORM_PREFIX)).toBe(false)
    expect(BRAINSTORM_PAGE_DRAFT_KEY.startsWith(SHORT_STORY_BRAINSTORM_PREFIX)).toBe(false)
  })
})
