import { describe, expect, it } from 'vitest'
import {
  SHORT_STORY_CREATE_DRAFT_PREFIX,
  adoptShortStoryCreateIdea,
  clearShortStoryCreateDraft,
  completeShortStoryCreateDraft,
  editShortStoryCreateDraft,
  newShortStoryCreateDraft,
  readLatestShortStoryCreateDraft,
  readShortStoryCreateDraft,
  shortStoryCreateDraftText,
  validShortStoryCreateDraft,
  writeShortStoryCreateDraft,
  type DraftStorage
} from '../src/renderer/src/short-story-create-draft'
import type { ShortStoryIdea } from '../src/shared/short-story'

function memoryStorage(): DraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) }
  }
}

const idea: ShortStoryIdea = { title: '门外来信', premise: '主角收到旧信', hook: '信从门缝出现', twist: '收信人是自己', ending: '他烧掉最后一封信' }

describe('short-story create drafts', () => {
  it('restores incomplete inputs including empty title and temporarily cleared numbers', () => {
    const storage = memoryStorage()
    const draft = editShortStoryCreateDraft(newShortStoryCreateDraft('short'), {
      genre: '悬疑', brief: '还没有写完的梗概', requirements: '第三人称', targetWords: 0, sectionCount: 0
    })
    expect(writeShortStoryCreateDraft(draft, storage).ok).toBe(true)
    expect(readShortStoryCreateDraft('short', storage).draft).toEqual(draft)
    expect(readShortStoryCreateDraft('medium', storage).draft).toBeNull()
  })

  it('keeps short and medium drafts separate and resumes the most recently edited form', () => {
    const storage = memoryStorage()
    const short = newShortStoryCreateDraft('short', 100)
    short.input.brief = '短篇梗概'
    const medium = newShortStoryCreateDraft('medium', 200)
    medium.input.title = '中篇作品'
    expect(writeShortStoryCreateDraft(short, storage).ok).toBe(true)
    expect(writeShortStoryCreateDraft(medium, storage).ok).toBe(true)
    expect(readLatestShortStoryCreateDraft(storage).draft).toEqual(medium)
    expect(readShortStoryCreateDraft('short', storage).draft?.input.brief).toBe('短篇梗概')
    short.savedAt = 300
    writeShortStoryCreateDraft(short, storage)
    expect(readLatestShortStoryCreateDraft(storage).draft?.input.kind).toBe('short')
    clearShortStoryCreateDraft('short', storage)
    expect(readLatestShortStoryCreateDraft(storage).draft).toEqual(medium)
  })

  it('restores the automatic title marker and preserves a title manually edited by the author', () => {
    const storage = memoryStorage()
    const adopted = adoptShortStoryCreateIdea(newShortStoryCreateDraft('short'), idea, '采用的梗概')
    writeShortStoryCreateDraft(adopted, storage)
    const restored = readShortStoryCreateDraft('short', storage).draft!
    expect(restored.autoTitle).toBe(idea.title)
    const replacement = adoptShortStoryCreateIdea(restored, { ...idea, title: '第二个脑洞' }, '第二份梗概')
    expect(replacement.input.title).toBe('第二个脑洞')
    const manual = editShortStoryCreateDraft(replacement, { title: '作者自定书名' })
    writeShortStoryCreateDraft(manual, storage)
    const final = adoptShortStoryCreateIdea(readShortStoryCreateDraft('short', storage).draft!, idea, '更新梗概')
    expect(final.input.title).toBe('作者自定书名')
    expect(final.autoTitle).toBe('')
    expect(final.input.brief).toBe('更新梗概')
  })

  it('rejects malformed and out-of-range cache fields with a warning without silently deleting them', () => {
    const storage = memoryStorage()
    const key = SHORT_STORY_CREATE_DRAFT_PREFIX + 'short'
    storage.values.set(key, '{ broken')
    expect(readShortStoryCreateDraft('short', storage).warning).toContain('无法恢复')
    expect(storage.values.get(key)).toBe('{ broken')
    const draft = newShortStoryCreateDraft('short')
    for (const changes of [
      { title: '名'.repeat(121) }, { genre: '题'.repeat(201) }, { brief: '梗'.repeat(10001) },
      { requirements: '要'.repeat(10001) }, { targetWords: -1 }, { targetWords: 120001 },
      { targetWords: 1.5 }, { targetWords: NaN }, { sectionCount: 61 }, { sectionCount: -1 }
    ]) {
      const changed = editShortStoryCreateDraft(draft, changes)
      expect(validShortStoryCreateDraft(changed, 'short')).toBe(false)
      expect(writeShortStoryCreateDraft(changed, storage).ok).toBe(false)
    }
    expect(validShortStoryCreateDraft(draft, 'medium')).toBe(false)
  })

  it('keeps a draft if discard fails and checks that removal actually succeeded', () => {
    const storage = memoryStorage()
    const draft = newShortStoryCreateDraft('short')
    draft.input.title = '必须保留'
    writeShortStoryCreateDraft(draft, storage)
    storage.removeItem = () => { throw new Error('删除被拒绝') }
    expect(clearShortStoryCreateDraft('short', storage)).toEqual(expect.objectContaining({ ok: false, warning: expect.stringContaining('仍保留') }))
    expect(readShortStoryCreateDraft('short', storage).draft?.input.title).toBe('必须保留')
    storage.removeItem = () => undefined
    expect(clearShortStoryCreateDraft('short', storage).ok).toBe(false)
  })

  it('marks a successfully created draft as completed if cleanup fails, including after remount', () => {
    const storage = memoryStorage()
    writeShortStoryCreateDraft(newShortStoryCreateDraft('short'), storage)
    writeShortStoryCreateDraft(newShortStoryCreateDraft('medium'), storage)
    storage.removeItem = () => { throw new Error('无法删除') }
    const completed = completeShortStoryCreateDraft('short', 'created-story-id', storage)
    expect(completed.ok).toBe(false)
    expect(completed.warning).toContain('作品已创建')
    expect(readShortStoryCreateDraft('short', storage).draft).toBeNull()
    const remountedStorage = { ...storage }
    expect(readShortStoryCreateDraft('short', remountedStorage).draft).toBeNull()
    expect(readShortStoryCreateDraft('medium', storage).draft?.input.kind).toBe('medium')
  })

  it('suppresses completed forms during the current run even when marker and cleanup writes both fail', () => {
    const storage = memoryStorage()
    writeShortStoryCreateDraft(newShortStoryCreateDraft('short'), storage)
    const originalSet = storage.setItem
    storage.setItem = () => { throw new Error('写入被拒绝') }
    storage.removeItem = () => { throw new Error('删除被拒绝') }
    expect(completeShortStoryCreateDraft('short', 'created-story-id', storage).ok).toBe(false)
    expect(readLatestShortStoryCreateDraft(storage).draft).toBeNull()
    storage.setItem = originalSet
    const fresh = editShortStoryCreateDraft(newShortStoryCreateDraft('short'), { title: '另一部新作品' })
    expect(writeShortStoryCreateDraft(fresh, storage).ok).toBe(true)
    expect(readShortStoryCreateDraft('short', storage).draft?.input.title).toBe('另一部新作品')
  })

  it('clears only the submitted kind after creation and supplies copyable text when storage is unavailable', () => {
    const storage = memoryStorage()
    const short = editShortStoryCreateDraft(newShortStoryCreateDraft('short'), { title: '短篇书名', brief: '作者梗概' })
    writeShortStoryCreateDraft(short, storage)
    writeShortStoryCreateDraft(newShortStoryCreateDraft('medium'), storage)
    expect(completeShortStoryCreateDraft('short', 'created-story-id', storage).ok).toBe(true)
    expect(storage.getItem(SHORT_STORY_CREATE_DRAFT_PREFIX + 'short')).toBeNull()
    expect(readLatestShortStoryCreateDraft(storage).draft?.input.kind).toBe('medium')
    const unavailable: DraftStorage = {
      getItem: () => { throw new Error('存储不可用') }, setItem: () => { throw new Error('存储不可用') }, removeItem: () => { throw new Error('存储不可用') }
    }
    expect(writeShortStoryCreateDraft(short, unavailable).warning).toContain('请先复制')
    expect(readLatestShortStoryCreateDraft(unavailable).warning).toContain('现有作品仍可正常打开')
    expect(shortStoryCreateDraftText(short)).toContain('短篇书名')
    expect(shortStoryCreateDraftText(short)).toContain('作者梗概')
  })

  it('does not let an old create request clear the newer draft saved by a remounted form', () => {
    const storage = memoryStorage()
    const submitted = newShortStoryCreateDraft('short', 100)
    submitted.input.title = '已提交的作品'
    writeShortStoryCreateDraft(submitted, storage)
    const newer = editShortStoryCreateDraft(submitted, { title: '返回栏目后新改的作品名', brief: '新写的故事内容' })
    writeShortStoryCreateDraft(newer, storage)
    const completed = completeShortStoryCreateDraft('short', 'created-story-id', storage, submitted)
    expect(completed.warning).toContain('已保留新的表单内容')
    expect(completed.preservedNewerDraft).toBe(true)
    expect(readShortStoryCreateDraft('short', storage).draft).toEqual(newer)
    expect(readLatestShortStoryCreateDraft(storage).draft?.input.title).toBe('返回栏目后新改的作品名')
    expect(completeShortStoryCreateDraft('short', 'second-story-id', storage, newer).ok).toBe(true)
    expect(readShortStoryCreateDraft('short', storage).draft).toBeNull()
  })
})
